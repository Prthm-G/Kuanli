import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { ownerCandidates, setContactOwner } from './owner';

const C = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

function fakeDb(error: { code?: string; message?: string } | null = null) {
  const rpc = vi.fn(async () => ({ data: null, error }));
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}

describe('setContactOwner', () => {
  it('calls set_contact_owner with the contact, owner and branch', async () => {
    const { db, rpc } = fakeDb();
    expect(await setContactOwner(db, C, P, B)).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('set_contact_owner', {
      p_contact: C,
      p_profile: P,
      p_branch: B,
    });
  });

  it('null owner means unowned; no branch keeps the branch', async () => {
    const { db, rpc } = fakeDb();
    expect(await setContactOwner(db, C, null)).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('set_contact_owner', {
      p_contact: C,
      p_profile: null,
      p_branch: null,
    });
  });

  it('maps a PostgREST error to { ok: false, error }', async () => {
    const { db } = fakeDb({ code: 'P0001', message: 'Owner is not a member of this account' });
    expect(await setContactOwner(db, C, P)).toEqual({
      ok: false,
      error: 'Owner is not a member of this account',
    });
  });

  it('says plainly when a non-admin is refused (42501)', async () => {
    const { db } = fakeDb({ code: '42501', message: 'permission denied' });
    expect(await setContactOwner(db, C, P)).toEqual({
      ok: false,
      error: 'Only an admin can change who owns a lead.',
    });
  });

  it('rejects non-uuid input before any call', async () => {
    const { db, rpc } = fakeDb();
    expect(await setContactOwner(db, 'nope', P)).toEqual({ ok: false, error: 'Invalid contact' });
    expect(await setContactOwner(db, C, 'x')).toEqual({ ok: false, error: 'Invalid owner' });
    expect(await setContactOwner(db, C, P, '1; drop')).toEqual({
      ok: false,
      error: 'Invalid branch',
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('ownerCandidates', () => {
  const m = (profile_id: string, full_name: string, role: 'owner' | 'admin' | 'agent' | 'viewer') => ({
    profile_id,
    full_name,
    role,
  });
  const members = [
    m('v', 'Viewer One', 'viewer'),
    m('c2', 'Counsellor Two', 'agent'),
    m('o', 'Owner', 'owner'),
    m('a', 'Admin', 'admin'),
    m('c1', 'Counsellor One', 'agent'),
  ];

  it('lists Counsellor and up, by name', () => {
    expect(ownerCandidates(members, null).map((x) => x.profile_id)).toEqual([
      'a',
      'c1',
      'c2',
      'o',
    ]);
  });

  it('keeps the current owner even below Counsellor', () => {
    expect(ownerCandidates(members, 'v').map((x) => x.profile_id)).toContain('v');
  });
});
