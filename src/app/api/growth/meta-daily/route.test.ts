import { beforeEach, describe, expect, it, vi } from 'vitest';

import { metaDailyBody } from '@/lib/growth/test-fixtures';
import { MAX_META_DAILY_BYTES } from '@/lib/growth/meta-daily';
import { POST } from './route';

const h = vi.hoisted(() => ({ rpc: vi.fn(), catalog: vi.fn() }));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: (_c: string, v: string) => h.catalog(v) }) }),
    rpc: h.rpc,
  }),
}));

const ACCOUNT = '16cb2ac1-b074-4996-9a2e-260c123eabfe';
const req = (body: unknown, secret?: string) =>
  new Request('http://localhost/api/growth/meta-daily', {
    method: 'POST',
    headers: secret ? { 'x-cron-secret': secret } : {},
    body: JSON.stringify(body),
  });

describe('POST /api/growth/meta-daily', () => {
  beforeEach(() => {
    vi.stubEnv('GROWTH_SNAPSHOT_SECRET', 's3cret');
    h.catalog.mockResolvedValue({ data: [{ account_id: ACCOUNT }, { account_id: ACCOUNT }], error: null });
    h.rpc.mockResolvedValue({ data: 2, error: null });
  });

  it('503 when the secret is not configured', async () => {
    vi.stubEnv('GROWTH_SNAPSHOT_SECRET', '');
    expect((await POST(req(metaDailyBody(), 's3cret'))).status).toBe(503);
  });

  it('401 without the right secret, and nothing is read or written', async () => {
    expect((await POST(req(metaDailyBody()))).status).toBe(401);
    expect((await POST(req(metaDailyBody(), 'wrong'))).status).toBe(401);
    expect(h.catalog).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('400 on an invalid body', async () => {
    const res = await POST(req(metaDailyBody({ day: 'x' }), 's3cret'));
    expect(res.status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('422 when the ad account is not in the catalogue, or maps to two accounts', async () => {
    h.catalog.mockResolvedValueOnce({ data: [], error: null });
    expect((await POST(req(metaDailyBody(), 's3cret'))).status).toBe(422);
    h.catalog.mockResolvedValueOnce({ data: [{ account_id: ACCOUNT }, { account_id: 'other' }], error: null });
    expect((await POST(req(metaDailyBody(), 's3cret'))).status).toBe(422);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('replaces the day through the RPC', async () => {
    const body = metaDailyBody();
    const res = await POST(req(body, 's3cret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ad_account_id: '111111111', day: body.day, stored: 2 });
    expect(h.catalog).toHaveBeenCalledWith('111111111');
    const [fn, args] = h.rpc.mock.calls[0];
    expect(fn).toBe('meta_ad_daily_replace');
    expect(args).toMatchObject({ p_account: ACCOUNT, p_ad_account: '111111111', p_day: body.day, p_tz: 'America/Los_Angeles' });
    expect(args.p_rows).toHaveLength(2);
  });

  it('413 when content-length is over the cap, before reading the body', async () => {
    const r = new Request('http://localhost/api/growth/meta-daily', {
      method: 'POST',
      headers: { 'x-cron-secret': 's3cret', 'content-length': String(MAX_META_DAILY_BYTES + 1) },
      body: '{}',
    });
    expect((await POST(r)).status).toBe(413);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('500 when the RPC fails', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect((await POST(req(metaDailyBody(), 's3cret'))).status).toBe(500);
  });
});
