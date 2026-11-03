import type { Book, Entry, Snapshot } from './model';

export function screenLots(snapshot: Snapshot) {
  const entries = new Map(snapshot.entries.filter(e => e.ref).map(e => [e.id, e]));
  return snapshot.lots.filter(l => entries.get(l.entryId)?.symbol === l.symbol);
}
export function screenTrades(snapshot: Snapshot) {
  const lots = new Map(screenLots(snapshot).map(l => [l.id, l]));
  return snapshot.trades.filter(t => lots.get(t.lotId)?.symbol === t.symbol);
}

export function summarizeEntry(snapshot: Snapshot, entry: Entry, book?: Book, now = Date.now()) {
  const lots = screenLots(snapshot).filter(l => l.entryId === entry.id);
  const lotIds = new Set(lots.map(l => l.id));
  const trades = screenTrades(snapshot).filter(t => lotIds.has(t.lotId));
  const remaining = lots.reduce((n, l) => n + l.qty - l.sold, 0);
  const sold = lots.reduce((n, l) => n + l.sold, 0);
  const pending = entry.state === 'done' ? 0 : Math.max(0, entry.qty - entry.filled);
  const gross = trades.reduce((n, t) => n + t.gross, 0);
  const cost = trades.reduce((n, t) => n + t.cost, 0);
  const net = trades.reduce((n, t) => n + t.net, 0);
  const soldAmount = trades.reduce((n, t) => n + t.exit * t.qty, 0);
  const freshBook = book?.symbol === entry.symbol && book.bids[0]?.price > 0 && now - book.time <= 10000;
  const unrealized = remaining === 0 ? 0 : freshBook ? lots.reduce((n, l) => n + (book!.bids[0].price - l.entry) * (l.qty - l.sold), 0) : undefined;
  const updating = lots.some(l => l.state === 'updating');
  const uncertain = entry.state === 'unknown' || entry.state === 'sending' || lots.some(l => l.state === 'unknown' || l.state === 'protecting' || l.state === 'updating' || l.state === 'stopping');
  const completed = entry.state === 'done' && entry.filled > 0 && remaining === 0;
  const status = updating ? '규칙 적용 중' : uncertain ? '확인 필요'
    : completed ? '청산 완료'
    : entry.closeRequested ? '청산 진행 중'
    : entry.filled === 0 ? entry.state === 'done' ? '매수 미체결 종료' : '매수 대기'
    : sold > 0 ? '일부 청산' : '자동 청산 감시';
  return {
    entry, lots, remaining, sold, pending, gross, cost, net, unrealized, uncertain, updating, completed, status,
    averageEntry: entry.filled > 0 ? entry.amount / entry.filled : undefined,
    averageExit: sold > 0 ? soldAmount / sold : undefined,
    createdAt: entry.createdAt || lots[0]?.opened,
    canClose: !!entry.ref && !uncertain && !entry.closeRequested && (remaining > 0 || pending > 0),
  };
}
