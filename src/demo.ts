import { symbols, tickSize, uid, type Book, type Broker, type OrderRef, type OrderStatus } from './model';

type DemoOrder = OrderStatus & { side: 'buy' | 'sell'; symbol: string; qty: number; price: number };
export class DemoBroker implements Broker {
  kind = 'demo' as const;
  private orders = new Map<string, DemoOrder>();
  private timer?: ReturnType<typeof setInterval>;
  private price = 72000;
  private symbol = '005930';
  private onBook?: (book: Book) => void;
  private onFill?: () => void;
  async connect(symbol: string, onBook: (book: Book) => void, onStatus: (s: string) => void, onFill: () => void) {
    this.disconnect(); this.symbol = symbol; this.price = symbols.find(s => s.code === symbol)?.base || 50000;
    this.onBook = onBook; this.onFill = onFill; this.publish(); onStatus('demo');
    this.timer = setInterval(() => { if (Math.random() > .45) this.price += (Math.random() > .5 ? 1 : -1) * tickSize(this.price); this.publish(); }, 800);
  }
  move(direction: number) { this.price = Math.max(1000, this.price + direction * tickSize(this.price) * 3); this.publish(); }
  private publish() {
    const tick = tickSize(this.price);
    const asks = Array.from({ length: 10 }, (_, i) => ({ price: this.price + (i + 1) * tick, qty: Math.floor(150 + Math.random() * 6500) }));
    const bids = Array.from({ length: 10 }, (_, i) => ({ price: this.price - i * tick, qty: Math.floor(150 + Math.random() * 6500) }));
    this.onBook?.({ symbol: this.symbol, time: Date.now(), asks, bids, last: this.price, totalAsk: asks.reduce((n, a) => n + a.qty, 0), totalBid: bids.reduce((n, b) => n + b.qty, 0) });
    let changed = false;
    for (const o of this.orders.values()) {
      if (o.remaining && o.side === 'sell' && o.symbol === this.symbol && bids[0].price >= o.price) { o.average = bids[0].price; o.filled = o.qty; o.remaining = 0; changed = true; }
    }
    if (changed) this.onFill?.();
  }
  async buy(symbol: string, qty: number) { const ref = { id: uid(), branch: 'DEMO' }; this.orders.set(ref.id, { side: 'buy', symbol, qty, price: this.price + tickSize(this.price), filled: qty, average: this.price + tickSize(this.price), remaining: 0, cancelled: false }); return ref; }
  async sell(symbol: string, qty: number, price: number) { const ref = { id: uid(), branch: 'DEMO' }; this.orders.set(ref.id, { side: 'sell', symbol, qty, price, filled: 0, average: 0, remaining: qty, cancelled: false }); return ref; }
  async revise(ref: OrderRef, symbol: string, qty: number, price: number) {
    const old = this.orders.get(ref.id); if (!old || !old.remaining) return null;
    const remaining = Math.min(qty, old.remaining); old.remaining = 0; old.cancelled = false;
    const next = await this.sell(symbol, remaining, price); this.publish(); return next;
  }
  async status(ref: OrderRef) { const o = this.orders.get(ref.id); if (!o) throw new Error('데모는 새로고침 후 이전 주문을 복구할 수 없습니다.'); return { ...o }; }
  disconnect() { clearInterval(this.timer); }
}
