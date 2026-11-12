import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Removing a member ends their access at once: the RPC drops the profile,
 * then the login is banned. GoTrue drops every session of a banned user
 * (checked against v2.158.1), so no separate sign-out call is needed.
 * The login is banned, never deleted: payments.logged_by and other
 * who-columns cascade from auth.users.
 */
const h = vi.hoisted(() => ({
  rpcError: null as null | { code: string; message: string },
  calls: [] as string[],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    userId: '00000000-0000-4000-8000-000000000001',
    accountId: 'acc',
    supabase: {
      rpc: async (name: string, args: { p_user_id: string }) => {
        h.calls.push(`rpc:${name}:${args.p_user_id}`);
        return { error: h.rpcError };
      },
    },
  }),
  toErrorResponse: (e: unknown) => {
    throw e;
  },
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    auth: {
      admin: {
        updateUserById: async (id: string, a: Record<string, unknown>) => {
          h.calls.push(`ban:${id}:${a.ban_duration}`);
          return { error: null };
        },
        deleteUser: async (id: string) => {
          h.calls.push(`delete:${id}`);
          return { error: null };
        },
      },
    },
  }),
}));

import { DELETE } from './route';

const TARGET = '00000000-0000-4000-8000-000000000042';
const call = () => DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ userId: TARGET }) });

beforeEach(() => {
  h.rpcError = null;
  h.calls = [];
});

describe('DELETE /api/account/members/[userId]', () => {
  it('removes the membership, then bans the login (which ends its sessions); never deletes it', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([`rpc:remove_account_member:${TARGET}`, `ban:${TARGET}:876000h`]);
  });

  it('does not ban when the RPC refuses', async () => {
    h.rpcError = { code: '42501', message: 'Target user is not a member of your account' };
    const res = await call();
    expect(res.status).toBe(403);
    expect(h.calls).toEqual([`rpc:remove_account_member:${TARGET}`]);
  });
});
