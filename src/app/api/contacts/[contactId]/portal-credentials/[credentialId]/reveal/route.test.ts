import { beforeEach, describe, expect, it, vi } from 'vitest';

const CID = '80960000-0000-4000-8000-000000000001';
const KID = '80960000-0000-4000-8000-000000000002';

const h = vi.hoisted(() => ({
  role: 'agent' as 'agent' | 'viewer',
  audits: [] as Array<Record<string, unknown>>,
  auditError: null as { message: string } | null,
  contactVisible: true,
  limited: false,
  lastKey: '',
  lastOpts: null as unknown,
}));

vi.mock('@/lib/auth/account', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account');
  return {
    ...actual,
    requireRole: async (min: string) => {
      if (h.role === 'viewer' && min === 'agent') throw new actual.ForbiddenError();
      return {
        accountId: 'acc1',
        userId: 'u1',
        role: h.role,
        supabase: {
          from: () => {
            const b = {
              select: () => b,
              eq: () => b,
              maybeSingle: async () => ({
                data: h.contactVisible ? { id: CID, account_id: 'acc1' } : null,
              }),
            };
            return b;
          },
        },
      };
    },
  };
});

vi.mock('@/lib/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rate-limit')>('@/lib/rate-limit');
  return {
    ...actual,
    checkRateLimit: (key: string, opts: unknown) => {
      h.lastKey = key;
      h.lastOpts = opts;
      return h.limited
        ? { success: false, limit: 10, remaining: 0, reset: Date.now() + 1000 }
        : { success: true, limit: 10, remaining: 9, reset: Date.now() + 1000 };
    },
  };
});

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-secret',
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'student_portal_credential_reveals') {
        return {
          insert: async (row: Record<string, unknown>) => {
            h.audits.push(row);
            return { error: h.auditError };
          },
        };
      }
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({
          data: { id: KID, label: 'L', account_id: 'acc1', password_ciphertext: 'ct' },
        }),
      };
      return b;
    },
  }),
}));

import { RATE_LIMITS } from '@/lib/rate-limit';
import { POST } from './route';

const post = () =>
  POST(new Request('http://localhost/x', { method: 'POST' }), {
    params: Promise.resolve({ contactId: CID, credentialId: KID }),
  });

beforeEach(() => {
  h.role = 'agent';
  h.audits = [];
  h.auditError = null;
  h.contactVisible = true;
  h.limited = false;
});

describe('POST reveal', () => {
  it('returns the password uncached and writes one audit row', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await res.json()).password).toBe('plain-secret');
    expect(h.audits).toHaveLength(1);
  });

  it('keeps the existing per-user limit, with no new cap', async () => {
    await post();
    expect(h.lastKey).toBe('credential-reveal:u1');
    expect(h.lastOpts).toBe(RATE_LIMITS.credentialReveal);
    expect(RATE_LIMITS.credentialReveal).toEqual({ limit: 10, windowMs: 60_000 });
  });

  it('answers 429 uncached when over the limit, with no audit row', async () => {
    h.limited = true;
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(h.audits).toHaveLength(0);
  });

  it('is refused for a viewer', async () => {
    h.role = 'viewer';
    expect((await post()).status).toBe(403);
    expect(h.audits).toHaveLength(0);
  });

  it('shows nothing when the audit row cannot be written, still uncached', async () => {
    h.auditError = { message: 'denied' };
    const res = await post();
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(await res.json())).not.toContain('plain-secret');
  });

  it('404s when the contact is not visible to the caller, uncached', async () => {
    h.contactVisible = false;
    const res = await post();
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
