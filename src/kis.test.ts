import { afterEach, describe, expect, it, vi } from 'vitest';
import { KisBroker } from './kis';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('entry-specific order changes', () => {
  it('cancels only the original buy order of the matching stock', async () => {
    const posts: Record<string, string>[] = [];
    const http = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'GET') {
        const query = new URL(url, 'http://localhost').searchParams;
        expect(query.get('INQR_DVSN_2')).toBe('2');
        return new Response(JSON.stringify({ output: [
          { odno: '999', pdno: '005930', psbl_qty: '100', krx_fwdg_ord_orgno: '1' },
          { odno: '123', pdno: '005930', psbl_qty: '2', krx_fwdg_ord_orgno: '2' },
        ] }));
      }
      posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ rt_cd: '0', output: { ODNO: '456', KRX_FWDG_ORD_ORGNO: '2' } }));
    });
    vi.stubGlobal('fetch', http);
    const broker = new KisBroker('prod');
    await expect(broker.cancelBuy({ id: '123', branch: '1' }, '005930')).resolves.toEqual({ id: '456', branch: '2' });
    expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ ORGN_ODNO: '123', RVSE_CNCL_DVSN_CD: '02', ORD_QTY: '0', QTY_ALL_ORD_YN: 'Y' });
    expect(posts[0]).not.toHaveProperty('CANO'); expect(posts[0]).not.toHaveProperty('appkey');
  });
  it('does not revise a matching order number for a different stock', async () => {
    const http = vi.fn(async () => new Response(JSON.stringify({ output: [{ odno: '123', pdno: '000660', psbl_qty: '10' }] })));
    vi.stubGlobal('fetch', http);
    expect(await new KisBroker('prod').revise({ id: '123', branch: '1' }, '005930', 1, 1000)).toBeNull();
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('pages backward through actual minute bars without querying future timestamps', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T10:00:00+09:00'));
    const hours: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      hours.push(new URL(url, 'http://localhost').searchParams.get('FID_INPUT_HOUR_1')!);
      const end = Date.parse(hours.length === 1 ? '2026-11-03T10:00:00+09:00' : '2026-11-03T09:30:00+09:00');
      const output2 = Array.from({ length: 30 }, (_, i) => {
        const time = new Date(end - i * 60000);
        const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(time).replaceAll(':', '');
        return { stck_bsop_date: '20261103', stck_cntg_hour: hour, stck_prpr: String(1000 + i) };
      });
      return new Response(JSON.stringify({ output2 }));
    }));
    const data = await new KisBroker('prod').minuteHistory('005930');
    expect(hours).toEqual(['100000', '093059']); expect(data).toHaveLength(60);
    expect(data[0].time).toBeLessThan(data.at(-1)!.time);
  });
});
