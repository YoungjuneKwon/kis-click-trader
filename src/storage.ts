import { openDB, type IDBPDatabase } from 'idb';
import { defaultRule, ruleSchema, symbols, type Rule, type Snapshot, type SymbolInfo } from './model';

let dbPromise: Promise<IDBPDatabase> | undefined;
const database = () => dbPromise ??= openDB('click-trader', 1, { upgrade(db) { db.createObjectStore('sessions', { keyPath: 'id' }); } });
export async function clearClientSecrets() {
  const db = await database();
  // Migrate earlier releases: credentials now belong exclusively to the server.
  for (const store of ['vault', 'tokens']) if (db.objectStoreNames.contains(store)) await db.clear(store);
}
export async function saveSnapshot(snapshot: Snapshot) { await (await database()).put('sessions', structuredClone(snapshot)); }
export async function sessions(): Promise<Snapshot[]> { return (await (await database()).getAll('sessions')).sort((a, b) => b.started - a.started); }
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
