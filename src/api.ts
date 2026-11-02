import { serverSessionSchema, type ServerSession } from './model';

export async function serverStatus(): Promise<ServerSession | undefined> {
  let data;
  try {
    const response = await fetch('/api/status', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    data = await response.json();
    if (data.backend !== true) throw new Error();
  } catch { throw new Error('Node.js 백엔드에 연결할 수 없습니다. 로컬에서 npm run serve로 실행해 주세요.'); }
  return data.authenticated ? serverSessionSchema.parse(data) : undefined;
}
export async function unlockServer(password: string): Promise<ServerSession> {
  // Do not POST a password to a static hosting service with no Node backend.
  await serverStatus();
  let response: Response;
  try { response = await fetch('/api/auth/unlock', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(10000) }); }
  catch { throw new Error('로컬 백엔드에 연결할 수 없습니다.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '화면 잠금을 해제하지 못했습니다.');
  return serverSessionSchema.parse(data);
}
export async function lockServer() {
  const response = await fetch('/api/auth/lock', { method: 'POST', credentials: 'same-origin' });
  if (!response.ok && response.status !== 401) throw new Error('서버 세션을 잠그지 못했습니다.');
}
