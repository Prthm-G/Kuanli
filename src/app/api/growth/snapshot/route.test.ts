import { beforeEach, describe, expect, it, vi } from 'vitest';

import { snapshotBody } from '@/lib/growth/test-fixtures';
import { POST } from './route';

const h = vi.hoisted(() => ({ upsert: vi.fn() }));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ from: () => ({ upsert: h.upsert }) }),
}));

const req = (body: unknown, secret?: string) =>
  new Request('http://localhost/api/growth/snapshot', {
    method: 'POST',
    headers: secret ? { 'x-cron-secret': secret } : {},
    body: JSON.stringify(body),
  });

describe('POST /api/growth/snapshot', () => {
  beforeEach(() => {
    vi.stubEnv('GROWTH_SNAPSHOT_SECRET', 's3cret');
    h.upsert.mockResolvedValue({ error: null });
  });

  it('503 when the secret is not configured', async () => {
    vi.stubEnv('GROWTH_SNAPSHOT_SECRET', '');
    expect((await POST(req(snapshotBody(), 's3cret'))).status).toBe(503);
  });

  it('401 without the right secret, and nothing is written', async () => {
    expect((await POST(req(snapshotBody()))).status).toBe(401);
    expect((await POST(req(snapshotBody(), 'wrong'))).status).toBe(401);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('400 on an invalid snapshot', async () => {
    expect(
      (await POST(req(snapshotBody({ account_id: 'x' }), 's3cret'))).status
    ).toBe(400);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('upserts on (account_id, snapshot_date)', async () => {
    const body = snapshotBody();
    const res = await POST(req(body, 's3cret'));
    expect(res.status).toBe(200);
    expect(h.upsert).toHaveBeenCalledWith(
      {
        account_id: body.account_id,
        snapshot_date: '2026-10-14',
        payload: body.payload,
      },
      { onConflict: 'account_id,snapshot_date' }
    );
  });
});
