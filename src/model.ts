import { z } from 'zod';

export const credentialsSchema = z.object({
  appKey: z.string().trim().min(1, 'App Key를 입력해 주세요.'),
  appSecret: z.string().trim().min(1, 'App Secret을 입력해 주세요.'),
  cano: z.string().regex(/^\d{8}$/, '계좌번호 앞 8자리를 입력해 주세요.'),
  product: z.string().regex(/^\d{2}$/, '계좌 상품코드 2자리를 입력해 주세요.'),
  htsId: z.string().trim().min(1, '체결통보 구독용 HTS ID를 입력해 주세요.'),
  env: z.enum(['prod', 'vps']), transport: z.enum(['direct', 'relay']),
});
export type Credentials = z.infer<typeof credentialsSchema>;
export type SymbolInfo = { code: string; name: string };
export const symbols: SymbolInfo[] = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '035420', name: 'NAVER' },
  { code: '005380', name: '현대차' },
];
export type Book = { symbol: string; time: number; asks: { price: number; qty: number }[]; bids: { price: number; qty: number }[]; last: number; totalAsk: number; totalBid: number };
export type Rule = { unit: 'won' | 'percent'; take: number; stop: number; buyFee: number; sellFee: number; tax: number };
export const defaultRule: Rule = { unit: 'won', take: 500, stop: 300, buyFee: 0.015, sellFee: 0.015, tax: 0.2 };
export const ruleSchema = z.object({ unit: z.enum(['won', 'percent']), take: z.number().positive(), stop: z.number().positive(), buyFee: z.number().min(0).max(5), sellFee: z.number().min(0).max(5), tax: z.number().min(0).max(5) });
export type OrderRef = { id: string; branch: string };
export type OrderStatus = { filled: number; average: number; remaining: number; cancelled: boolean };
export interface Broker {
  kind: 'kis';
  connect(symbol: string, onBook: (book: Book) => void, onStatus: (status: string) => void, onFill: () => void): Promise<void>;
  buy(symbol: string, qty: number): Promise<OrderRef>;
  sell(symbol: string, qty: number, price: number): Promise<OrderRef>;
  revise(order: OrderRef, symbol: string, qty: number, price: number): Promise<OrderRef | null>;
  status(order: OrderRef, symbol: string): Promise<OrderStatus>;
  disconnect(): void;
}
export type Entry = { id: string; symbol: string; name: string; qty: number; filled: number; amount: number; ref?: OrderRef; state: 'sending' | 'open' | 'done' | 'unknown'; rule: Rule };
export type Lot = { id: string; entryId: string; symbol: string; name: string; qty: number; entry: number; target: number; stop: number; sold: number; exitAmount: number; state: 'protecting' | 'protected' | 'stopping' | 'closed' | 'unknown'; reason: '익절' | '손절' | '수동 청산'; ref?: OrderRef; seenFilled: number; seenAmount: number; rule: Rule; opened: number; exitLimit?: number; revisedAt?: number };
export type Trade = { id: string; lotId: string; symbol: string; name: string; qty: number; entry: number; exit: number; gross: number; cost: number; net: number; time: number; reason: string };
export type Log = { id: string; time: number; message: string; level: 'info' | 'error' };
export type Snapshot = { id: string; kind: 'kis'; accountTag: string; entries: Entry[]; lots: Lot[]; trades: Trade[]; logs: Log[]; started: number };
export function tickSize(price: number) { return price < 2000 ? 1 : price < 5000 ? 5 : price < 20000 ? 10 : price < 50000 ? 50 : price < 200000 ? 100 : price < 500000 ? 500 : 1000; }
export function targetPrice(entry: number, rule: Rule) { const raw = entry + (rule.unit === 'won' ? rule.take : entry * rule.take / 100); return Math.ceil(raw / tickSize(raw)) * tickSize(raw); }
export function stopPrice(entry: number, rule: Rule) { return Math.max(1, entry - (rule.unit === 'won' ? rule.stop : entry * rule.stop / 100)); }
export function aggressivePrice(bid: number) { const raw = bid * 0.995; return Math.max(1, Math.floor(raw / tickSize(raw)) * tickSize(raw)); }
export const won = (n: number) => Math.round(n).toLocaleString('ko-KR');
export const signed = (n: number) => `${n > 0 ? '+' : ''}${won(n)}`;
export const clock = (n: number) => new Date(n).toLocaleTimeString('ko-KR', { hour12: false });
export const uid = () => crypto.randomUUID();
