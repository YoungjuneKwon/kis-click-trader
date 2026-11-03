import { readFile, writeFile, chmod } from 'node:fs/promises';
import { createDecipheriv } from 'node:crypto';
import WebSocket from 'ws';
import type { ServerConfig } from './config.js';

type Data = Record<string, unknown>;
type StringMap = Record<string, string>;
const reuseMs = 24 * 3600000;
export class KisService {
  private token = '';
  private issued = 0;
  private tokenTask?: Promise<string>;
  readonly rest: string;
  readonly ws: string;
  constructor(readonly config: ServerConfig, private http: typeof fetch = fetch) {
    this.rest = config.env === 'prod' ? 'https://openapi.koreainvestment.com:9443' : 'https://openapivts.koreainvestment.com:29443';
    this.ws = `ws://ops.koreainvestment.com:${config.env === 'prod' ? 21000 : 31000}`;
  }
  private async call(path: string, init: RequestInit): Promise<Data> {
    const response = await this.http(this.rest + path, { ...init, signal: AbortSignal.timeout(20000) });
    const data = await response.json().catch(() => ({})) as Data;
    if (!response.ok) throw new Error(`KIS upstream HTTP ${response.status}`);
    return data;
  }
  async accessToken(): Promise<string> {
    if (this.token && Date.now() - this.issued < reuseMs - 60000) return this.token;
    if (this.tokenTask) return this.tokenTask;
    this.tokenTask = (async () => {
      try {
        const state = JSON.parse(await readFile(this.config.tokenFile, 'utf8'));
        const issued = Date.parse(state.access_token_issued_at);
        if (state.access_token && issued <= Date.now() && Date.now() - issued < reuseMs - 60000 && (!state.account_tag || state.account_tag === this.config.accountTag)) {
          this.token = state.access_token; this.issued = issued; return this.token;
        }
      } catch { /* A missing or invalid cache is not an authentication failure. */ }
      const data = await this.call('/oauth2/tokenP', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', appkey: this.config.apiKey, appsecret: this.config.apiSecret }) });
      if (typeof data.access_token !== 'string') throw new Error('KIS token issuance failed');
      this.token = data.access_token; this.issued = Date.now();
      await writeFile(this.config.tokenFile, JSON.stringify({ access_token: this.token, access_token_issued_at: new Date(this.issued).toISOString(), account_tag: this.config.accountTag }), { mode: 0o600 });
      await chmod(this.config.tokenFile, 0o600);
      return this.token;
    })();
    try { return await this.tokenTask; } finally { this.tokenTask = undefined; }
  }
  private allowed(method: string, path: string, tr: string) {
    const p = this.config.env === 'prod' ? 'TTTC' : 'VTTC';
    const routes: Record<string, string[]> = {
      'GET /uapi/domestic-stock/v1/quotations/inquire-price': ['FHKST01010100'],
      'GET /uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn': ['FHKST01010200'],
      'GET /uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice': ['FHKST03010200'],
      'GET /uapi/domestic-stock/v1/trading/inquire-balance': [`${p}8434R`],
      'GET /uapi/domestic-stock/v1/trading/inquire-daily-ccld': [`${p}0081R`],
      'GET /uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl': this.config.env === 'prod' ? ['TTTC0084R'] : [],
      'POST /uapi/domestic-stock/v1/trading/order-cash': [`${p}0012U`, `${p}0011U`],
      'POST /uapi/domestic-stock/v1/trading/order-rvsecncl': [`${p}0013U`],
    };
    return routes[`${method} ${path}`]?.includes(tr);
  }
  async request(method: string, path: string, tr: string, input: StringMap, continuation = '') {
    if (!this.allowed(method, path, tr)) throw new Error('KIS route or transaction is not allowed');
    const fields = { ...input };
    if (path.includes('/trading/')) { fields.CANO = this.config.cano; fields.ACNT_PRDT_CD = this.config.product; }
    for (const key of ['appkey', 'appsecret', 'authorization', 'access_token']) delete fields[key];
    const headers: StringMap = { authorization: `Bearer ${await this.accessToken()}`, appkey: this.config.apiKey, appsecret: this.config.apiSecret, tr_id: tr, custtype: 'P', tr_cont: continuation };
    if (method === 'POST') {
      const hash = await this.call('/uapi/hashkey', { method: 'POST', headers: { appkey: this.config.apiKey, appsecret: this.config.apiSecret, 'content-type': 'application/json' }, body: JSON.stringify(fields) });
      if (typeof hash.HASH !== 'string') throw new Error('KIS order hash generation failed');
      headers.hashkey = hash.HASH; headers['content-type'] = 'application/json';
    }
    // Order POSTs are deliberately never retried after an ambiguous network failure.
    return this.call(path + (method === 'GET' ? '?' + new URLSearchParams(fields) : ''), { method, headers, ...(method === 'POST' ? { body: JSON.stringify(fields) } : {}) });
  }
  async approval(): Promise<string> {
    const data = await this.call('/oauth2/Approval', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', appkey: this.config.apiKey, secretkey: this.config.apiSecret }) });
    if (typeof data.approval_key !== 'string') throw new Error('KIS WebSocket approval failed');
    return data.approval_key;
  }
  bridge(client: WebSocket, symbol: string) {
    let upstream: WebSocket | undefined;
    let closed = false;
    let aes: { key: string; iv: string } | undefined;
    const noticeId = this.config.env === 'prod' ? 'H0STCNI0' : 'H0STCNI9';
    const send = (data: Data) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data)); };
    const close = () => { closed = true; upstream?.close(); };
    client.on('close', close); client.on('error', close);
    void this.approval().then(approval => {
      if (closed) return;
      upstream = new WebSocket(this.ws, { handshakeTimeout: 15000 });
      upstream.on('open', () => {
        const subscriptions = [['H0STASP0', symbol], ['H0STCNT0', symbol]];
        if (this.config.htsId) subscriptions.push([noticeId, this.config.htsId]);
        for (const [tr_id, tr_key] of subscriptions) upstream!.send(JSON.stringify({ header: { approval_key: approval, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' }, body: { input: { tr_id, tr_key } } }));
        send({ type: 'fill-mode', mode: 'polling' });
      });
      upstream.on('message', buffer => {
        try {
          const raw = buffer.toString();
          if (raw.startsWith('{')) {
            const message = JSON.parse(raw); const tr = message.header?.tr_id;
            if (tr === 'PINGPONG') { upstream!.send(raw); return; }
            if (message.body?.rt_cd && message.body.rt_cd !== '0') {
              if (tr === noticeId) { aes = undefined; send({ type: 'fill-mode', mode: 'polling', detail: '계좌 체결통보 구독 실패 · REST 조회로 확인합니다.' }); }
              else { send({ type: 'error', message: 'KIS 시세 구독이 거절되었습니다.' }); upstream!.close(); }
              return;
            }
            if (tr === noticeId && message.body?.output?.key && message.body?.output?.iv) { aes = message.body.output; send({ type: 'fill-mode', mode: 'realtime' }); }
            return; // Never forward acknowledgements containing AES keys or account identifiers.
          }
          const tr = raw.split('|', 3)[1];
          if (tr === 'H0STASP0' || tr === 'H0STCNT0') send({ type: 'market', data: raw });
          else if (tr === noticeId && aes) {
            const decipher = createDecipheriv('aes-256-cbc', Buffer.from(aes.key), Buffer.from(aes.iv));
            decipher.update(Buffer.from(raw.split('|')[3], 'base64')); decipher.final();
            send({ type: 'fills-changed' });
          }
        } catch { aes = undefined; send({ type: 'fill-mode', mode: 'polling', detail: '체결통보 해석 실패 · REST 조회로 확인합니다.' }); }
      });
      upstream.on('ping', data => upstream?.pong(data));
      upstream.on('error', () => { send({ type: 'error', message: 'KIS WebSocket 연결에 실패했습니다.' }); client.close(1011); });
      upstream.on('close', () => { if (!closed) client.close(1012, 'KIS connection closed'); });
    }).catch(() => { send({ type: 'error', message: 'KIS WebSocket 접속키를 발급받지 못했습니다.' }); client.close(1011); });
    return close;
  }
}
