import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPreferences, savePreferences } from './storage';
import { defaultRule } from './model';

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
