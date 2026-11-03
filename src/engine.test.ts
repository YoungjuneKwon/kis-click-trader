import { describe, expect, it, vi } from 'vitest';
import { Rejected, TradingEngine } from './engine';
import { defaultRule, type Book, type Broker, type OrderRef, type OrderStatus, type Snapshot } from './model';
import { parseBook } from './kis';

const symbol = { code: '005930', name: '삼성전자' };
const book = (price = 72000): Book => ({ symbol: symbol.code, time: Date.now(), last: price, asks: [{ price: price + 100, qty: 50 }], bids: [{ price, qty: 100 }], totalAsk: 50, totalBid: 100 });
class Fake implements Broker {
  kind = 'kis' as const;
  statuses = new Map<string, OrderStatus>();
  n = 0;
  buys = 0;
  accountQuantity = 1;
  fail = false;
  race = false;
  buy = vi.fn(async (_symbol: string, qty: number) => { if (this.fail) throw new Error('timeout'); const id = this.buys++ === 0 ? 'buy' : `buy${this.buys}`; this.statuses.set(id, { filled: qty, average: 72100, remaining: 0, cancelled: false }); this.accountQuantity += qty; return { id, branch: '1' }; });
  sell = vi.fn(async (_symbol: string, qty: number, _price: number) => { const id = `sell${++this.n}`; this.statuses.set(id, { filled: 0, average: 0, remaining: qty, cancelled: false }); return { id, branch: '1' }; });
  revise = vi.fn(async (ref: OrderRef, _symbol: string, qty: number, _price: number) => {
    const old = this.statuses.get(ref.id)!;
    this.accountQuantity -= qty;
    if (this.race) { Object.assign(old, { filled: old.filled + qty, average: 72600, remaining: 0 }); return null; }
    Object.assign(old, { remaining: 0, cancelled: true });
    const next = { id: `revised${++this.n}`, branch: '1' }; this.statuses.set(next.id, { filled: qty, average: 71600, remaining: 0, cancelled: false }); return next;
  });
  cancelBuy = vi.fn(async (ref: OrderRef, _symbol: string) => {
    const old = this.statuses.get(ref.id)!; old.remaining = 0; old.cancelled = true;
    return { id: `cancel${++this.n}`, branch: '1' };
  });
  async status(ref: OrderRef) { return { ...this.statuses.get(ref.id)! }; }
  async connect() {} disconnect() {}
}
function setup(b = new Fake()) { const persist = vi.fn(async (_snapshot: Snapshot) => {}); const engine = new TradingEngine(b, persist, () => {}, 'test'); engine.onBook(book()); return { b, engine, persist }; }
function pendingRuleRevision(b: Fake) {
  b.revise.mockImplementation(async (ref, _symbol, qty, _price) => {
    const old = b.statuses.get(ref.id)!; old.remaining = 0; old.cancelled = true;
    const next = { id: `updated${++b.n}`, branch: '1' };
    b.statuses.set(next.id, { filled: 0, average: 0, remaining: qty, cancelled: false });
    return next;
  });
}
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
  it('uses order-specific execution amounts rather than rounded average prices for P&L', async () => {
    const { b, engine } = setup();
    b.buy.mockImplementationOnce(async () => { b.statuses.set('buy', { filled: 3, average: 72100.3, amount: 216301, remaining: 0, cancelled: false }); return { id: 'buy', branch: '1' }; });
    await engine.buy(symbol, 3, defaultRule);
    const lot = engine.state.lots[0];
    b.statuses.set(lot.ref!.id, { filled: 3, average: 72600.3, amount: 217801, remaining: 0, cancelled: false });
    await engine.sync(); expect(engine.state.entries[0].amount).toBe(216301);
    expect(engine.state.trades[0].gross).toBe(1500);
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
  it('closes one entry without touching another entry or the pre-existing account share', async () => {
    const { b, engine } = setup();
    await engine.buy(symbol, 1, defaultRule); await engine.buy(symbol, 2, defaultRule);
    expect(b.accountQuantity).toBe(4); // 1 external + 3 bought through this screen
    const [first, second] = engine.state.entries;
    const secondOrder = engine.state.lots.find(l => l.entryId === second.id)!.ref!;
    await engine.closeEntry(first.id); await engine.closeEntry(first.id);
    expect(b.revise).toHaveBeenCalledTimes(1); expect(b.accountQuantity).toBe(3);
    expect(engine.quantity).toBe(2); expect(b.statuses.get(secondOrder.id)!.remaining).toBe(2);
    await engine.closeAll();
    expect(b.revise).toHaveBeenCalledTimes(2); expect(b.accountQuantity).toBe(1);
    expect(engine.quantity).toBe(0); expect(b.sell).toHaveBeenCalledTimes(2);
  });
  it('ignores external holdings and unknown entry IDs even when closing everything', async () => {
    const { b, engine } = setup();
    b.statuses.set('external-order', { filled: 0, average: 0, remaining: 1, cancelled: false });
    await engine.closeAll();
    await expect(engine.closeEntry('external-order')).rejects.toThrow('진입 내역에 없는');
    expect(b.sell).not.toHaveBeenCalled(); expect(b.revise).not.toHaveBeenCalled(); expect(b.cancelBuy).not.toHaveBeenCalled(); expect(b.accountQuantity).toBe(1);
  });
  it('cancels only the selected partial buy and closes any racing fill belonging to it', async () => {
    const { b, engine } = setup();
    b.buy.mockImplementationOnce(async () => { b.accountQuantity++; b.statuses.set('buy', { filled: 1, average: 72100, remaining: 2, cancelled: false }); return { id: 'buy', branch: '1' }; });
    await engine.buy(symbol, 3, defaultRule);
    b.cancelBuy.mockImplementationOnce(async ref => {
      b.accountQuantity++; // another share fills just before cancellation
      b.statuses.set(ref.id, { filled: 2, average: 72100, remaining: 0, cancelled: true });
      return { id: 'cancel-buy', branch: '1' };
    });
    await engine.closeEntry(engine.state.entries[0].id);
    expect(b.cancelBuy).toHaveBeenCalledWith({ id: 'buy', branch: '1' }, '005930');
    expect(b.revise.mock.calls.map(call => call[2])).toEqual([1, 1]);
    expect(engine.state.entries[0].filled).toBe(2); expect(engine.quantity).toBe(0); expect(b.accountQuantity).toBe(1);
  });
  it('keeps a close request active when buy cancellation acknowledgement is delayed', async () => {
    const { b, engine } = setup();
    b.buy.mockImplementationOnce(async () => { b.accountQuantity++; b.statuses.set('buy', { filled: 1, average: 72100, remaining: 2, cancelled: false }); return { id: 'buy', branch: '1' }; });
    await engine.buy(symbol, 3, defaultRule);
    b.cancelBuy.mockResolvedValueOnce({ id: 'pending-cancel', branch: '1' });
    await engine.closeEntry(engine.state.entries[0].id);
    expect(engine.state.entries[0].state).toBe('open'); expect(b.accountQuantity).toBe(1);
    b.accountQuantity += 2; b.statuses.set('buy', { filled: 3, average: 72100, remaining: 0, cancelled: false });
    await engine.sync();
    expect(engine.quantity).toBe(0); expect(b.accountQuantity).toBe(1); expect(b.cancelBuy).toHaveBeenCalledTimes(1);
    expect(engine.state.trades.every(t => t.reason === '수동 청산')).toBe(true);
  });
  it('revises only the unsold part of an entry and calculates P&L from its fills', async () => {
    const { b, engine } = setup(); await engine.buy(symbol, 3, defaultRule);
    const lot = engine.state.lots[0], originalRef = lot.ref!; b.accountQuantity--;
    b.statuses.set(originalRef.id, { filled: 1, average: 72600, remaining: 2, cancelled: false });
    await engine.sync(); await engine.closeEntry(engine.state.entries[0].id);
    expect(b.revise).toHaveBeenCalledWith(originalRef, '005930', 2, expect.any(Number));
    expect(engine.state.trades.map(t => t.qty)).toEqual([1, 2]);
    expect(engine.state.trades.reduce((n, t) => n + t.gross, 0)).toBe(-500);
    expect(engine.quantity).toBe(0); expect(b.accountQuantity).toBe(1);
  });
});
describe('applying take-profit and stop rules to existing entries', () => {
  it('revises the actual take-profit and updates stop monitoring without changing captured costs', async () => {
    const { b, engine } = setup(); await engine.buy(symbol, 1, defaultRule); pendingRuleRevision(b);
    const previousRef = engine.state.lots[0].ref!;
    const result = await engine.applyRules({ ...defaultRule, take: 3000, stop: 1000, buyFee: 2, sellFee: 2, tax: 2 });
    const lot = engine.state.lots[0];
    expect(b.revise).toHaveBeenCalledWith(previousRef, '005930', 1, 75100);
    expect(lot.target).toBe(75100); expect(lot.stop).toBe(71100); expect(lot.state).toBe('protected');
    expect(lot.rule.buyFee).toBe(defaultRule.buyFee); expect(engine.state.entries[0].rule.tax).toBe(defaultRule.tax);
    expect(result).toMatchObject({ entries: 1, takeOrders: 1, stopLots: 1, failed: 0 });
    expect(engine.quantity).toBe(1); expect(b.accountQuantity).toBe(2); // existing external share is untouched
  });
  it('applies percentage rules to later partial fills of the same buy order', async () => {
    const { b, engine } = setup();
    b.buy.mockImplementationOnce(async () => { b.accountQuantity++; b.statuses.set('buy', { filled: 1, average: 72100, remaining: 2, cancelled: false }); return { id: 'buy', branch: '1' }; });
    await engine.buy(symbol, 3, defaultRule); pendingRuleRevision(b);
    await engine.applyRules({ ...defaultRule, unit: 'percent', take: 2, stop: 1 });
    b.accountQuantity += 2; b.statuses.set('buy', { filled: 3, average: 72100, remaining: 0, cancelled: false });
    await engine.sync();
    expect(b.sell).toHaveBeenLastCalledWith('005930', 2, 73600);
    expect(engine.state.lots.every(l => l.target === 73600 && l.stop === 71379)).toBe(true);
    expect(engine.quantity).toBe(3); expect(b.accountQuantity).toBe(4);
  });
  it('does not change a closing entry or any pre-existing account share', async () => {
    const { b, engine } = setup(); await engine.buy(symbol, 1, defaultRule); await engine.buy(symbol, 1, defaultRule); pendingRuleRevision(b);
    engine.state.entries[0].closeRequested = true;
    const first = engine.state.lots[0], original = first.ref!;
    first.reason = '수동 청산'; first.stop = -1; first.exitLimit = 71000;
    await engine.applyRules({ ...defaultRule, take: 3000, stop: 1000 });
    expect(b.revise).toHaveBeenCalledTimes(1); expect(b.revise.mock.calls[0][0].id).not.toBe(original.id);
    expect(first.target).toBe(72600); expect(first.stop).toBe(-1); expect(b.accountQuantity).toBe(3);
  });
  it('uses the existing sell order to exit if the new stop is already crossed', async () => {
    const { b, engine } = setup(); await engine.buy(symbol, 1, defaultRule);
    const old = engine.state.lots[0].ref!;
    const result = await engine.applyRules({ ...defaultRule, take: 3000, stop: 50 });
    expect(b.revise).toHaveBeenCalledTimes(1); expect(b.revise).toHaveBeenCalledWith(old, '005930', 1, expect.any(Number));
    expect(result.stopExits).toBe(1); expect(engine.state.trades[0].reason).toBe('손절'); expect(b.accountQuantity).toBe(1);
  });
  it('records a take-profit filling during the revision and modifies only its remainder', async () => {
    const { b, engine } = setup(); await engine.buy(symbol, 3, defaultRule);
    const oldRef = engine.state.lots[0].ref!;
    b.revise.mockImplementationOnce(async () => {
      b.accountQuantity--; b.statuses.set(oldRef.id, { filled: 1, average: 72600, remaining: 0, cancelled: true });
      b.statuses.set('updated', { filled: 0, average: 0, remaining: 2, cancelled: false }); return { id: 'updated', branch: '1' };
    });
    await engine.applyRules({ ...defaultRule, take: 3000, stop: 1000 });
    expect(engine.state.trades).toHaveLength(1); expect(engine.state.trades[0].qty).toBe(1);
    expect(engine.quantity).toBe(2); expect(engine.state.lots[0].target).toBe(75100); expect(b.accountQuantity).toBe(3);
  });
  it('persists the acknowledged new order and finishes reconciliation without resubmitting', async () => {
    const { b, engine, persist } = setup(); await engine.buy(symbol, 1, defaultRule); pendingRuleRevision(b);
    const oldRef = engine.state.lots[0].ref!, status = b.status.bind(b); let failed = false;
    vi.spyOn(b, 'status').mockImplementation(async ref => {
      if (ref.id === oldRef.id && b.revise.mock.calls.length && !failed) { failed = true; throw new Error('test query timeout'); }
      return status(ref);
    });
    const result = await engine.applyRules({ ...defaultRule, take: 3000, stop: 1000 });
    expect(result.pending).toBe(1); expect(engine.state.lots[0].revision?.ref.id).toMatch(/^updated/);
    expect(persist.mock.calls.some(([s]) => s.lots[0]?.revision?.ref.id.startsWith('updated'))).toBe(true);
    await engine.sync();
    expect(engine.state.lots[0].revision).toBeUndefined(); expect(engine.state.lots[0].state).toBe('protected');
    expect(engine.state.lots[0].target).toBe(75100); expect(b.revise).toHaveBeenCalledTimes(1);
  });
  it('keeps the old take-profit on a definite rejection while retaining the updated stop', async () => {
    const { b, engine } = setup(); await engine.buy(symbol, 1, defaultRule);
    b.revise.mockRejectedValueOnce(new Rejected('test price rejection'));
    const result = await engine.applyRules({ ...defaultRule, take: 3000, stop: 1000 });
    expect(result.failed).toBe(1); expect(engine.state.lots[0].target).toBe(72600); expect(engine.state.lots[0].stop).toBe(71100);
    expect(engine.state.lots[0].state).toBe('protected'); expect(b.revise).toHaveBeenCalledTimes(1);
  });
  it('does not revise take-profit when only the stop changes or the same values are reapplied', async () => {
    const { b, engine } = setup(); await engine.buy(symbol, 1, defaultRule); pendingRuleRevision(b);
    await engine.applyRules({ ...defaultRule, stop: 1000 });
    expect(b.revise).not.toHaveBeenCalled(); expect(engine.state.lots[0].stop).toBe(71100);
    await engine.applyRules({ ...defaultRule, take: 3000, stop: 1000 });
    await engine.applyRules({ ...defaultRule, take: 3000, stop: 1000 });
    expect(b.revise).toHaveBeenCalledTimes(1);
  });
});
describe('KIS H0STASP0 wire format', () => {
  it('maps ten price and quantity levels without swapping sides', () => {
    const a = Array.from({ length: 59 }, () => '0'); a[0] = '005930'; a[3] = '72200'; a[13] = '72100'; a[23] = '123'; a[33] = '456'; a[43] = '1000'; a[44] = '2000';
    const b = parseBook(a.join('^')); expect(b.asks[0]).toEqual({ price: 72200, qty: 123 }); expect(b.bids[0]).toEqual({ price: 72100, qty: 456 }); expect(b.totalBid).toBe(2000);
  });
});
