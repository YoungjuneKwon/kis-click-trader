import { memo, useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { won, type MinuteBar } from './model';
import { intradaySeries, minuteLabel } from './intraday';

type Props = { bars: MinuteBar[]; loading: boolean; error: string; connected: boolean; now: number; onRefresh: () => void };
function IntradayChart({ bars, loading, error, connected, now, onRefresh }: Props) {
  const series = useMemo(() => intradaySeries(bars), [bars]);
  const latest = series.at(-1);
  const axisStep = Math.max(1, Math.ceil((series.length - 1) / 4));
  const axisTicks = series.filter((_, i) => i % axisStep === 0 || i === series.length - 1).map(bar => bar.time);
  return <section className="intraday-panel" aria-label="최근 30분 시세와 5MA 10MA">
    <div className="intraday-heading"><h3>최근 30분 시세</h3><button className="icon-button" aria-label="분봉 새로고침" disabled={loading || !connected} onClick={onRefresh}><RefreshCw size={12} /></button></div>
    <div className="intraday-legend"><span><i className="price-line" />종가</span><span><i className="ma5-line" />5MA</span><span><i className="ma10-line" />10MA</span><small>1분봉 기준</small></div>
    {series.length ? <>
      <div className="intraday-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={series} margin={{ top: 12, right: 3, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="#edf0f2" strokeDasharray="3 5" />
        <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} ticks={axisTicks} tickFormatter={minuteLabel} tick={{ fontSize: 9, fill: '#9ca3aa' }} tickLine={false} axisLine={false} minTickGap={28} />
        <YAxis width={54} domain={([min, max]) => [Math.floor(min - Math.max((max - min) * .1, 10)), Math.ceil(max + Math.max((max - min) * .1, 10))]} tickFormatter={v => won(v)} tick={{ fontSize: 9, fill: '#9ca3aa' }} tickLine={false} axisLine={false} tickCount={4} />
        <Tooltip labelFormatter={v => minuteLabel(Number(v))} formatter={(v, name) => [`${won(Number(v))}원`, name === 'price' ? '종가' : name === 'ma5' ? '5MA' : '10MA']} contentStyle={{ borderRadius: 8, border: '1px solid #e5e8eb', fontSize: 10 }} />
        <Line dataKey="price" stroke="#555e66" strokeWidth={1.7} dot={false} isAnimationActive={false} connectNulls={false} />
        <Line dataKey="ma5" stroke="#919aa2" strokeDasharray="5 3" strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls={false} />
        <Line dataKey="ma10" stroke="#b4bac0" strokeDasharray="2 3" strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls={false} />
      </LineChart></ResponsiveContainer></div>
      <p className="intraday-note">{minuteLabel(series[0].time)}–{minuteLabel(latest!.time)} · 실제 {series.length}개 분봉{!connected || now - latest!.time > 120000 ? ' · 마지막 수신 구간' : ''}</p>
      <p className="intraday-note">마지막 분봉은 진행 중일 수 있습니다. 데이터가 부족한 이평선은 표시하지 않습니다.</p>
    </> : <div className="intraday-empty">{loading ? 'KIS 실제 분봉을 불러오고 있습니다.' : connected ? '실제 분봉·체결 데이터 수신 대기' : '연결 후 실제 분봉과 이동평균선을 표시합니다.'}</div>}
    {error && <p className="intraday-error">과거 분봉을 불러오지 못해 접속 후 확보한 {series.length}개 분봉만 표시하고 있습니다. {error}</p>}
  </section>;
}
export default memo(IntradayChart);
