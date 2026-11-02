import { cachedToken, storeToken } from './storage';
import { Rejected } from './engine';
import type { Book, Broker, Credentials, OrderRef, OrderStatus } from './model';

type Row = Record<string, string>;
type ApiData = { rt_cd?: string; msg1?: string; msg_cd?: string; output?: Row | Row[]; output1?: Row[]; ctx_area_fk100?: string; ctx_area_nk100?: string; access_token?: string; approval_key?: string; HASH?: string };
const date = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()).replaceAll('-', '');
const num = (s: unknown) => Number(s) || 0;
export function parseBook(payload: string): Book {
  const a = payload.split('^');
  if (a.length < 45 || !/^\d{6}$/.test(a[0])) throw new Error('호가 메시지 형식이 올바르지 않습니다.');
  return { symbol: a[0], time: Date.now(), asks: Array.from({ length: 10 }, (_, i) => ({ price: num(a[3 + i]), qty: num(a[23 + i]) })), bids: Array.from({ length: 10 }, (_, i) => ({ price: num(a[13 + i]), qty: num(a[33 + i]) })), last: 0, totalAsk: num(a[43]), totalBid: num(a[44]) };
}
export class KisBroker implements Broker {
  kind = 'kis' as const;
  private token = '';
  private tokenIssued = 0;
  private socket?: WebSocket;
  private stopped = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private tokenPromise?: Promise<void>;
  private aes?: { key: string; iv: string };
  private lastBook?: Book;
  private quote = 0;
  private noticeReady = false;
  constructor(private c: Credentials) {}
  private get base() { return this.c.transport === 'relay' ? `/kis-api/${this.c.env}` : this.c.env === 'prod' ? 'https://openapi.koreainvestment.com:9443' : 'https://openapivts.koreainvestment.com:29443'; }
  private async fetchApi(path: string, init: RequestInit): Promise<ApiData> {
    let response: Response;
    try { response = await fetch(this.base + path, { ...init, signal: AbortSignal.timeout(15000), credentials: 'omit', referrerPolicy: 'no-referrer' }); }
    catch { throw new Error('KIS 연결 실패: CORS·네트워크·시간초과를 확인하세요. 정적 사이트 직접 연결이 제한되면 로컬 개발 릴레이가 필요합니다.'); }
    const data = await response.json().catch(() => ({})) as ApiData;
    if (data.rt_cd && data.rt_cd !== '0') throw new Rejected(`KIS ${data.msg_cd || ''}: ${data.msg1 || '요청 거절'}`);
    if (!response.ok) throw new Error(`KIS HTTP ${response.status}: 요청 결과 확인이 필요합니다.`);
    return data;
  }
  private async auth() {
    if (this.token && Date.now() - this.tokenIssued < 24 * 3600000 - 60000) return;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.c.env}:${this.c.appKey}`));
      const cacheId = Array.from(new Uint8Array(digest)).map(n => n.toString(16).padStart(2, '0')).join('');
      const cache = await cachedToken(cacheId, this.c.appSecret);
      if (cache && Date.now() >= cache.issued && Date.now() - cache.issued < 24 * 3600000 - 60000) { this.token = cache.token; this.tokenIssued = cache.issued; return; }
      const data = await this.fetchApi('/oauth2/tokenP', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', appkey: this.c.appKey, appsecret: this.c.appSecret }) });
      if (!data.access_token) throw new Error('접근 토큰을 발급받지 못했습니다.');
      this.token = data.access_token; this.tokenIssued = Date.now(); await storeToken(cacheId, this.c.appSecret, { token: this.token, issued: this.tokenIssued });
    })();
    try { await this.tokenPromise; } finally { this.tokenPromise = undefined; }
  }
  private async request(path: string, tr: string, body: Record<string, string>, post = false, continuation = '') {
    await this.auth();
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, appkey: this.c.appKey, appsecret: this.c.appSecret, tr_id: tr, custtype: 'P', tr_cont: continuation };
    if (post) {
      const hash = await this.fetchApi('/uapi/hashkey', { method: 'POST', headers: { 'content-type': 'application/json', appkey: this.c.appKey, appsecret: this.c.appSecret }, body: JSON.stringify(body) });
      if (!hash.HASH) throw new Error('주문 서명을 생성하지 못했습니다.');
      headers.hashkey = hash.HASH; headers['content-type'] = 'application/json';
    }
    return this.fetchApi(path + (post ? '' : '?' + new URLSearchParams(body)), { method: post ? 'POST' : 'GET', headers, ...(post ? { body: JSON.stringify(body) } : {}) });
  }
  async connect(symbol: string, onBook: (b: Book) => void, onStatus: (s: string) => void, onFill: () => void) {
    clearTimeout(this.reconnect);
    if (this.socket) { this.socket.onclose = null; this.socket.close(); }
    this.noticeReady = false;
    this.stopped = false; onStatus('connecting'); await this.auth();
    const approval = await this.fetchApi('/oauth2/Approval', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', appkey: this.c.appKey, secretkey: this.c.appSecret }) });
    if (!approval.approval_key) throw new Error('웹소켓 접속키 발급에 실패했습니다.');
    const direct = `ws://ops.koreainvestment.com:${this.c.env === 'prod' ? 21000 : 31000}`;
    if (this.c.transport === 'direct' && location.protocol === 'https:') throw new Error('KIS 공식 ws:// 주소는 HTTPS 정적 페이지에서 혼합 콘텐츠로 차단됩니다. 로컬 개발 릴레이를 사용해 주세요.');
    const url = this.c.transport === 'relay' ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/kis-ws-${this.c.env}` : direct;
    return new Promise<void>((resolve, reject) => {
      const socket = this.socket = new WebSocket(url);
      const timeout = setTimeout(() => { reject(new Error('WebSocket 구독 확인 시간초과')); socket.close(); }, 15000);
      let bookReady = false; let resolved = false;
      socket.onopen = () => {
        for (const [tr_id, tr_key] of [['H0STASP0', symbol], ['H0STCNT0', symbol], [this.c.env === 'prod' ? 'H0STCNI0' : 'H0STCNI9', this.c.htsId]]) socket.send(JSON.stringify({ header: { approval_key: approval.approval_key, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' }, body: { input: { tr_id, tr_key } } }));
      };
      socket.onmessage = event => { void (async () => {
        const raw = String(event.data);
        if (raw.startsWith('{')) {
          const msg = JSON.parse(raw);
          if (msg.header?.tr_id === 'PINGPONG') { socket.send(raw); return; }
          if (msg.body?.rt_cd && msg.body.rt_cd !== '0') { reject(new Error(`WebSocket 구독 거절: ${msg.body.msg1 || ''}`)); socket.close(); return; }
          if (msg.body?.output?.key && msg.body?.output?.iv) { this.aes = msg.body.output; this.noticeReady = true; }
        } else {
          const [, tr, countText, payload] = raw.split('|');
          const count = Math.max(1, num(countText));
          if (tr === 'H0STASP0' || tr === 'H0STCNT0') {
            const fields = payload.split('^'); const width = fields.length / count;
            if (!Number.isInteger(width)) throw new Error('시세 묶음 길이가 올바르지 않습니다.');
            for (let i = 0; i < count; i++) {
              const record = fields.slice(i * width, (i + 1) * width);
              if (tr === 'H0STASP0') { this.lastBook = parseBook(record.join('^')); this.lastBook.last = this.quote; onBook(this.lastBook); bookReady = true; }
              else this.quote = num(record[2]);
            }
          }
          if ((tr === 'H0STCNI0' || tr === 'H0STCNI9') && this.aes) {
            const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.aes.key), 'AES-CBC', false, ['decrypt']);
            const bytes = Uint8Array.from(atob(payload), c => c.charCodeAt(0));
            await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new TextEncoder().encode(this.aes.iv) }, key, bytes);
            // Treat notice as a wake-up; cumulative order query is authoritative and deduplicates.
            onFill();
          }
        }
        if (bookReady && this.noticeReady && !resolved) { resolved = true; clearTimeout(timeout); onStatus('connected'); resolve(); onFill(); }
      })().catch(() => onStatus('체결통보 해석 오류 · 주문 조회로 확인 중')); };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('KIS WebSocket 연결 실패')); };
      socket.onclose = () => {
        clearTimeout(timeout); this.noticeReady = false; onStatus('disconnected');
        if (!resolved) reject(new Error('웹소켓 구독이 완료되지 않았습니다.'));
        if (!this.stopped && resolved) this.reconnect = setTimeout(() => { void this.connect(symbol, onBook, onStatus, onFill).catch(() => onStatus('재연결 실패 · 연결 버튼으로 재시도')); }, 3000);
      };
    });
  }
  private account() { return { CANO: this.c.cano, ACNT_PRDT_CD: this.c.product }; }
  private ref(data: ApiData): OrderRef { const o = data.output as Row; if (!o?.ODNO) throw new Error('주문번호 없는 응답: 주문 내역 확인 필요'); return { id: o.ODNO, branch: o.KRX_FWDG_ORD_ORGNO }; }
  async buy(symbol: string, qty: number) {
    if (!this.noticeReady) throw new Rejected('계좌 체결통보가 연결되지 않았습니다.');
    return this.ref(await this.request('/uapi/domestic-stock/v1/trading/order-cash', this.c.env === 'prod' ? 'TTTC0012U' : 'VTTC0012U', { ...this.account(), PDNO: symbol, ORD_DVSN: '03', ORD_QTY: String(qty), ORD_UNPR: '0', EXCG_ID_DVSN_CD: 'KRX', SLL_TYPE: '', CNDT_PRIC: '' }, true));
  }
  async sell(symbol: string, qty: number, price: number) {
    return this.ref(await this.request('/uapi/domestic-stock/v1/trading/order-cash', this.c.env === 'prod' ? 'TTTC0011U' : 'VTTC0011U', { ...this.account(), PDNO: symbol, ORD_DVSN: '00', ORD_QTY: String(qty), ORD_UNPR: String(price), EXCG_ID_DVSN_CD: 'KRX', SLL_TYPE: '', CNDT_PRIC: '' }, true));
  }
  async revise(ref: OrderRef, _symbol: string, qty: number, price: number) {
    if (this.c.env === 'vps') throw new Rejected('모의투자 정정가능조회 지원을 검증하지 않았습니다. 데모 또는 실전 검증이 필요합니다.');
    let fk = '', nk = ''; let row: Row | undefined;
    for (let page = 0; page < 20; page++) {
      const data = await this.request('/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl', 'TTTC0084R', { ...this.account(), INQR_DVSN_1: '0', INQR_DVSN_2: '1', CTX_AREA_FK100: fk, CTX_AREA_NK100: nk }, false, page ? 'N' : '');
      row = (Array.isArray(data.output) ? data.output : []).find(r => num(r.odno) === num(ref.id));
      if (row) break; const next = data.ctx_area_nk100 || ''; if (!next || next === nk) break; fk = data.ctx_area_fk100 || ''; nk = next;
    }
    if (!row || num(row.psbl_qty) <= 0) return null;
    return this.ref(await this.request('/uapi/domestic-stock/v1/trading/order-rvsecncl', 'TTTC0013U', { ...this.account(), KRX_FWDG_ORD_ORGNO: row.krx_fwdg_ord_orgno || ref.branch, ORGN_ODNO: ref.id, ORD_DVSN: '00', RVSE_CNCL_DVSN_CD: '01', ORD_QTY: String(Math.min(qty, num(row.psbl_qty))), ORD_UNPR: String(price), QTY_ALL_ORD_YN: 'N', EXCG_ID_DVSN_CD: 'KRX' }, true));
  }
  async status(ref: OrderRef, symbol: string): Promise<OrderStatus> {
    const data = await this.request('/uapi/domestic-stock/v1/trading/inquire-daily-ccld', this.c.env === 'prod' ? 'TTTC0081R' : 'VTTC0081R', { ...this.account(), INQR_STRT_DT: date(), INQR_END_DT: date(), SLL_BUY_DVSN_CD: '00', PDNO: symbol, CCLD_DVSN: '00', INQR_DVSN: '00', INQR_DVSN_3: '00', ORD_GNO_BRNO: ref.branch, ODNO: ref.id, INQR_DVSN_1: '', CTX_AREA_FK100: '', CTX_AREA_NK100: '', EXCG_ID_DVSN_CD: 'KRX' });
    const row = data.output1?.find(r => num(r.odno) === num(ref.id));
    if (!row) throw new Error('주문 조회에 아직 반영되지 않았습니다. 자동 재주문하지 않고 다시 조회합니다.');
    return { filled: num(row.tot_ccld_qty), average: num(row.avg_prvs), remaining: num(row.rmn_qty), cancelled: row.cncl_yn === 'Y' };
  }
  async inventory(symbol: string) {
    const data = await this.request('/uapi/domestic-stock/v1/trading/inquire-balance', this.c.env === 'prod' ? 'TTTC8434R' : 'VTTC8434R', { ...this.account(), AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02', UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00', CTX_AREA_FK100: '', CTX_AREA_NK100: '' });
    const row = data.output1?.find(r => r.pdno === symbol);
    if (!row && (data.ctx_area_nk100 || data.ctx_area_fk100)) throw new Error('잔고 연속조회가 필요한 계좌입니다. 이 PoC에서 잔고 대조를 완료할 수 없습니다.');
    return { qty: num(row?.hldg_qty), average: num(row?.pchs_avg_pric) };
  }
  disconnect() { this.stopped = true; clearTimeout(this.reconnect); this.socket?.close(); this.noticeReady = false; }
}
