import { serverStatus } from './api';
import { Rejected } from './engine';
import type { Book, Broker, OrderRef, OrderStatus } from './model';

type Row = Record<string, string>;
type ApiData = { rt_cd?: string; msg1?: string; msg_cd?: string; error?: string; output?: Row | Row[]; output1?: Row[]; ctx_area_fk100?: string; ctx_area_nk100?: string };
const date = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()).replaceAll('-', '');
const num = (value: unknown) => Number(value) || 0;
export function parseBook(payload: string): Book {
  const a = payload.split('^');
  if (a.length < 45 || !/^\d{6}$/.test(a[0])) throw new Error('호가 메시지 형식이 올바르지 않습니다.');
  return { symbol: a[0], time: Date.now(), asks: Array.from({ length: 10 }, (_, i) => ({ price: num(a[3 + i]), qty: num(a[23 + i]) })), bids: Array.from({ length: 10 }, (_, i) => ({ price: num(a[13 + i]), qty: num(a[33 + i]) })), last: 0, totalAsk: num(a[43]), totalBid: num(a[44]) };
}
export class KisBroker implements Broker {
  kind = 'kis' as const;
  private socket?: WebSocket;
  private stopped = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private marketReady = false;
  private realtimeFills = false;
  private detail = '';
  private quote = 0;
  constructor(private env: 'prod' | 'vps') {}
  get fillMode() { return this.realtimeFills ? 'realtime' : 'polling'; }
  get fillDetail() { return this.detail || (this.realtimeFills ? '계좌 실시간 체결통보 + REST 대조' : '체결 확인: REST 3초 간격 조회'); }
  private async request(path: string, tr: string, fields: Record<string, string>, post = false, continuation = ''): Promise<ApiData> {
    let response: Response;
    try {
      response = await fetch('/api/kis' + path + (post ? '' : '?' + new URLSearchParams(fields)), {
        method: post ? 'POST' : 'GET', credentials: 'same-origin', signal: AbortSignal.timeout(25000),
        headers: { 'x-kis-tr-id': tr, 'x-kis-tr-cont': continuation, ...(post ? { 'content-type': 'application/json' } : {}) },
        ...(post ? { body: JSON.stringify(fields) } : {}),
      });
    } catch { throw new Error('로컬 서버 요청이 시간초과되거나 연결이 끊겼습니다. 주문 결과를 확인해 주세요.'); }
    const data = await response.json().catch(() => ({})) as ApiData;
    if (response.status === 401) { window.dispatchEvent(new Event('click-trader:locked')); throw new Error('서버 화면 잠금을 다시 해제해 주세요.'); }
    if (!response.ok) throw new Error(data.error || `로컬 서버 HTTP ${response.status}`);
    if (data.rt_cd && data.rt_cd !== '0') throw new Rejected(`KIS ${data.msg_cd || ''}: ${data.msg1 || '요청 거절'}`);
    return data;
  }
  async connect(symbol: string, onBook: (book: Book) => void, onStatus: (status: string) => void, onFill: () => void) {
    clearTimeout(this.reconnect);
    if (this.socket) { this.socket.onclose = null; this.socket.close(); }
    this.marketReady = false; this.realtimeFills = false; this.detail = ''; this.quote = 0;
    this.stopped = false; onStatus('connecting');
    if (!await serverStatus()) throw new Error('먼저 화면 잠금을 해제해 주세요.');
    return new Promise<void>((resolve, reject) => {
      const socket = this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/stream?symbol=${symbol}`);
      const timeout = setTimeout(() => { reject(new Error('실제 KIS 호가 수신 시간초과')); socket.close(); }, 20000);
      let resolved = false;
      socket.onmessage = event => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === 'error') { reject(new Error(message.message || 'KIS 연결 실패')); socket.close(); return; }
          if (message.type === 'fill-mode') { this.realtimeFills = message.mode === 'realtime'; this.detail = message.detail || ''; return; }
          if (message.type === 'fills-changed') { onFill(); return; }
          if (message.type !== 'market') return;
          const [, tr, countText, payload] = String(message.data).split('|');
          const fields = payload.split('^'), count = Math.max(1, num(countText)), width = fields.length / count;
          if (!Number.isInteger(width)) throw new Error('시세 묶음 형식 오류');
          for (let i = 0; i < count; i++) {
            const record = fields.slice(i * width, (i + 1) * width);
            if (tr === 'H0STCNT0') this.quote = num(record[2]);
            if (tr === 'H0STASP0') {
              const book = parseBook(record.join('^')); book.last = this.quote; onBook(book);
              if (!this.marketReady) { this.marketReady = true; onStatus('connected'); onFill(); }
              if (!resolved) { resolved = true; clearTimeout(timeout); resolve(); }
            }
          }
        } catch { this.marketReady = false; onStatus('시세 해석 오류 · 다음 호가 수신 대기'); }
      };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('로컬 서버의 시세 연결에 실패했습니다.')); };
      socket.onclose = event => {
        clearTimeout(timeout); this.marketReady = false; this.realtimeFills = false; onStatus('disconnected');
        if (!resolved) reject(new Error('KIS 호가 연결이 완료되지 않았습니다.'));
        if (event.code === 1008) { window.dispatchEvent(new Event('click-trader:locked')); return; }
        if (!this.stopped && resolved) this.reconnect = setTimeout(() => { void this.connect(symbol, onBook, onStatus, onFill).catch(() => onStatus('재연결 실패 · 연결 버튼으로 재시도')); }, 3000);
      };
    });
  }
  private ref(data: ApiData): OrderRef { const row = data.output as Row; if (!row?.ODNO) throw new Error('주문번호 없는 응답: 주문 내역 확인 필요'); return { id: row.ODNO, branch: row.KRX_FWDG_ORD_ORGNO }; }
  async buy(symbol: string, qty: number) {
    if (!this.marketReady) throw new Rejected('실제 호가가 연결되지 않았습니다.');
    return this.ref(await this.request('/uapi/domestic-stock/v1/trading/order-cash', this.env === 'prod' ? 'TTTC0012U' : 'VTTC0012U', { PDNO: symbol, ORD_DVSN: '03', ORD_QTY: String(qty), ORD_UNPR: '0', EXCG_ID_DVSN_CD: 'KRX', SLL_TYPE: '', CNDT_PRIC: '' }, true));
  }
  async sell(symbol: string, qty: number, price: number) {
    return this.ref(await this.request('/uapi/domestic-stock/v1/trading/order-cash', this.env === 'prod' ? 'TTTC0011U' : 'VTTC0011U', { PDNO: symbol, ORD_DVSN: '00', ORD_QTY: String(qty), ORD_UNPR: String(price), EXCG_ID_DVSN_CD: 'KRX', SLL_TYPE: '', CNDT_PRIC: '' }, true));
  }
  async revise(ref: OrderRef, _symbol: string, qty: number, price: number) {
    if (this.env === 'vps') throw new Rejected('모의투자 정정가능조회 지원은 미검증입니다.');
    let fk = '', nk = ''; let row: Row | undefined;
    for (let page = 0; page < 20; page++) {
      const data = await this.request('/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl', 'TTTC0084R', { INQR_DVSN_1: '0', INQR_DVSN_2: '1', CTX_AREA_FK100: fk, CTX_AREA_NK100: nk }, false, page ? 'N' : '');
      row = (Array.isArray(data.output) ? data.output : []).find(r => num(r.odno) === num(ref.id));
      if (row) break; const next = data.ctx_area_nk100 || ''; if (!next || next === nk) break; fk = data.ctx_area_fk100 || ''; nk = next;
    }
    if (!row || num(row.psbl_qty) <= 0) return null;
    return this.ref(await this.request('/uapi/domestic-stock/v1/trading/order-rvsecncl', 'TTTC0013U', { KRX_FWDG_ORD_ORGNO: row.krx_fwdg_ord_orgno || ref.branch, ORGN_ODNO: ref.id, ORD_DVSN: '00', RVSE_CNCL_DVSN_CD: '01', ORD_QTY: String(Math.min(qty, num(row.psbl_qty))), ORD_UNPR: String(price), QTY_ALL_ORD_YN: 'N', EXCG_ID_DVSN_CD: 'KRX' }, true));
  }
  async status(ref: OrderRef, symbol: string): Promise<OrderStatus> {
    const data = await this.request('/uapi/domestic-stock/v1/trading/inquire-daily-ccld', this.env === 'prod' ? 'TTTC0081R' : 'VTTC0081R', { INQR_STRT_DT: date(), INQR_END_DT: date(), SLL_BUY_DVSN_CD: '00', PDNO: symbol, CCLD_DVSN: '00', INQR_DVSN: '00', INQR_DVSN_3: '00', ORD_GNO_BRNO: ref.branch, ODNO: ref.id, INQR_DVSN_1: '', CTX_AREA_FK100: '', CTX_AREA_NK100: '', EXCG_ID_DVSN_CD: 'KRX' });
    const row = data.output1?.find(r => num(r.odno) === num(ref.id));
    if (!row) throw new Error('주문 조회에 아직 반영되지 않았습니다. 자동 재주문하지 않고 다시 조회합니다.');
    return { filled: num(row.tot_ccld_qty), average: num(row.avg_prvs), remaining: num(row.rmn_qty), cancelled: row.cncl_yn === 'Y' };
  }
  async inventory(symbol: string) {
    const data = await this.request('/uapi/domestic-stock/v1/trading/inquire-balance', this.env === 'prod' ? 'TTTC8434R' : 'VTTC8434R', { AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02', UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00', CTX_AREA_FK100: '', CTX_AREA_NK100: '' });
    const row = data.output1?.find(r => r.pdno === symbol);
    if (!row && (data.ctx_area_nk100 || data.ctx_area_fk100)) throw new Error('잔고 연속조회가 필요한 계좌입니다. 수동 대조가 필요합니다.');
    return { qty: num(row?.hldg_qty), average: num(row?.pchs_avg_pric) };
  }
  disconnect() { this.stopped = true; clearTimeout(this.reconnect); this.socket?.close(); this.marketReady = false; this.realtimeFills = false; }
}
