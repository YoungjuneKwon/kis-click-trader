import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPreferences, savePreferences, sessionToRestore } from './storage';
import { defaultRule, type Snapshot } from './model';

describe('explicit symbol selection', () => {
  let values: Map<string, string>;
  beforeEach(() => {
    values = new Map();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('does not select a stock on first use', () => {
    expect(loadPreferences().selected).toBeUndefined();
  });
  it('does not mistake the old automatic Samsung default for a user selection', () => {
    values.set('click-trader.preferences', JSON.stringify({ symbol: '005930', quantity: 5, rule: defaultRule }));
    const result = loadPreferences();
    expect(result.selected).toBeUndefined(); expect(result.quantity).toBe(5);
  });
  it('restores only an explicitly chosen symbol and can require selection again', () => {
    savePreferences({ selected: { code: '123456', name: '123456' }, quantity: 2, rule: defaultRule });
    expect(loadPreferences().selected).toEqual({ code: '123456', name: '123456' });
    savePreferences({ quantity: 2, rule: defaultRule });
    expect(loadPreferences().selected).toBeUndefined();
  });
});
describe('same-day screen trade history', () => {
  it('restores closed entries after reconnect instead of hiding them behind a newer empty session', () => {
    const now = Date.parse('2026-11-03T09:30:00+09:00');
    const closed: Snapshot = { id: 'recorded', kind: 'kis', accountTag: 'account', started: now - 600000, logs: [], trades: [], lots: [], entries: [{ id: 'entry', symbol: '005930', name: '삼성전자', qty: 1, filled: 1, amount: 1000, state: 'done', rule: defaultRule, ref: { id: '123', branch: '1' } }] };
    const empty = { ...closed, id: 'empty', started: now, entries: [] };
    expect(sessionToRestore([empty, closed], 'account', now)?.id).toBe('recorded');
    expect(sessionToRestore([empty, closed], 'other-account', now)).toBeUndefined();
    expect(sessionToRestore([closed], 'account', now + 86400000)).toBeUndefined();
  });
  it('combines separate screen sessions for the same day without counting fills twice', () => {
    const now = Date.parse('2026-11-03T09:30:00+09:00');
    const entry = { id: 'entry1', symbol: '005930', name: '삼성전자', qty: 1, filled: 1, amount: 1000, state: 'done' as const, rule: defaultRule, ref: { id: '123', branch: '1' } };
    const first: Snapshot = { id: 'first', kind: 'kis', accountTag: 'account', started: now - 600000, entries: [entry], lots: [], trades: [], logs: [] };
    const second: Snapshot = { ...first, id: 'second', started: now - 300000, entries: [{ ...entry, id: 'entry2', ref: { id: '124', branch: '1' } }] };
    const merged = sessionToRestore([second, first], 'account', now)!;
    expect(merged.entries.map(e => e.id)).toEqual(['entry1', 'entry2']);
    const saved = { ...merged, updatedAt: now };
    expect(sessionToRestore([saved, second, first], 'account', now)!.entries).toHaveLength(2);
  });
});
