import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { randomBytes, scryptSync, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type WebSocket from 'ws';
import type { ServerConfig } from './config.js';
import { KisService } from './kis-service.js';

const derive = promisify(scrypt);
const cookieName = 'ct_session';
const sessionMs = 8 * 3600000;
export async function createApp(config: ServerConfig, options: { service?: KisService; dist?: string } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 32768 });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 65536 } });
  const kis = options.service || new KisService(config);
  app.setErrorHandler((_error, _request, reply) => { void reply.code(400).send({ error: '요청을 처리하지 못했습니다.' }); });
  const sessions = new Map<string, { expires: number; sockets: Set<WebSocket> }>();
  const salt = randomBytes(16), passwordHash = scryptSync(config.password, salt, 32);
  const session = (id?: string) => { const value = id ? sessions.get(id) : undefined; return value && value.expires > Date.now() ? value : undefined; };
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && origin !== `${request.protocol}://${request.headers.host}`) return reply.code(403).send({ error: '동일 출처에서만 요청할 수 있습니다.' });
    if (request.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
      const path = request.url.split('?')[0];
      if (path !== '/api/status' && path !== '/api/auth/unlock' && !session(request.cookies[cookieName])) return reply.code(401).send({ error: '화면 잠금을 해제해 주세요.' });
    }
  });
  app.get('/api/status', async request => {
    const authenticated = !!session(request.cookies[cookieName]);
    return { backend: true, authenticated, ...(authenticated ? { env: config.env, accountTag: config.accountTag, realtimeFillsConfigured: !!config.htsId } : {}) };
  });
  app.post('/api/auth/unlock', async (request, reply) => {
    const password = (request.body as { password?: unknown })?.password;
    if (typeof password !== 'string' || password.length > 1024) return reply.code(400).send({ error: '암호를 입력해 주세요.' });
    const candidate = await derive(password, salt, 32) as Buffer;
    if (!timingSafeEqual(candidate, passwordHash)) return reply.code(401).send({ error: '화면 잠금 암호가 올바르지 않습니다.' });
    const old = request.cookies[cookieName];
    if (old) { for (const socket of sessions.get(old)?.sockets || []) socket.close(1008); sessions.delete(old); }
    const id = randomBytes(32).toString('hex');
    sessions.set(id, { expires: Date.now() + sessionMs, sockets: new Set() });
    reply.setCookie(cookieName, id, { path: '/', httpOnly: true, sameSite: 'strict', secure: request.protocol === 'https', maxAge: sessionMs / 1000 });
    return { authenticated: true, env: config.env, accountTag: config.accountTag, realtimeFillsConfigured: !!config.htsId };
  });
  app.post('/api/auth/lock', async (request, reply) => {
    const id = request.cookies[cookieName] || '';
    for (const socket of sessions.get(id)?.sockets || []) socket.close(1008, 'Screen locked');
    sessions.delete(id); reply.clearCookie(cookieName, { path: '/' }); return { authenticated: false };
  });
  app.route({ method: ['GET', 'POST'], url: '/api/kis/*', handler: async (request, reply) => {
    const path = '/' + (request.params as { '*': string })['*'];
    const tr = request.headers['x-kis-tr-id'];
    if (typeof tr !== 'string') return reply.code(400).send({ error: '거래 구분이 없습니다.' });
    const input = request.method === 'GET' ? request.query : request.body;
    if (!input || typeof input !== 'object' || Object.values(input).some(v => typeof v !== 'string')) return reply.code(400).send({ error: '잘못된 요청입니다.' });
    try { return await kis.request(request.method, path, tr, input as Record<string, string>); }
    catch { return reply.code(502).send({ error: request.method === 'GET' ? 'KIS 조회에 실패했습니다. 잠시 후 다시 조회해 주세요.' : 'KIS 주문 결과를 확인하지 못했습니다. 주문은 자동 재전송하지 않습니다.' }); }
  } });
  app.get('/api/stream', { websocket: true }, (socket, request) => {
    const symbol = (request.query as { symbol?: string }).symbol;
    const current = session(request.cookies[cookieName]);
    if (!current || !symbol || !/^\d{6}$/.test(symbol)) { socket.close(1008); return; }
    current.sockets.add(socket);
    const timer = setTimeout(() => socket.close(1008, 'Session expired'), current.expires - Date.now());
    const close = kis.bridge(socket, symbol);
    socket.on('close', () => { clearTimeout(timer); current.sockets.delete(socket); close(); });
  });
  const dist = options.dist || resolve(process.cwd(), 'dist');
  app.get('/*', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path.startsWith('/api/')) return reply.code(404).send({ error: 'Unknown API route' });
    const file = path === '/' || path === '/index.html' ? 'index.html' : /^\/assets\/[A-Za-z0-9._-]+\.(js|css|svg|woff2?)$/.test(path) ? path.slice(1) : undefined;
    if (!file) return reply.code(404).send('Not found');
    const absolute = resolve(dist, file);
    try { await stat(absolute); } catch { return reply.code(404).send('Build the frontend first: npm run build'); }
    const extension = file.split('.').at(-1)!;
    reply.type(({ html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', woff: 'font/woff', woff2: 'font/woff2' } as Record<string, string>)[extension]);
    reply.header('cache-control', file === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable');
    reply.header('x-content-type-options', 'nosniff'); reply.header('x-frame-options', 'DENY');
    return reply.send(createReadStream(absolute));
  });
  app.addHook('onClose', async () => { for (const value of sessions.values()) for (const socket of value.sockets) socket.close(); sessions.clear(); });
  return app;
}
