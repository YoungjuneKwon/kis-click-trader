import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from './config.js';
import { KisService } from './kis-service.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => JSON.stringify({ access_token: 'cached-test-token', access_token_issued_at: new Date().toISOString() })),
  writeFile: vi.fn(async () => {}), chmod: vi.fn(async () => {}),
}));
afterEach(() => vi.restoreAllMocks());
const config = readConfig({ KIS_API_KEY: 'server-test-key', KIS_API_SECRET: 'server-test-secret', KIS_CANO: '00000000', KIS_ACNT_PRDT_CD: '01', CT_PW: 'server-test-password' });
describe('KIS upstream relay', () => {
  it('reuses the existing token and injects server account and API credentials', async () => {
    const http = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/uapi/hashkey')) return new Response(JSON.stringify({ HASH: 'test-hash' }));
      const headers = init!.headers as Record<string, string>;
      expect(headers.appkey).toBe(config.apiKey); expect(headers.appsecret).toBe(config.apiSecret);
      expect(headers.authorization).toBe('Bearer cached-test-token');
      const body = JSON.parse(String(init!.body)); expect(body.CANO).toBe(config.cano); expect(body.ACNT_PRDT_CD).toBe(config.product);
      return new Response(JSON.stringify({ rt_cd: '0', output: { ODNO: '1' } }));
    });
    const service = new KisService(config, http as typeof fetch);
    await service.request('POST', '/uapi/domestic-stock/v1/trading/order-cash', 'TTTC0012U', { CANO: '99999999', PDNO: '005930', ORD_QTY: '1' });
    expect(http).toHaveBeenCalledTimes(2); expect(http.mock.calls.some(([url]) => String(url).includes('/oauth2/'))).toBe(false);
  });
  it('never retries an order POST when the upstream response is ambiguous', async () => {
    const http = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/uapi/hashkey')) return new Response(JSON.stringify({ HASH: 'test-hash' }));
      throw new Error('test network timeout');
    });
    const service = new KisService(config, http as typeof fetch);
    await expect(service.request('POST', '/uapi/domestic-stock/v1/trading/order-cash', 'TTTC0012U', { PDNO: '005930' })).rejects.toThrow();
    expect(http).toHaveBeenCalledTimes(2);
  });
  it('allows only known KIS paths and matching transaction identifiers', async () => {
    const http = vi.fn(); const service = new KisService(config, http);
    await expect(service.request('POST', '/oauth2/tokenP', 'TTTC0012U', {})).rejects.toThrow('not allowed');
    await expect(service.request('POST', '/uapi/domestic-stock/v1/trading/order-cash', 'OTHER', {})).rejects.toThrow('not allowed');
    expect(http).not.toHaveBeenCalled();
  });
});
