import { memo } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { clock, signed, won, type Trade } from './model';

type Props = { trades: Trade[]; started: number; now: number };
function PerformanceChart({ trades, started, now }: Props) {
  const data = [{ time: started, net: 0 }];
  let sum = 0;
  for (const trade of trades) { sum += trade.net; data.push({ time: trade.time, net: sum }); }
  data.push({ time: now, net: sum });
  return <div className="pnl-chart" aria-label="세션 누적 실현손익 선 그래프">
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 18, right: 12, bottom: 2, left: 0 }}>
        <CartesianGrid vertical={false} stroke="#edf0f3" strokeDasharray="3 5" />
        <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={v => new Date(v).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' })} tick={{ fontSize: 10, fill: '#9299a4' }} axisLine={false} tickLine={false} minTickGap={45} />
        <YAxis width={52} domain={([min, max]) => [Math.min(min - 100, -100), Math.max(max + 100, 100)]} tickFormatter={v => won(v)} tick={{ fontSize: 10, fill: '#9299a4' }} axisLine={false} tickLine={false} />
        <ReferenceLine y={0} stroke="#cdd5df" />
        <Tooltip labelFormatter={v => clock(Number(v))} formatter={v => [`${signed(Number(v))}원`, '순실현손익']} contentStyle={{ borderRadius: 10, border: '1px solid #e7ebef', fontSize: 12 }} />
        <Line type="stepAfter" dataKey="net" stroke={sum < 0 ? '#4379dc' : '#188b71'} strokeWidth={2.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
    {!trades.length && <div className="chart-empty"><span>첫 청산이 기록되면</span><strong>수익의 흐름이 시작됩니다.</strong></div>}
  </div>;
}
export default memo(PerformanceChart, (a, b) => a.started === b.started && a.now === b.now && a.trades.length === b.trades.length && a.trades.at(-1)?.id === b.trades.at(-1)?.id);
