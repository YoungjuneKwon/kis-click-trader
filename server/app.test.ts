import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import type { KisService } from './kis-service.js';

const config = readConfig({ KIS_API_KEY: 'server-test-key', KIS_API_SECRET: 'server-test-secret', KIS_CANO: '00000000', KIS_ACNT_PRDT_CD: '01', CT_PW: 'server-test-password' });
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup() {
  const request = vi.fn(async () => ({ rt_cd: '0', output1: [] }));
  const app = await createApp(config, { service: { request } as unknown as KisService }); apps.push(app); await app.ready();
  return { app, request };
}
describe('server-only credentials and screen authentication', () => {
  it('requires a configured screen password instead of a built-in default', () => {
    expect(() => readConfig({ KIS_API_KEY: 'k', KIS_API_SECRET: 's', KIS_CANO: '00000000', KIS_ACNT_PRDT_CD: '01' })).toThrow('CT_PW');
  });
  it('blocks KIS requests before unlock and never exposes server secrets in status', async () => {
    const { app, request } = await setup();
    const denied = await app.inject({ method: 'GET', url: '/api/kis/uapi/domestic-stock/v1/trading/inquire-balance', headers: { 'x-kis-tr-id': 'TTTC8434R' } });
    expect(denied.statusCode).toBe(401); expect(request).not.toHaveBeenCalled();
    const status = await app.inject('/api/status'); expect(status.json()).toEqual({ backend: true, authenticated: false });
    expect(status.body).not.toContain(config.apiKey); expect(status.body).not.toContain(config.password);
    await expect(app.injectWS('/api/stream?symbol=005930')).rejects.toThrow();
  });
  it('verifies the environment password, uses an HttpOnly cookie, and revokes it on lock', async () => {
    const { app, request } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/auth/unlock', payload: { password: 'wrong' } })).statusCode).toBe(401);
    const unlocked = await app.inject({ method: 'POST', url: '/api/auth/unlock', payload: { password: config.password } });
    expect(unlocked.statusCode).toBe(200); expect(unlocked.headers['set-cookie']).toContain('HttpOnly'); expect(unlocked.headers['set-cookie']).toContain('SameSite=Strict');
    expect(unlocked.body).not.toContain(config.apiKey); expect(unlocked.body).not.toContain(config.apiSecret); expect(unlocked.body).not.toContain(config.password);
    const cookie = unlocked.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const balance = await app.inject({ method: 'GET', url: '/api/kis/uapi/domestic-stock/v1/trading/inquire-balance?INQR_DVSN=02', headers: { cookie, 'x-kis-tr-id': 'TTTC8434R' } });
    expect(balance.statusCode).toBe(200); expect(request).toHaveBeenCalledTimes(1);
    await app.inject({ method: 'POST', url: '/api/auth/lock', headers: { cookie } });
    expect((await app.inject({ method: 'GET', url: '/api/status', headers: { cookie } })).json().authenticated).toBe(false);
  });
  it('rejects foreign origins and does not serve environment files', async () => {
    const { app } = await setup();
    const foreign = await app.inject({ method: 'POST', url: '/api/auth/unlock', headers: { origin: 'https://other.example' }, payload: { password: config.password } });
    expect(foreign.statusCode).toBe(403); expect((await app.inject('/.env')).statusCode).toBe(404);
  });
});
