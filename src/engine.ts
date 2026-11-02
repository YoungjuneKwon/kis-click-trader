import { aggressivePrice, stopPrice, targetPrice, uid, type Book, type Broker, type Entry, type Lot, type Rule, type Snapshot, type SymbolInfo } from './model';

export class Rejected extends Error {}
export class TradingEngine {
  state: Snapshot;
  book?: Book;
  private tail: Promise<unknown> = Promise.resolve();
  private syncing = false;
  private tickQueued = false;
  private persistTail: Promise<void> = Promise.resolve();
  constructor(public broker: Broker, private persist: (s: Snapshot) => Promise<void>, private change: () => void, accountTag: string, restored?: Snapshot) {
    this.state = restored || { id: uid(), kind: broker.kind, accountTag, entries: [], lots: [], trades: [], logs: [], started: Date.now() };
  }
  get exposed() { return this.state.entries.some(e => e.state !== 'done') || this.state.lots.some(l => l.state !== 'closed'); }
  get uncertain() { return this.state.entries.some(e => e.state === 'unknown' || e.state === 'sending') || this.state.lots.some(l => l.state === 'unknown' || l.state === 'protecting' || l.state === 'stopping'); }
  get quantity() { return this.state.lots.reduce((n, l) => n + l.qty - l.sold, 0); }
  log(message: string, level: 'info' | 'error' = 'info') { this.state.logs.unshift({ id: uid(), time: Date.now(), message, level }); this.state.logs = this.state.logs.slice(0, 150); this.change(); }
  private checkpoint() {
    const snapshot = structuredClone(this.state);
    const next = this.persistTail.catch(() => {}).then(() => this.persist(snapshot));
    this.persistTail = next;
    this.change(); return next;
  }
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task); this.tail = next.catch(() => {}); return next;
  }
  buy(symbol: SymbolInfo, qty: number, rule: Rule) {
    return this.run(async () => {
      if (!Number.isInteger(qty) || qty < 1 || qty > 100000) throw new Error('수량을 확인해 주세요.');
      if (this.uncertain) throw new Error('확인이 필요한 주문이 있습니다. 주문 상태부터 대조해 주세요.');
      if (!this.book || this.book.symbol !== symbol.code || Date.now() - this.book.time > 10000) throw new Error('최신 호가를 받은 뒤 매수할 수 있습니다.');
      if (this.exposed && this.state.entries.some(e => e.symbol !== symbol.code)) throw new Error('보유 종목을 모두 청산한 뒤 종목을 바꿔 주세요.');
      const entry: Entry = { id: uid(), symbol: symbol.code, name: symbol.name, qty, filled: 0, amount: 0, state: 'sending', rule: { ...rule } };
      this.state.entries.push(entry);
      // Write intent BEFORE sending. Never replay a possibly accepted order.
      await this.checkpoint();
      try { entry.ref = await this.broker.buy(symbol.code, qty); entry.state = 'open'; this.log(`${symbol.name} ${qty}주 최유리 매수 접수`); }
      catch (error) { entry.state = error instanceof Rejected ? 'done' : 'unknown'; this.log(error instanceof Rejected ? error.message : '매수 응답 불명확: 자동 재전송하지 않습니다. KIS 주문 내역을 확인해 주세요.', 'error'); }
      await this.checkpoint();
      if (entry.ref) await this.syncEntry(entry);
      await this.checkpoint();
    });
  }
  private async syncEntry(entry: Entry) {
    if (!entry.ref || entry.state === 'done') return;
    const status = await this.broker.status(entry.ref, entry.symbol);
    const delta = status.filled - entry.filled;
    if (delta < 0) throw new Error('매수 누적 체결 수량이 감소했습니다.');
    if (delta > 0) {
      const total = status.average * status.filled; const price = (total - entry.amount) / delta;
      const lot: Lot = { id: uid(), entryId: entry.id, symbol: entry.symbol, name: entry.name, qty: delta, entry: price, target: targetPrice(price, entry.rule), stop: stopPrice(price, entry.rule), sold: 0, exitAmount: 0, state: 'protecting', reason: '익절', seenFilled: 0, seenAmount: 0, rule: entry.rule, opened: Date.now() };
      entry.filled = status.filled; entry.amount = total; this.state.lots.push(lot);
      await this.checkpoint();
      try { lot.ref = await this.broker.sell(lot.symbol, delta, lot.target); lot.state = 'protected'; this.log(`${lot.name} ${delta}주 체결 · 익절 매도 ${lot.target.toLocaleString()}원 접수`); }
      catch (error) { lot.state = 'unknown'; this.log(`익절 주문 확인 필요: ${error instanceof Rejected ? error.message : '응답 불명확, 자동 재전송 중지'}`, 'error'); }
    }
    if (status.remaining === 0 || status.cancelled || status.filled >= entry.qty) entry.state = 'done';
  }
  private async syncLot(lot: Lot, ignoreCancellation = false) {
    if (!lot.ref || lot.state === 'closed') return;
    const status = await this.broker.status(lot.ref, lot.symbol);
    const delta = status.filled - lot.seenFilled;
    if (delta < 0) throw new Error('매도 누적 체결 수량이 감소했습니다.');
    if (delta > 0) {
      const total = status.average * status.filled; const amount = total - lot.seenAmount; const exit = amount / delta;
      const gross = amount - lot.entry * delta;
      const cost = lot.entry * delta * lot.rule.buyFee / 100 + amount * (lot.rule.sellFee + lot.rule.tax) / 100;
      this.state.trades.push({ id: uid(), lotId: lot.id, symbol: lot.symbol, name: lot.name, qty: delta, entry: lot.entry, exit, gross, cost, net: gross - cost, time: Date.now(), reason: lot.reason });
      lot.sold += delta; lot.exitAmount += amount; lot.seenFilled = status.filled; lot.seenAmount = total;
      if (lot.sold >= lot.qty) { lot.state = 'closed'; this.log(`${lot.name} ${lot.qty}주 ${lot.reason} 청산 완료`); }
    }
    if (!ignoreCancellation && status.cancelled && lot.sold < lot.qty) { lot.state = 'unknown'; this.log('외부에서 매도 주문이 취소됐습니다. 잔여 보유 수량 확인이 필요합니다.', 'error'); }
  }
  sync() {
    if (this.syncing) return Promise.resolve(); this.syncing = true;
    return this.run(async () => {
      try {
        for (const e of this.state.entries) await this.syncEntry(e);
        for (const l of this.state.lots) await this.syncLot(l);
        await this.checkpoint();
      } finally { this.syncing = false; }
    });
  }
  onBook(book: Book) {
    this.book = book; this.change();
    const needsExit = (l: Lot) => l.state === 'protected' && l.symbol === book.symbol && (book.bids[0]?.price <= l.stop || (l.reason !== '익절' && book.bids[0]?.price < (l.exitLimit || 0) && Date.now() - (l.revisedAt || 0) > 2000));
    if (this.tickQueued || !this.state.lots.some(needsExit)) return;
    this.tickQueued = true;
    void this.run(async () => {
      try {
        for (const lot of this.state.lots) {
          if (needsExit(lot)) await this.exitLot(lot, lot.reason === '수동 청산' ? '수동 청산' : '손절');
        }
        await this.checkpoint();
      } finally { this.tickQueued = false; }
    }).catch(e => this.log(String(e instanceof Error ? e.message : e), 'error'));
  }
  private async exitLot(lot: Lot, reason: Lot['reason']) {
    if (!lot.ref || lot.state !== 'protected') return;
    if (!this.book || Date.now() - this.book.time > 10000) throw new Error('호가가 오래되어 정정 가격을 계산할 수 없습니다.');
    await this.syncLot(lot); // an already-filled take-profit must not trigger a second sale
    if (lot.state !== 'protected') return;
    const bid = this.book.bids[0]?.price; if (!bid) throw new Error('매수호가가 없습니다.');
    const oldRef = lot.ref; const oldReason = lot.reason;
    lot.state = 'stopping'; await this.checkpoint();
    try {
      const ref = await this.broker.revise(oldRef, lot.symbol, lot.qty - lot.sold, aggressivePrice(bid));
      // Account for fills on the old order racing with the revision.
      await this.syncLot(lot, true);
      if (ref) {
        if (lot.sold >= lot.qty) { lot.state = 'closed'; return; }
        lot.ref = ref; lot.seenFilled = 0; lot.seenAmount = 0; lot.reason = reason; lot.state = 'protected';
        // Only monitor this revised order; don't repeatedly issue stop revisions.
        lot.stop = -1; lot.exitLimit = aggressivePrice(bid); lot.revisedAt = Date.now();
        this.log(`${lot.name} ${reason} 정정 접수 · 체결 확인 중`);
        await this.checkpoint(); await this.syncLot(lot);
      } else if (lot.sold < lot.qty) { lot.state = 'unknown'; this.log('정정 가능 잔량이 없습니다. 실제 주문 상태를 확인해 주세요.', 'error'); }
    } catch (error) {
      lot.state = 'unknown'; lot.reason = oldReason;
      this.log(`정정 결과 확인 필요: ${error instanceof Rejected ? error.message : '응답 불명확, 재전송하지 않음'}`, 'error');
    }
  }
  closeAll() { return this.run(async () => { for (const l of this.state.lots) await this.exitLot(l, '수동 청산'); await this.checkpoint(); }); }
}
