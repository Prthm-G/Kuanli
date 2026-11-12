import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  addMember,
  generateOneTimePassword,
  MemberLoginError,
  OTP_LENGTH,
  resetMemberPassword,
} from './member-logins';
import { usernameToEmail } from './username';

/**
 * An in-memory GoTrue admin API + the two tables these helpers touch.
 * createUser mimics handle_new_user: a personal account and an owner
 * profile for every new user. Behaviour that matters here (email_exists,
 * app_metadata merge, ban) was checked against a real GoTrue v2.158.1.
 */
type Row = Record<string, unknown>;
interface AuthUser {
  id: string;
  email: string;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  banned: boolean;
  password: string;
}

const ACCOUNT = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ACCOUNT = '00000000-0000-4000-8000-0000000000bb';
const CALLER = '00000000-0000-4000-8000-000000000001';

let users: AuthUser[];
let db: Record<string, Row[]>;
let fail: Set<string>;
let calls: string[];
let seq: number;

function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

function from(table: string) {
  const filters: Array<[string, unknown]> = [];
  let mode: 'select' | 'update' | 'delete' | 'insert' = 'select';
  let payload: Row = {};
  const rows = () =>
    (db[table] ??= []).filter((r) => filters.every(([c, v]) => r[c] === v));
  const run = () => {
    if (fail.has(`${table}.${mode}`)) return { data: null, error: { message: `${table} ${mode} failed` } };
    calls.push(`${table}.${mode}`);
    if (mode === 'insert') {
      db[table].push({ id: uuid(), ...payload });
      return { data: null, error: null };
    }
    if (mode === 'update') {
      for (const r of rows()) Object.assign(r, payload);
      return { data: null, error: null };
    }
    if (mode === 'delete') {
      const gone = new Set(rows());
      db[table] = db[table].filter((r) => !gone.has(r));
      return { data: null, error: null };
    }
    return { data: rows()[0] ?? null, error: null };
  };
  const b = {
    select: () => b,
    insert: (p: Row) => ((db[table] ??= []), (mode = 'insert'), (payload = p), run()),
    update: (p: Row) => ((mode = 'update'), (payload = p), b),
    delete: () => ((mode = 'delete'), b),
    eq: (c: string, v: unknown) => (filters.push([c, v]), b),
    maybeSingle: async () => run(),
    then: (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res),
  };
  return b;
}

const fakeAdmin = {
  from,
  auth: {
    admin: {
      async createUser(a: {
        email: string;
        password: string;
        user_metadata: Record<string, unknown>;
        app_metadata: Record<string, unknown>;
      }) {
        calls.push('auth.createUser');
        if (users.some((u) => u.email === a.email.toLowerCase())) {
          return {
            data: { user: null },
            error: { code: 'email_exists', message: 'A user with this email address has already been registered' },
          };
        }
        const u: AuthUser = {
          id: uuid(),
          email: a.email.toLowerCase(),
          app_metadata: { provider: 'email', ...a.app_metadata },
          user_metadata: a.user_metadata,
          banned: false,
          password: a.password,
        };
        users.push(u);
        // handle_new_user
        const acct = uuid();
        db.accounts.push({ id: acct, owner_user_id: u.id });
        db.profiles.push({ id: uuid(), user_id: u.id, account_id: acct, account_role: 'owner', email: u.email });
        return { data: { user: u }, error: null };
      },
      async listUsers({ page }: { page: number; perPage: number }) {
        return { data: { users: page === 1 ? users : [] }, error: null };
      },
      async updateUserById(
        id: string,
        a: { password?: string; ban_duration?: string; app_metadata?: Record<string, unknown> },
      ) {
        if (fail.has('auth.update')) return { data: { user: null }, error: { message: 'boom' } };
        calls.push(`auth.update:${Object.keys(a).sort().join(',')}`);
        const u = users.find((x) => x.id === id);
        if (!u) return { data: { user: null }, error: { message: 'not found' } };
        if (a.password) u.password = a.password;
        if (a.ban_duration) u.banned = a.ban_duration !== 'none';
        if (a.app_metadata) u.app_metadata = { ...u.app_metadata, ...a.app_metadata };
        return { data: { user: u }, error: null };
      },
      async deleteUser(id: string) {
        calls.push('auth.deleteUser');
        users = users.filter((u) => u.id !== id);
        return { data: null, error: null };
      },
    },
  },
} as unknown as SupabaseClient;

beforeEach(() => {
  users = [];
  db = { accounts: [{ id: ACCOUNT, owner_user_id: CALLER }], profiles: [] };
  fail = new Set();
  calls = [];
  seq = 100;
});

const newMember = { accountId: ACCOUNT, username: 'simran', fullName: 'Simran', role: 'agent' as const };

describe('generateOneTimePassword', () => {
  it('is 10 unambiguous characters and differs each time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generateOneTimePassword();
      expect(p).toHaveLength(OTP_LENGTH);
      expect(p).toMatch(/^[a-hjkmnp-z2-9]+$/);
      seen.add(p);
    }
    expect(seen.size).toBe(50);
  });
});

describe('addMember', () => {
  it('creates a must-change login and moves its profile into the account', async () => {
    const out = await addMember(fakeAdmin, newMember);

    expect(out.login).toBe('simran');
    expect(out.restored).toBeUndefined();
    const u = users.find((x) => x.id === out.userId)!;
    expect(u.email).toBe(usernameToEmail('simran'));
    expect(u.password).toBe(out.password);
    expect(u.app_metadata.must_change_password).toBe(true);

    const profile = db.profiles.find((p) => p.user_id === out.userId)!;
    expect(profile).toMatchObject({ account_id: ACCOUNT, account_role: 'agent', full_name: 'Simran' });
    // The personal account handle_new_user made is gone; ours is untouched.
    expect(db.accounts.map((a) => a.id)).toEqual([ACCOUNT]);
  });

  it('inserts the profile when the signup trigger left none', async () => {
    const real = fakeAdmin.auth.admin.createUser.bind(fakeAdmin.auth.admin);
    const spy = fakeAdmin.auth.admin as unknown as { createUser: typeof real };
    spy.createUser = async (a) => {
      const r = await real(a);
      db.profiles = db.profiles.filter((p) => p.user_id !== r.data.user?.id);
      return r;
    };
    try {
      const out = await addMember(fakeAdmin, newMember);
      expect(db.profiles.find((p) => p.user_id === out.userId)).toMatchObject({
        account_id: ACCOUNT,
        account_role: 'agent',
        email: usernameToEmail('simran'),
      });
    } finally {
      spy.createUser = real;
    }
  });

  it('deletes the new login if its profile cannot be placed', async () => {
    fail.add('profiles.update');
    await expect(addMember(fakeAdmin, newMember)).rejects.toMatchObject({ status: 500 });
    expect(calls).toContain('auth.deleteUser');
    expect(users).toHaveLength(0);
  });

  it('brings back a removed member: same user id, unbanned, new one-time password', async () => {
    const first = await addMember(fakeAdmin, newMember);
    // What removal does: profile deleted, login banned.
    db.profiles = db.profiles.filter((p) => p.user_id !== first.userId);
    users[0].banned = true;
    users[0].app_metadata.must_change_password = false;

    const again = await addMember(fakeAdmin, { ...newMember, fullName: 'Simran K', role: 'admin' });

    expect(again).toMatchObject({ userId: first.userId, login: 'simran', restored: true });
    expect(again.password).not.toBe(first.password);
    expect(users[0]).toMatchObject({ banned: false, password: again.password });
    expect(users[0].app_metadata.must_change_password).toBe(true);
    expect(db.profiles.filter((p) => p.user_id === first.userId)).toEqual([
      expect.objectContaining({ account_id: ACCOUNT, account_role: 'admin', full_name: 'Simran K' }),
    ]);
  });

  it('refuses a username a current member has', async () => {
    await addMember(fakeAdmin, newMember);
    const err = await addMember(fakeAdmin, newMember).catch((e) => e);
    expect(err).toBeInstanceOf(MemberLoginError);
    expect(err).toMatchObject({ status: 409, message: 'That username is already taken' });
  });

  it('re-bans the login if the restored profile cannot be written', async () => {
    const first = await addMember(fakeAdmin, newMember);
    db.profiles = db.profiles.filter((p) => p.user_id !== first.userId);
    users[0].banned = true;
    fail.add('profiles.insert');

    await expect(addMember(fakeAdmin, newMember)).rejects.toMatchObject({ status: 500 });
    expect(users[0].banned).toBe(true);
  });

  it('leaves a concurrent re-add in place when its own profile insert loses', async () => {
    const first = await addMember(fakeAdmin, newMember);
    db.profiles = db.profiles.filter((p) => p.user_id !== first.userId);
    users[0].banned = true;
    // The other request's insert lands first; ours then fails on the unique user_id.
    const realFrom = (fakeAdmin as unknown as { from: typeof from }).from;
    (fakeAdmin as unknown as { from: typeof from }).from = (table: string) => {
      const b = realFrom(table);
      if (table !== 'profiles') return b;
      return {
        ...b,
        insert: (p: Row) => {
          db.profiles.push({ id: 'winner', ...p });
          return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
        },
      } as ReturnType<typeof from>;
    };
    try {
      await expect(addMember(fakeAdmin, newMember)).rejects.toMatchObject({ status: 500 });
    } finally {
      (fakeAdmin as unknown as { from: typeof from }).from = realFrom;
    }
    expect(users[0].banned).toBe(false);
  });
});

describe('resetMemberPassword', () => {
  async function seedMember(role: 'agent' | 'owner', accountId = ACCOUNT) {
    const m = await addMember(fakeAdmin, { ...newMember, username: `m${seq}`, accountId: ACCOUNT });
    const p = db.profiles.find((x) => x.user_id === m.userId)!;
    p.account_role = role;
    p.account_id = accountId;
    users.find((u) => u.id === m.userId)!.app_metadata.must_change_password = false;
    calls = [];
    return m;
  }

  it('issues a new one-time password and sets must-change', async () => {
    const m = await seedMember('agent');
    const out = await resetMemberPassword(fakeAdmin, { accountId: ACCOUNT, callerUserId: CALLER, targetUserId: m.userId });

    const u = users.find((x) => x.id === m.userId)!;
    expect(out.login).toBe(u.email.split('@')[0]);
    expect(u.password).toBe(out.password);
    expect(u.app_metadata.must_change_password).toBe(true);
    expect(calls).toEqual(['profiles.select', 'auth.update:app_metadata,password']);
  });

  it('refuses yourself, the owner, and members of another account', async () => {
    const owner = await seedMember('owner');
    const outsider = await seedMember('agent', OTHER_ACCOUNT);
    const base = { accountId: ACCOUNT, callerUserId: CALLER };

    await expect(resetMemberPassword(fakeAdmin, { ...base, targetUserId: CALLER })).rejects.toMatchObject({ status: 400 });
    await expect(resetMemberPassword(fakeAdmin, { ...base, targetUserId: owner.userId })).rejects.toMatchObject({ status: 400 });
    await expect(resetMemberPassword(fakeAdmin, { ...base, targetUserId: outsider.userId })).rejects.toMatchObject({ status: 404 });
    expect(calls.filter((c) => c.startsWith('auth.update'))).toEqual([]);
  });
});
