import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  insertError: null as { code?: string; message: string } | null,
}));

vi.mock('@/lib/auth/account', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account');
  return {
    ...actual,
    requireRole: async () => ({
      accountId: 'acc1',
      userId: 'u1',
      role: 'agent',
      supabase: {
        from: () => {
          const b = {
            select: () => b,
            eq: () => b,
            maybeSingle: async () => ({ data: { id: CID, account_id: 'acc1' }, error: null }),
          };
          return b;
        },
      },
    }),
  };
});

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        h.inserted.push(row);
        const b = {
          select: () => b,
          single: async () =>
            h.insertError
              ? { data: null, error: h.insertError }
              : {
                  data: { id: 'c1', contact_id: CID, label: row.label, kind: row.kind },
                  error: null,
                },
        };
        return b;
      },
    }),
  }),
}));

const CID = '80960000-0000-4000-8000-000000000001';

import { POST } from './route';

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ contactId: CID }) },
  );

beforeEach(() => {
  h.inserted = [];
  h.insertError = null;
});

describe('POST portal-credentials', () => {
  it('stores kind other when none is sent', async () => {
    const res = await post({ label: 'L', password: 'pw' });
    expect(res.status).toBe(201);
    expect(h.inserted[0].kind).toBe('other');
  });

  it('stores the chosen kind and returns it', async () => {
    const res = await post({ label: 'L', password: 'pw', kind: 'provisional' });
    expect(h.inserted[0].kind).toBe('provisional');
    expect((await res.json()).credential.kind).toBe('provisional');
  });

  it('rejects an unknown kind', async () => {
    expect((await post({ label: 'L', password: 'pw', kind: 'x' })).status).toBe(400);
    expect(h.inserted).toHaveLength(0);
  });

  it('turns a duplicate provisional login into a friendly 409', async () => {
    h.insertError = { code: '23505', message: 'duplicate key' };
    const res = await post({ label: 'L', password: 'pw', kind: 'provisional' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('This student already has a provisional login');
  });

  it('keeps other insert failures as 500', async () => {
    h.insertError = { code: 'XX000', message: 'boom' };
    expect((await post({ label: 'L', password: 'pw' })).status).toBe(500);
  });
});
