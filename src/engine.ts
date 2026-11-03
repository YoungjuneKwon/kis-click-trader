import { aggressivePrice, ruleSchema, stopPrice, targetPrice, uid, type Book, type Broker, type Entry, type Lot, type Rule, type Snapshot, type SymbolInfo } from './model';
import { screenLots } from './entry-summary';

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
  get uncertain() { return this.state.entries.some(e => e.state === 'unknown' || e.state === 'sending') || this.state.lots.some(l => l.state === 'unknown' || l.state === 'protecting' || l.state === 'updating' || l.state === 'stopping'); }
  get quantity() { return screenLots(this.state).reduce((n, l) => n + l.qty - l.sold, 0); }
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
      const entry: Entry = { id: uid(), symbol: symbol.code, name: symbol.name, qty, filled: 0, amount: 0, state: 'sending', rule: { ...rule }, createdAt: Date.now() };
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
    if (delta < 0 || status.filled > entry.qty || (delta > 0 && status.average <= 0)) {
      entry.state = 'unknown'; await this.checkpoint(); throw new Error('매수 체결 내역이 진입 주문 범위와 일치하지 않습니다.');
    }
    if (delta > 0) {
      const total = status.amount ?? status.average * status.filled; const price = (total - entry.amount) / delta;
      const lot: Lot = { id: uid(), entryId: entry.id, symbol: entry.symbol, name: entry.name, qty: delta, entry: price, target: targetPrice(price, entry.rule), stop: stopPrice(price, entry.rule), sold: 0, exitAmount: 0, state: 'protecting', reason: '익절', seenFilled: 0, seenAmount: 0, rule: entry.rule, opened: Date.now() };
      entry.filled = status.filled; entry.amount = total; this.state.lots.push(lot);
      await this.checkpoint();
      try { lot.ref = await this.broker.sell(lot.symbol, delta, lot.target); lot.state = 'protected'; this.log(`${lot.name} ${delta}주 체결 · 익절 매도 ${lot.target.toLocaleString()}원 접수`); }
      catch (error) { lot.state = 'unknown'; this.log(`익절 주문 확인 필요: ${error instanceof Rejected ? error.message : '응답 불명확, 자동 재전송 중지'}`, 'error'); }
      await this.checkpoint();
      // A late fill after a close request still belongs to this entry, not to account inventory.
      if (entry.closeRequested && lot.state === 'protected' && this.book?.symbol === lot.symbol && Date.now() - this.book.time <= 10000) await this.exitLot(lot, '수동 청산');
    }
    if (status.remaining === 0 || status.cancelled || status.filled >= entry.qty) entry.state = 'done';
  }
  private async syncLot(lot: Lot, ignoreCancellation = false) {
    if (!lot.ref || lot.state === 'closed') return;
    const status = await this.broker.status(lot.ref, lot.symbol);
    const delta = status.filled - lot.seenFilled;
    if (delta < 0 || delta > lot.qty - lot.sold) {
      lot.state = 'unknown'; await this.checkpoint(); throw new Error('매도 체결 수량이 이 진입건의 잔량 범위를 벗어났습니다.');
    }
    if (delta > 0) {
      const total = status.amount ?? status.average * status.filled; const amount = total - lot.seenAmount; const exit = amount / delta;
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
        const hasRevisions = this.state.lots.some(l => l.revision);
        for (const l of this.state.lots) { if (l.revision) await this.finishRevision(l); else await this.syncLot(l); }
        if (hasRevisions && this.book) this.onBook(this.book);
      } finally { try { await this.checkpoint(); } finally { this.syncing = false; } }
    });
  }
  private ownerOf(lot: Lot) {
    const owner = this.state.entries.find(e => e.id === lot.entryId && e.symbol === lot.symbol && e.ref);
    if (!owner || this.state.lots.filter(l => l.entryId === owner.id).reduce((n, l) => n + l.qty, 0) > owner.filled) throw new Error('이 화면의 매수 체결로 확인되지 않은 수량은 변경할 수 없습니다.');
    return owner;
  }
  private async finishRevision(lot: Lot) {
    const revision = lot.revision;
    if (!revision) return;
    this.ownerOf(lot);
    // Reconcile fills racing on the previous order before switching cumulative counters.
    await this.syncLot(lot, true);
    if (lot.sold >= lot.qty) { lot.state = 'closed'; delete lot.revision; await this.checkpoint(); return; }
    lot.ref = revision.ref; lot.target = revision.target; lot.stop = revision.stop;
    lot.rule = revision.rule; lot.reason = revision.reason; lot.seenFilled = 0; lot.seenAmount = 0;
    lot.state = 'protected'; delete lot.revision;
    await this.checkpoint();
    await this.syncLot(lot);
  }
  applyRules(rule: Rule) {
    return this.run(async () => {
      ruleSchema.parse(rule);
      if (this.uncertain) throw new Error('확인 중인 주문이 있습니다. 상태 대조 후 규칙을 적용해 주세요.');
      if (!this.book || Date.now() - this.book.time > 10000 || !this.book.bids[0]?.price) throw new Error('최신 호가를 받은 뒤 규칙을 적용할 수 있습니다.');
      const result = { entries: 0, takeOrders: 0, stopLots: 0, failed: 0, pending: 0, stopExits: 0 };
      for (const entry of this.state.entries) {
        if (entry.closeRequested || entry.symbol !== this.book.symbol) continue;
        const liveLots = () => this.state.lots.filter(l => l.entryId === entry.id && l.sold < l.qty && l.reason === '익절');
        if (entry.state === 'done' && !liveLots().length) continue;
        result.entries++;
        // Commission/tax settings remain the ones captured by this entry.
        entry.rule = { ...entry.rule, unit: rule.unit, take: rule.take, stop: rule.stop };
        await this.checkpoint();
        try { await this.syncEntry(entry); }
        catch (error) { result.failed++; this.log(`진입건 체결 대조 지연: ${error instanceof Error ? error.message : '조회 실패'}`, 'error'); }
        for (const lot of liveLots()) {
          if (!lot.ref || lot.state !== 'protected') { result.failed++; continue; }
          this.ownerOf(lot);
          try { await this.syncLot(lot); }
          catch (error) { result.failed++; this.log(`규칙 적용 전 체결 대조 실패: ${error instanceof Error ? error.message : '조회 실패'}`, 'error'); continue; }
          if (lot.sold >= lot.qty || lot.state !== 'protected') continue;
          const nextRule = { ...lot.rule, unit: rule.unit, take: rule.take, stop: rule.stop };
          const nextTarget = targetPrice(lot.entry, nextRule), nextStop = stopPrice(lot.entry, nextRule);
          lot.rule = nextRule; lot.stop = nextStop; result.stopLots++;
          await this.checkpoint();
          if (this.book.bids[0].price <= nextStop) {
            await this.exitLot(lot, '손절'); result.stopExits++; continue;
          }
          if (lot.target === nextTarget) continue;
          lot.state = 'updating'; await this.checkpoint();
          let revised;
          try { revised = await this.broker.revise(lot.ref, lot.symbol, lot.qty - lot.sold, nextTarget); }
          catch (error) {
            lot.state = error instanceof Rejected ? 'protected' : 'unknown'; result.failed++;
            this.log(`익절 정정 확인 필요: ${error instanceof Error ? error.message : '응답 불명확'}`, 'error');
            await this.checkpoint(); continue;
          }
          if (!revised) {
            try { await this.syncLot(lot, true); } catch { /* keep the original order reference */ }
            if (lot.sold < lot.qty) { lot.state = 'unknown'; result.failed++; this.log('익절 정정 가능 잔량을 확인하지 못했습니다.', 'error'); }
            await this.checkpoint(); continue;
          }
          result.takeOrders++;
          // Persist the acknowledged new order before any further network reads.
          lot.revision = { ref: revised, target: nextTarget, stop: nextStop, rule: nextRule, reason: '익절', requestedAt: Date.now() };
          await this.checkpoint();
          try { await this.finishRevision(lot); }
          catch (error) { result.pending++; this.log(`익절 정정 접수 · 체결 대조 대기: ${error instanceof Error ? error.message : '조회 지연'}`, 'error'); }
        }
      }
      this.log(`규칙 적용: 진입 ${result.entries}건 · 익절 정정 ${result.takeOrders}건 · 손절 기준 ${result.stopLots}건 갱신`);
      await this.checkpoint();
      if (this.book) this.onBook(this.book);
      return result;
    });
  }
  onBook(book: Book) {
    this.book = book; this.change();
    const needsExit = (l: Lot) => l.state === 'protected' && l.symbol === book.symbol && (this.state.entries.some(e => e.id === l.entryId && e.closeRequested) && l.reason === '익절' || book.bids[0]?.price <= l.stop || (l.reason !== '익절' && book.bids[0]?.price < (l.exitLimit || 0) && Date.now() - (l.revisedAt || 0) > 2000));
    if (this.tickQueued || !this.state.lots.some(needsExit)) return;
    this.tickQueued = true;
    void this.run(async () => {
      try {
        for (const lot of this.state.lots) {
          if (needsExit(lot)) await this.exitLot(lot, this.state.entries.some(e => e.id === lot.entryId && e.closeRequested) || lot.reason === '수동 청산' ? '수동 청산' : '손절');
        }
        await this.checkpoint();
      } finally { this.tickQueued = false; }
    }).catch(e => this.log(String(e instanceof Error ? e.message : e), 'error'));
  }
  private async exitLot(lot: Lot, reason: Lot['reason']) {
    if (!lot.ref || lot.state !== 'protected') return;
    this.ownerOf(lot);
    if (!this.book || this.book.symbol !== lot.symbol || Date.now() - this.book.time > 10000) throw new Error('호가가 오래되어 정정 가격을 계산할 수 없습니다.');
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
  private async closeManagedEntry(entryId: string) {
    const entry = this.state.entries.find(e => e.id === entryId);
    if (!entry) throw new Error('이 화면의 진입 내역에 없는 주문은 청산할 수 없습니다.');
    if (!entry.ref) throw new Error('매수 주문번호를 확인하지 못했습니다. 주문 내역을 먼저 확인해 주세요.');
    entry.closeRequested = true;
    await this.checkpoint();
    try { await this.syncEntry(entry); } catch (error) { this.log(error instanceof Error ? error.message : '진입건 체결 확인 지연', 'error'); }
    // Cancel only this entry's outstanding buy order, so a later fill cannot reopen it.
    if (entry.state !== 'done' && entry.filled < entry.qty && !entry.cancelRequested) {
      entry.cancelRequested = true;
      await this.checkpoint();
      try {
        entry.cancelRef = await this.broker.cancelBuy(entry.ref, entry.symbol) || undefined;
        this.log(`${entry.name} 진입건 미체결 매수 취소 요청 · 체결 내역 대조`);
      } catch (error) {
        entry.state = 'unknown'; this.log(`매수 취소 확인 필요: ${error instanceof Error ? error.message : '응답 불명확'}`, 'error');
      }
      // If acknowledgement is delayed, periodic sync will account for any racing fills.
      try { await this.syncEntry(entry); } catch (error) { this.log(error instanceof Error ? error.message : '매수 내역 확인 지연', 'error'); }
    }
    for (const lot of this.state.lots.filter(l => l.entryId === entryId)) {
      if (lot.reason === '익절' && lot.state === 'protected') await this.exitLot(lot, '수동 청산');
    }
    await this.checkpoint();
  }
  closeEntry(entryId: string) { return this.run(() => this.closeManagedEntry(entryId)); }
  closeAll() {
    return this.run(async () => {
      for (const entry of this.state.entries) {
        if (entry.ref && (entry.state !== 'done' || this.state.lots.some(l => l.entryId === entry.id && l.sold < l.qty))) await this.closeManagedEntry(entry.id);
      }
      await this.checkpoint();
    });
  }
}
