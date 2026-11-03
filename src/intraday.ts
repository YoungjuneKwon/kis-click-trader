import type { MarketTick, MinuteBar } from './model';

export const minuteMs = 60000;
export function seoulTimestamp(day: string, hour: string) {
  if (!/^\d{8}$/.test(day) || !/^\d{6}$/.test(hour)) return undefined;
  const value = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${hour.slice(0, 2)}:${hour.slice(2, 4)}:${hour.slice(4, 6)}+09:00`);
  return Number.isFinite(value) ? value : undefined;
}
export function minuteFromTick(tick: MarketTick): MinuteBar {
  return { symbol: tick.symbol, time: Math.floor(tick.time / minuteMs) * minuteMs, close: tick.price, updatedAt: tick.time, source: 'live' };
}
export function minuteFromHistory(symbol: string, row: Record<string, string>, receivedAt = Date.now()): MinuteBar | undefined {
  const stamp = seoulTimestamp(row.stck_bsop_date, row.stck_cntg_hour), close = Number(row.stck_prpr);
  if (stamp === undefined || !Number.isFinite(close) || close <= 0) return undefined;
  const time = Math.floor(stamp / minuteMs) * minuteMs;
  return { symbol, time, close, updatedAt: time < Math.floor(receivedAt / minuteMs) * minuteMs ? time + minuteMs - 1 : time, source: 'history' };
}
export function mergeMinutes(previous: MinuteBar[], incoming: MinuteBar[], symbol: string) {
  const map = new Map(previous.filter(b => b.symbol === symbol).map(b => [b.time, b]));
  for (const bar of incoming) {
    if (bar.symbol !== symbol || !Number.isFinite(bar.close) || bar.close <= 0 || !Number.isFinite(bar.time)) continue;
    const current = map.get(bar.time);
    if (!current || bar.updatedAt >= current.updatedAt) map.set(bar.time, bar);
  }
  return [...map.values()].sort((a, b) => a.time - b.time).slice(-90);
}
export function intradaySeries(bars: MinuteBar[]) {
  if (!bars.length) return [];
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  const end = sorted.at(-1)!.time, start = end - 29 * minuteMs;
  return sorted.map((bar, index) => {
    const average = (n: number) => {
      if (index + 1 < n) return null;
      const window = sorted.slice(index + 1 - n, index + 1);
      if (window.some((b, i) => b.symbol !== bar.symbol || i > 0 && b.time - window[i - 1].time !== minuteMs)) return null;
      return window.reduce((sum, b) => sum + b.close, 0) / n;
    };
    return { time: bar.time, price: bar.close, ma5: average(5), ma10: average(10) };
  }).filter(bar => bar.time >= start);
}
export function seoulHour(time: number) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(time).replaceAll(':', '');
}
export function minuteLabel(time: number) {
  return new Date(time).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit' });
}
