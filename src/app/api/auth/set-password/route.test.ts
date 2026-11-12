import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * First-login password step: only while must_change_password is set;
 * the password goes through the member's own session, then the flag is
 * cleared with the service role.
 */
const h = vi.hoisted(() => ({
  user: null as null | { id: string; app_metadata: Record<string, unknown> },
  updateUserError: null as null | { code: string; message: string },
  flagError: null as null | { message: string },
  calls: [] as string[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: h.user } }),
      updateUser: async (a: { password: string }) => {
        h.calls.push(`updateUser:${a.password}`);
        return { error: h.updateUserError };
      },
    },
  }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    auth: {
      admin: {
        updateUserById: async (id: string, a: { app_metadata: Record<string, unknown> }) => {
          h.calls.push(`clear:${id}:${JSON.stringify(a)}`);
          return { error: h.flagError };
        },
      },
    },
  }),
}));

import { POST } from './route';

let n = 0;
function post(body: unknown) {
  // A fresh user id per call keeps the per-user rate limit out of the way.
  if (h.user) h.user.id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  return POST(new Request('http://x/api/auth/set-password', { method: 'POST', body: JSON.stringify(body) }));
}

beforeEach(() => {
  h.user = { id: '', app_metadata: { must_change_password: true } };
  h.updateUserError = null;
  h.flagError = null;
  h.calls = [];
});

describe('POST /api/auth/set-password', () => {
  it('sets the password, then clears the flag', async () => {
    const res = await post({ password: 'my-own-pass' });
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([
      'updateUser:my-own-pass',
      `clear:${h.user!.id}:{"app_metadata":{"must_change_password":false}}`,
    ]);
  });

  it('needs a signed-in user with a pending change', async () => {
    h.user = null;
    expect((await post({ password: 'my-own-pass' })).status).toBe(401);
    h.user = { id: '', app_metadata: {} };
    expect((await post({ password: 'my-own-pass' })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('rejects a short password before touching the login', async () => {
    const res = await post({ password: 'short' });
    expect(res.status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('refuses keeping the one-time password', async () => {
    h.updateUserError = { code: 'same_password', message: 'New password should be different' };
    const res = await post({ password: 'otp-value-1' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not the one-time password/);
    expect(h.calls.some((c) => c.startsWith('clear:'))).toBe(false);
  });

  it('reports a flag that could not be cleared', async () => {
    h.flagError = { message: 'down' };
    const res = await post({ password: 'my-own-pass' });
    expect(res.status).toBe(500);
  });
});
