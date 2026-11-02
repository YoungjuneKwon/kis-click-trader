import { describe, expect, it, vi } from 'vitest';
import { Rejected, TradingEngine } from './engine';
import { defaultRule, type Book, type Broker, type OrderRef, type OrderStatus } from './model';
import { parseBook } from './kis';

const symbol = { code: '005930', name: '삼성전자', base: 72000 };
const book = (price = 72000): Book => ({ symbol: symbol.code, time: Date.now(), last: price, asks: [{ price: price + 100, qty: 50 }], bids: [{ price, qty: 100 }], totalAsk: 50, totalBid: 100 });
class Fake implements Broker {
  kind = 'demo' as const;
  statuses = new Map<string, OrderStatus>();
  n = 0;
  fail = false;
  race = false;
  buy = vi.fn(async (_symbol: string, qty: number) => { if (this.fail) throw new Error('timeout'); this.statuses.set('buy', { filled: qty, average: 72100, remaining: 0, cancelled: false }); return { id: 'buy', branch: '1' }; });
  sell = vi.fn(async (_symbol: string, qty: number, _price: number) => { const id = `sell${++this.n}`; this.statuses.set(id, { filled: 0, average: 0, remaining: qty, cancelled: false }); return { id, branch: '1' }; });
  revise = vi.fn(async (ref: OrderRef, _symbol: string, qty: number, _price: number) => {
    const old = this.statuses.get(ref.id)!;
    if (this.race) { Object.assign(old, { filled: qty, average: 72600, remaining: 0 }); return null; }
    Object.assign(old, { remaining: 0, cancelled: true });
    const next = { id: `revised${++this.n}`, branch: '1' }; this.statuses.set(next.id, { filled: qty, average: 71600, remaining: 0, cancelled: false }); return next;
  });
  async status(ref: OrderRef) { return { ...this.statuses.get(ref.id)! }; }
  async connect() {} disconnect() {}
}
function setup(b = new Fake()) { const persist = vi.fn(async () => {}); const engine = new TradingEngine(b, persist, () => {}, 'test'); engine.onBook(book()); return { b, engine, persist }; }
describe('order lifecycle', () => {
  it('persists intent before sending and protects only confirmed fill quantity', async () => {
    const { b, engine, persist } = setup();
    b.buy.mockImplementationOnce(async () => { expect(persist).toHaveBeenCalled(); b.statuses.set('buy', { filled: 1, average: 72100, remaining: 2, cancelled: false }); return { id: 'buy', branch: '1' }; });
    await engine.buy(symbol, 3, defaultRule);
    expect(b.sell).toHaveBeenCalledWith('005930', 1, 72600);
    expect(engine.quantity).toBe(1); expect(engine.state.entries[0].state).toBe('open');
    b.statuses.set('buy', { filled: 3, average: 72100, remaining: 0, cancelled: false }); await engine.sync();
    expect(b.sell).toHaveBeenLastCalledWith('005930', 2, 72600); expect(engine.quantity).toBe(3);
  });
  it('does not retry a buy with ambiguous transport failure', async () => {
    const { b, engine } = setup(); b.fail = true; await engine.buy(symbol, 1, defaultRule);
    expect(engine.state.entries[0].state).toBe('unknown');
    await expect(engine.buy(symbol, 1, defaultRule)).rejects.toThrow('확인이 필요한 주문'); expect(b.buy).toHaveBeenCalledTimes(1);
  });
  it('handles definite rejection without creating an unresolved position', async () => {
    const { b, engine } = setup(); b.buy.mockRejectedValueOnce(new Rejected('잔고 부족')); await engine.buy(symbol, 1, defaultRule);
    expect(engine.exposed).toBe(false); expect(b.sell).not.toHaveBeenCalled();
  });
  it('deduplicates cumulative fills and includes configured transaction costs', async () => {
    const { b, engine } = setup(); await engine.buy(symbol, 1, defaultRule);
    const ref = engine.state.lots[0].ref!; b.statuses.set(ref.id, { filled: 1, average: 72600, remaining: 0, cancelled: false });
    await engine.sync(); await engine.sync(); expect(engine.state.trades).toHaveLength(1); expect(engine.quantity).toBe(0);
    expect(engine.state.trades[0].net).toBeCloseTo(500 - 72100 * .00015 - 72600 * .00215);
  });
  it('revises the outstanding take-profit exactly once on repeated stop ticks', async () => {
    const { b, engine } = setup(); await engine.buy(symbol, 1, defaultRule);
    engine.onBook(book(71600)); engine.onBook(book(71600)); await engine.sync();
    expect(b.revise).toHaveBeenCalledTimes(1); expect(engine.state.trades[0].reason).toBe('손절'); expect(engine.quantity).toBe(0);
  });
  it('accounts for a take-profit filling while a stop revision is in flight', async () => {
    const { b, engine } = setup(); await engine.buy(symbol, 1, defaultRule); b.race = true;
    engine.onBook(book(71600)); await engine.sync(); expect(engine.state.trades).toHaveLength(1);
    expect(engine.state.trades[0].reason).toBe('익절'); expect(engine.quantity).toBe(0); expect(b.sell).toHaveBeenCalledTimes(1);
  });
  it('does not send a stop revision for an already filled take-profit', async () => {
    const { b, engine } = setup(); await engine.buy(symbol, 1, defaultRule);
    b.statuses.set(engine.state.lots[0].ref!.id, { filled: 1, average: 72600, remaining: 0, cancelled: false });
    engine.onBook(book(71600)); await engine.sync(); expect(b.revise).not.toHaveBeenCalled(); expect(engine.quantity).toBe(0);
  });
  it('rejects purchases against stale quotes', async () => {
    const { b, engine } = setup(); engine.onBook({ ...book(), time: Date.now() - 11000 });
    await expect(engine.buy(symbol, 1, defaultRule)).rejects.toThrow('최신 호가'); expect(b.buy).not.toHaveBeenCalled();
  });
});
describe('KIS H0STASP0 wire format', () => {
  it('maps ten price and quantity levels without swapping sides', () => {
    const a = Array.from({ length: 59 }, () => '0'); a[0] = '005930'; a[3] = '72200'; a[13] = '72100'; a[23] = '123'; a[33] = '456'; a[43] = '1000'; a[44] = '2000';
    const b = parseBook(a.join('^')); expect(b.asks[0]).toEqual({ price: 72200, qty: 123 }); expect(b.bids[0]).toEqual({ price: 72100, qty: 456 }); expect(b.totalBid).toBe(2000);
  });
});
