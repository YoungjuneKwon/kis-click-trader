import { describe, expect, it } from 'vitest';
import { screenTrades, summarizeEntry } from './entry-summary';
import { defaultRule, type Snapshot } from './model';

function snapshot(): Snapshot {
  return {
    id: 'session', kind: 'kis', accountTag: 'test', started: 1000, logs: [],
    entries: [
      { id: 'entry1', symbol: '005930', name: '삼성전자', qty: 3, filled: 3, amount: 3020, ref: { id: 'buy1', branch: '1' }, state: 'done', rule: defaultRule },
      { id: 'entry2', symbol: '005930', name: '삼성전자', qty: 1, filled: 1, amount: 1500, ref: { id: 'buy2', branch: '1' }, state: 'done', rule: defaultRule },
    ],
    lots: [
      { id: 'lot1', entryId: 'entry1', symbol: '005930', name: '삼성전자', qty: 1, entry: 1000, target: 1100, stop: 900, sold: 1, exitAmount: 1100, state: 'closed', reason: '익절', seenFilled: 1, seenAmount: 1100, rule: defaultRule, opened: 1001 },
      { id: 'lot2', entryId: 'entry1', symbol: '005930', name: '삼성전자', qty: 2, entry: 1010, target: 1110, stop: 910, sold: 0, exitAmount: 0, state: 'protected', reason: '익절', seenFilled: 0, seenAmount: 0, rule: defaultRule, opened: 1002 },
      { id: 'lot3', entryId: 'entry2', symbol: '005930', name: '삼성전자', qty: 1, entry: 1500, target: 1600, stop: 1400, sold: 0, exitAmount: 0, state: 'protected', reason: '익절', seenFilled: 0, seenAmount: 0, rule: defaultRule, opened: 1003 },
    ],
    trades: [
      { id: 'trade1', lotId: 'lot1', symbol: '005930', name: '삼성전자', qty: 1, entry: 1000, exit: 1100, gross: 100, cost: 3, net: 97, time: 1004, reason: '익절' },
      { id: 'unrelated-trade', lotId: 'external', symbol: '005930', name: '삼성전자', qty: 100, entry: 100, exit: 9999, gross: 989900, cost: 0, net: 989900, time: 1004, reason: '외부 거래' },
    ],
  };
}
describe('entry-scoped accounting', () => {
  it('groups partial buy fills under the same order and ignores unrelated profits', () => {
    const state = snapshot();
    expect(screenTrades(state).map(t => t.id)).toEqual(['trade1']);
    const view = summarizeEntry(state, state.entries[0], { symbol: '005930', time: 1005, asks: [], bids: [{ price: 1050, qty: 100 }], last: 1050, totalAsk: 0, totalBid: 0 }, 1005);
    expect(view.lots).toHaveLength(2); expect(view.averageEntry).toBeCloseTo(3020 / 3);
    expect(view.remaining).toBe(2); expect(view.sold).toBe(1); expect(view.pending).toBe(0);
    expect(view.net).toBe(97); expect(view.cost).toBe(3); expect(view.unrealized).toBe(80);
    expect(view.averageExit).toBe(1100); expect(view.status).toBe('일부 청산');
    const other = summarizeEntry(state, state.entries[1]); expect(other.net).toBe(0); expect(other.remaining).toBe(1);
  });
  it('does not calculate a mark-to-market using another stock or stale quotes', () => {
    const state = snapshot();
    const book = { symbol: '000660', time: 1005, asks: [], bids: [{ price: 99999, qty: 100 }], last: 99999, totalAsk: 0, totalBid: 0 };
    expect(summarizeEntry(state, state.entries[0], book, 1005).unrealized).toBeUndefined();
    expect(summarizeEntry(state, state.entries[0], { ...book, symbol: '005930' }, 20000).unrealized).toBeUndefined();
  });
  it('prevents another close click once a close has been requested', () => {
    const state = snapshot(); state.entries[0].closeRequested = true;
    const view = summarizeEntry(state, state.entries[0]); expect(view.canClose).toBe(false); expect(view.status).toBe('청산 진행 중');
  });
});
