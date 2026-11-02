import { EventEmitter } from 'node:events';
import { createCipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { readConfig } from './config.js';
import { KisService } from './kis-service.js';

const state = vi.hoisted(() => ({ upstreams: [] as { emit: (type: string, data?: unknown) => void; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1;
    send = vi.fn(); close = vi.fn(); pong = vi.fn();
    constructor() { super(); state.upstreams.push(this); }
  } };
});
describe('server-side WebSocket credential isolation', () => {
  it('keeps approval and AES keys server-side and emits only market or fill events', async () => {
    state.upstreams = [];
    const config = readConfig({ KIS_API_KEY: 'server-test-key', KIS_API_SECRET: 'server-test-secret', KIS_CANO: '00000000', KIS_ACNT_PRDT_CD: '01', KIS_HTS_ID: 'server-test-id', CT_PW: 'server-test-password' });
    const service = new KisService(config, vi.fn(async () => new Response(JSON.stringify({ approval_key: 'private-test-approval' }))) as typeof fetch);
    const client = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn() });
    const stop = service.bridge(client as unknown as WebSocket, '005930');
    await vi.waitFor(() => expect(state.upstreams).toHaveLength(1));
    const upstream = state.upstreams[0]; upstream.emit('open');
    expect(upstream.send.mock.calls.some(([raw]) => JSON.parse(raw).body.input.tr_key === config.htsId)).toBe(true);
    const key = '0123456789abcdef0123456789abcdef', iv = '0123456789abcdef';
    upstream.emit('message', Buffer.from(JSON.stringify({ header: { tr_id: 'H0STCNI0' }, body: { rt_cd: '0', output: { key, iv } } })));
    upstream.emit('message', Buffer.from('0|H0STASP0|001|005930^test-market'));
    const cipher = createCipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(iv));
    const ciphertext = Buffer.concat([cipher.update('test-private-notice'), cipher.final()]).toString('base64');
    upstream.emit('message', Buffer.from(`1|H0STCNI0|001|${ciphertext}`));
    const sent = client.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(sent).toContainEqual({ type: 'fill-mode', mode: 'realtime' });
    expect(sent).toContainEqual({ type: 'fills-changed' });
    const wire = JSON.stringify(sent);
    for (const secret of [config.apiKey, config.apiSecret, config.htsId, config.password, key, iv, 'private-test-approval', 'test-private-notice']) expect(wire).not.toContain(secret);
    stop(); expect(upstream.close).toHaveBeenCalled();
  });
});
