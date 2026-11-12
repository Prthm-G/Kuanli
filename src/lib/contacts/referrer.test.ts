import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createReferrer, searchReferrers } from './referrer';

type Call = { method: string; args: unknown[] };

function fakeDb(result: { data?: unknown; error?: unknown } = { data: [] }) {
  const calls: Call[] = [];
  const tables: string[] = [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'or', 'order', 'limit', 'insert']) {
    b[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return b;
    };
  }
  b.single = async () => result;
  b.then = (resolve: (v: unknown) => unknown) => resolve(result);
  const db = {
    from: (t: string) => {
      tables.push(t);
      return b;
    },
  } as unknown as SupabaseClient;
  return { db, calls, tables };
}

describe('searchReferrers', () => {
  it('searches only contacts in the given account, by name or phone', async () => {
    const { db, calls, tables } = fakeDb({
      data: [{ id: 'a', name: 'Referrer One', phone: '+155500000001' }],
    });
    const out = await searchReferrers(db, 'acc1', 'Referrer One');
    expect(tables).toEqual(['contacts']);
    expect(calls).toContainEqual({ method: 'eq', args: ['account_id', 'acc1'] });
    const or = calls.find((c) => c.method === 'or')!.args[0] as string;
    expect(or).toContain('name.ilike.%Referrer One%');
    expect(or).toContain('phone.ilike.%Referrer One%');
    expect(out).toEqual([{ id: 'a', name: 'Referrer One', phone: '+155500000001' }]);
  });

  it('matches phone digits against the normalized column', async () => {
    const { db, calls } = fakeDb();
    await searchReferrers(db, 'acc1', '+91 98765');
    const or = calls.find((c) => c.method === 'or')!.args[0] as string;
    expect(or).toContain('phone_normalized.ilike.%9198765%');
  });

  it('strips filter syntax characters from the query', async () => {
    const { db, calls } = fakeDb();
    await searchReferrers(db, 'acc1', 'a,b)(c%d');
    const or = calls.find((c) => c.method === 'or')!.args[0] as string;
    expect(or).not.toMatch(/[()]|a,b/);
    expect(or.split(',')).toHaveLength(2); // name and phone; no digits, so no normalized clause
  });

  it('skips the query for fewer than 2 characters', async () => {
    const { db, tables } = fakeDb();
    expect(await searchReferrers(db, 'acc1', 'a')).toEqual([]);
    expect(tables).toHaveLength(0);
  });

  it('leaves out the contact being edited', async () => {
    const { db, calls } = fakeDb();
    await searchReferrers(db, 'acc1', 'Referrer One', 'self');
    expect(calls).toContainEqual({ method: 'neq', args: ['id', 'self'] });
  });

  it('returns nothing on a database error', async () => {
    const { db } = fakeDb({ data: null, error: { message: 'x' } });
    expect(await searchReferrers(db, 'acc1', 'Referrer One')).toEqual([]);
  });
});

describe('createReferrer', () => {
  it('inserts name and phone in the account, with no source set', async () => {
    const { db, calls } = fakeDb({ data: { id: 'new', name: 'Referrer Two', phone: '+155500000002' } });
    const out = await createReferrer(db, {
      accountId: 'acc1',
      userId: 'u1',
      name: ' Referrer Two ',
      phone: ' +155500000002 ',
    });
    const row = calls.find((c) => c.method === 'insert')!.args[0] as Record<string, unknown>;
    expect(row).toEqual({
      user_id: 'u1',
      account_id: 'acc1',
      name: 'Referrer Two',
      phone: '+155500000002',
    });
    expect('source' in row).toBe(false);
    expect(out).toEqual({ ok: true, referrer: { id: 'new', name: 'Referrer Two', phone: '+155500000002' } });
  });

  it('needs a name and a phone', async () => {
    const { db, tables } = fakeDb();
    const a = await createReferrer(db, { accountId: 'a', userId: 'u', name: '', phone: '1' });
    const b = await createReferrer(db, { accountId: 'a', userId: 'u', name: 'N', phone: ' ' });
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(tables).toHaveLength(0);
  });

  it('says the number is taken on a duplicate, without naming anyone', async () => {
    const { db } = fakeDb({ data: null, error: { code: '23505', message: 'dup' } });
    const out = await createReferrer(db, { accountId: 'a', userId: 'u', name: 'N', phone: '1' });
    expect(out).toEqual({
      ok: false,
      error: 'This number is already in Kuanli. Search for the person by name or phone.',
    });
  });
});
