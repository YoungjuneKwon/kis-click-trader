import { describe, expect, it } from 'vitest';
import { intradaySeries, mergeMinutes, minuteFromHistory, minuteFromTick, minuteMs, seoulTimestamp } from './intraday';
import type { MinuteBar } from './model';

const start = Date.parse('2026-11-03T09:00:00+09:00');
function bars(count: number): MinuteBar[] {
  return Array.from({ length: count }, (_, i) => ({ symbol: '005930', time: start + i * minuteMs, close: 100 + i, updatedAt: start + i * minuteMs, source: 'history' }));
}
describe('real minute-series calculations', () => {
  it('displays only thirty minutes but uses earlier bars to warm up 5MA and 10MA', () => {
    const series = intradaySeries(bars(50));
    expect(series).toHaveLength(30); expect(series[0].time).toBe(start + 20 * minuteMs);
    expect(series[0].ma10).toBe(115.5); expect(series.at(-1)?.ma5).toBe(147); expect(series.at(-1)?.ma10).toBe(144.5);
  });
  it('updates a live minute with the latest actual trade and ignores older trades', () => {
    const first = minuteFromTick({ symbol: '005930', time: start + 10000, price: 1000 });
    const next = minuteFromTick({ symbol: '005930', time: start + 40000, price: 1020 });
    const late = minuteFromTick({ symbol: '005930', time: start + 20000, price: 999 });
    const result = mergeMinutes([first], [next, late], '005930');
    expect(result).toHaveLength(1); expect(result[0].close).toBe(1020);
  });
  it('does not fabricate missing minutes or moving averages across data gaps', () => {
    const source = bars(15).filter((_, i) => i !== 10);
    const series = intradaySeries(source);
    expect(series).toHaveLength(14); expect(series.at(-1)?.ma5).toBeNull(); expect(series.at(-1)?.ma10).toBeNull();
    expect(intradaySeries(bars(4)).at(-1)?.ma5).toBeNull();
  });
  it('keeps symbols isolated and accepts completed historical closes over partial live data', () => {
    const live = minuteFromTick({ symbol: '005930', time: start + 10000, price: 1000 });
    const history = minuteFromHistory('005930', { stck_bsop_date: '20261103', stck_cntg_hour: '090000', stck_prpr: '1010' }, start + 2 * minuteMs)!;
    const other = minuteFromTick({ symbol: '000660', time: start, price: 999999 });
    const result = mergeMinutes([live, other], [history], '005930');
    expect(result).toHaveLength(1); expect(result[0].close).toBe(1010);
    expect(minuteFromHistory('005930', { stck_bsop_date: '', stck_cntg_hour: '', stck_prpr: '0' })).toBeUndefined();
    expect(seoulTimestamp('20261103', '090000')).toBe(start);
  });
});
