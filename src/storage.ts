import { openDB, type IDBPDatabase } from 'idb';
import { defaultRule, ruleSchema, symbols, type Rule, type Snapshot, type SymbolInfo } from './model';

let dbPromise: Promise<IDBPDatabase> | undefined;
const database = () => dbPromise ??= openDB('click-trader', 1, { upgrade(db) { db.createObjectStore('sessions', { keyPath: 'id' }); } });
export async function clearClientSecrets() {
  const db = await database();
  // Migrate earlier releases: credentials now belong exclusively to the server.
  for (const store of ['vault', 'tokens']) if (db.objectStoreNames.contains(store)) await db.clear(store);
}
export async function saveSnapshot(snapshot: Snapshot) { await (await database()).put('sessions', { ...structuredClone(snapshot), updatedAt: Date.now() }); }
export async function sessions(): Promise<Snapshot[]> { return (await (await database()).getAll('sessions')).sort((a, b) => b.started - a.started); }
export function sessionToRestore(history: Snapshot[], accountTag: string, now = Date.now()) {
  const matches = history.filter(s => s.kind === 'kis' && s.accountTag === accountTag).sort((a, b) => (b.updatedAt || b.started) - (a.updatedAt || a.started));
  const day = (stamp: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(stamp);
  const exposed = (s: Snapshot) => s.entries.some(e => e.state !== 'done') || s.lots.some(l => l.state !== 'closed');
  const previousDayOpen = matches.find(s => day(s.started) !== day(now) && exposed(s));
  if (previousDayOpen) return previousDayOpen; // caller requires manual reconciliation before proceeding
  const today = matches.filter(s => s.entries.length > 0 && day(s.started) === day(now));
  if (!today.length) return undefined;
  const unique = <T extends { id: string }>(lists: T[][]) => {
    const map = new Map<string, T>();
    for (const list of lists) for (const item of list) if (!map.has(item.id)) map.set(item.id, item);
    return [...map.values()];
  };
  const lots = unique(today.map(s => s.lots));
  const entryTime = (id: string) => lots.find(l => l.entryId === id)?.opened || today.find(s => s.entries.some(e => e.id === id))!.started;
  const primary = today.find(exposed) || today[0];
  return {
    ...primary,
    started: Math.min(...today.map(s => s.started)),
    entries: unique(today.map(s => s.entries)).sort((a, b) => (a.createdAt || entryTime(a.id)) - (b.createdAt || entryTime(b.id))),
    lots,
    trades: unique(today.map(s => s.trades)).sort((a, b) => a.time - b.time),
    logs: unique(today.map(s => s.logs)).sort((a, b) => b.time - a.time).slice(0, 150),
  };
}
export type Preferences = { selected?: SymbolInfo; quantity: number; rule: Rule };
export function loadPreferences(): Preferences {
  try {
    const p = JSON.parse(localStorage.getItem('click-trader.preferences') || '{}');
    const selected = p.symbolConfirmed === true && /^\d{6}$/.test(p.symbol)
      ? symbols.find(s => s.code === p.symbol) || { code: p.symbol, name: typeof p.symbolName === 'string' && p.symbolName.trim() ? p.symbolName.slice(0, 40) : p.symbol }
      : undefined;
    return { selected, quantity: Number.isInteger(p.quantity) && p.quantity > 0 ? Math.min(p.quantity, 100000) : 1, rule: ruleSchema.safeParse(p.rule).success ? p.rule : defaultRule };
  } catch { return { quantity: 1, rule: defaultRule }; }
}
export function savePreferences(value: Preferences) { localStorage.setItem('click-trader.preferences', JSON.stringify({ symbol: value.selected?.code, symbolName: value.selected?.name, symbolConfirmed: !!value.selected, quantity: value.quantity, rule: value.rule })); }
