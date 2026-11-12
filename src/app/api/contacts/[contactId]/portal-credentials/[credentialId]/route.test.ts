import { beforeEach, describe, expect, it, vi } from 'vitest';

const CID = '80960000-0000-4000-8000-000000000001';
const KID = '80960000-0000-4000-8000-000000000002';

const h = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  updateError: null as { code?: string; message: string } | null,
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
    from: () => {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: { id: KID, label: 'L', account_id: 'acc1' } }),
        update: (u: Record<string, unknown>) => {
          h.updates.push(u);
          return b;
        },
        single: async () =>
          h.updateError
            ? { data: null, error: h.updateError }
            : { data: { id: KID, contact_id: CID, label: 'L', kind: 'registration' }, error: null },
      };
      return b;
    },
  }),
}));

import { PATCH } from './route';

const patch = async (body: unknown) =>
  (await PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), {
    params: Promise.resolve({ contactId: CID, credentialId: KID }),
  }))!;

beforeEach(() => {
  h.updates = [];
  h.updateError = null;
});

describe('PATCH portal-credentials/[id]', () => {
  it('changes the kind', async () => {
    const res = await patch({ kind: 'registration' });
    expect(res.status).toBe(200);
    expect(h.updates[0].kind).toBe('registration');
  });

  it('does not touch kind when it is not sent', async () => {
    await patch({ label: 'New' });
    expect('kind' in h.updates[0]).toBe(false);
  });

  it('rejects an unknown kind', async () => {
    expect((await patch({ kind: 'nope' })).status).toBe(400);
  });

  it('logs only the code and message of a database error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.updateError = {
      code: 'XX000',
      message: 'boom',
      details: 'Failing row contains (CIPHERTEXT-MARKER)',
    } as never;
    await patch({ label: 'x' });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain('XX000');
    expect(logged).not.toContain('CIPHERTEXT-MARKER');
    spy.mockRestore();
  });

  it('maps a duplicate to a friendly 409', async () => {
    h.updateError = { code: '23505', message: 'duplicate key' };
    const res = await patch({ kind: 'registration' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('This student already has a registration login');
  });
});
