import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverStatus, unlockServer } from './api';
afterEach(() => vi.unstubAllGlobals());
describe('screen unlock transport', () => {
  it('does not submit a password when only static hosting is present', async () => {
    const http = vi.fn(async (_url: string) => new Response('<html>static page</html>'));
    vi.stubGlobal('fetch', http);
    await expect(unlockServer('test-password')).rejects.toThrow('Node.js');
    expect(http).toHaveBeenCalledTimes(1); expect(http.mock.calls[0][0]).toBe('/api/status');
  });
  it('restores authenticated metadata without receiving API credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ backend: true, authenticated: true, env: 'prod', accountTag: 'a'.repeat(64), realtimeFillsConfigured: true }))));
    const status = await serverStatus(); expect(status?.authenticated).toBe(true);
    expect(status).not.toHaveProperty('apiKey'); expect(status).not.toHaveProperty('apiSecret');
  });
});
