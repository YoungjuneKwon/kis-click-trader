import { openDB, type IDBPDatabase } from 'idb';
import { credentialsSchema, defaultRule, ruleSchema, type Credentials, type Rule, type Snapshot } from './model';

let dbPromise: Promise<IDBPDatabase> | undefined;
const database = () => dbPromise ??= openDB('click-trader', 1, { upgrade(db) { db.createObjectStore('vault'); db.createObjectStore('sessions', { keyPath: 'id' }); db.createObjectStore('tokens'); } });
const encoder = new TextEncoder();
async function key(password: string, salt: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function saveCredentials(value: Credentials, password: string) {
  if (password.length < 8) throw new Error('저장 암호를 8자 이상 입력해 주세요.');
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(password, salt), encoder.encode(JSON.stringify(credentialsSchema.parse(value))));
  await (await database()).put('vault', { salt, iv, ciphertext }, 'credentials');
}
export async function unlockCredentials(password: string): Promise<Credentials> {
  const saved = await (await database()).get('vault', 'credentials');
  if (!saved) throw new Error('저장된 키가 없습니다.');
  try { const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: saved.iv }, await key(password, saved.salt), saved.ciphertext); return credentialsSchema.parse(JSON.parse(new TextDecoder().decode(bytes))); }
  catch { throw new Error('저장 암호가 올바르지 않거나 저장 데이터가 손상되었습니다.'); }
}
export async function hasCredentials() { return !!await (await database()).get('vault', 'credentials'); }
export async function deleteCredentials() { const db = await database(); await db.delete('vault', 'credentials'); await db.clear('tokens'); }
export async function saveSnapshot(snapshot: Snapshot) { await (await database()).put('sessions', structuredClone(snapshot)); }
export async function sessions(): Promise<Snapshot[]> { return (await (await database()).getAll('sessions')).sort((a, b) => b.started - a.started); }
// Tokens are runtime secrets: persist encrypted under an app-key-derived key, never localStorage.
export async function cachedToken(account: string, secret: string): Promise<{ token: string; issued: number } | undefined> {
  const saved = await (await database()).get('tokens', account); if (!saved) return;
  try { const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: saved.iv }, await key(secret, saved.salt), saved.ciphertext); return JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
}
export async function storeToken(account: string, secret: string, value: { token: string; issued: number }) {
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret, salt), encoder.encode(JSON.stringify(value)));
  await (await database()).put('tokens', { salt, iv, ciphertext }, account);
}
export function loadPreferences(): { symbol: string; quantity: number; rule: Rule } {
  try { const p = JSON.parse(localStorage.getItem('click-trader.preferences') || '{}'); return { symbol: /^\d{6}$/.test(p.symbol) ? p.symbol : '005930', quantity: Number.isInteger(p.quantity) && p.quantity > 0 ? p.quantity : 1, rule: ruleSchema.safeParse(p.rule).success ? p.rule : defaultRule }; }
  catch { return { symbol: '005930', quantity: 1, rule: defaultRule }; }
}
export function savePreferences(value: ReturnType<typeof loadPreferences>) { localStorage.setItem('click-trader.preferences', JSON.stringify(value)); }
