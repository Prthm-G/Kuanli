import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { HIDDEN_DUPLICATE_MESSAGE } from './dedupe';
import { createReferrer, searchReferrers } from './referrer';

type Call = { method: string; args: unknown[] };

function fakeDb(
  result: { data?: unknown; error?: unknown } = { data: [] },
  lookup: unknown[] = [],
) {
  const calls: Call[] = [];
  const tables: string[] = [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'or', 'order', 'limit', 'insert', 'like']) {
    b[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return b;
    };
  }
  b.single = async () => result;
  // findExistingContact awaits the builder after .like(); searches await it
  // after .limit(); both read `result`, except the pre-insert lookup.
  b.then = (resolve: (v: unknown) => unknown) =>
    resolve(calls.some((c) => c.method === 'like') ? { data: lookup, error: null } : result);
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
  const base = { accountId: 'acc1', userId: 'u1' };

  it('inserts name and the 91-prefixed phone in the account, with no source set', async () => {
    const { db, calls } = fakeDb({ data: { id: 'new', name: 'Referrer Two', phone: '919000000002' } });
    const out = await createReferrer(db, { ...base, name: ' Referrer Two ', phone: ' 90000 00002 ' });
    const row = calls.find((c) => c.method === 'insert')!.args[0] as Record<string, unknown>;
    expect(row).toEqual({
      user_id: 'u1',
      account_id: 'acc1',
      name: 'Referrer Two',
      phone: '919000000002',
    });
    expect('source' in row).toBe(false);
    expect(out).toEqual({
      ok: true,
      referrer: { id: 'new', name: 'Referrer Two', phone: '919000000002' },
    });
  });

  it('needs a name and a phone', async () => {
    const { db, tables } = fakeDb();
    expect((await createReferrer(db, { ...base, name: '', phone: '9000000002' })).ok).toBe(false);
    expect((await createReferrer(db, { ...base, name: 'N', phone: ' ' })).ok).toBe(false);
    expect(tables).toHaveLength(0);
  });

  it('accepts a foreign number as its digits with the country code', async () => {
    for (const [typed, stored] of [
      ['+1 202 555 0100', '12025550100'],
      ['+61 412 345 678', '61412345678'],
    ]) {
      const { db, calls } = fakeDb({ data: { id: 'n', name: 'N', phone: stored } });
      const out = await createReferrer(db, { ...base, name: 'N', phone: typed });
      expect(out.ok).toBe(true);
      const row = calls.find((c) => c.method === 'insert')!.args[0] as Record<string, unknown>;
      expect(row.phone).toBe(stored);
    }
  });

  it('rejects numbers that cannot be a phone, without touching the database', async () => {
    for (const phone of ['12345', 'abc', '1234567890123456']) {
      const { db, tables } = fakeDb();
      const out = await createReferrer(db, { ...base, name: 'N', phone });
      expect(out.ok).toBe(false);
      expect(tables).toHaveLength(0);
    }
  });

  it('blocks an exact match and offers it, even when asked to create anyway', async () => {
    const existing = { id: 'e1', name: 'Existing', phone: '+91 90000 00003' };
    const { db, calls } = fakeDb({ data: null }, [existing]);
    const out = await createReferrer(db, { ...base, name: 'N', phone: '9000000003' }, { allowFuzzy: true });
    expect(calls.some((c) => c.method === 'insert')).toBe(false);
    expect(out).toMatchObject({ ok: false, exact: true, existing: { id: 'e1', name: 'Existing' } });
  });

  it('offers a fuzzy match but does not block creating anyway', async () => {
    // Stored without the 91 prefix: same last 8 digits, not the same digits.
    const existing = { id: 'f1', name: 'Similar', phone: '9000000003' };
    const first = fakeDb({ data: null }, [existing]);
    const warn = await createReferrer(first.db, { ...base, name: 'N', phone: '9000000003' });
    expect(first.calls.some((c) => c.method === 'insert')).toBe(false);
    expect(warn).toMatchObject({ ok: false, exact: false, existing: { id: 'f1' } });

    const second = fakeDb({ data: { id: 'new', name: 'N', phone: '919000000003' } }, [existing]);
    const created = await createReferrer(second.db, { ...base, name: 'N', phone: '9000000003' }, { allowFuzzy: true });
    expect(second.calls.some((c) => c.method === 'insert')).toBe(true);
    expect(created.ok).toBe(true);
  });

  it('prefers the exact match when several contacts match', async () => {
    const fuzzy = { id: 'f1', name: 'Similar', phone: '9000000003' };
    const exact = { id: 'x1', name: 'Exact', phone: '919000000003' };
    const { db } = fakeDb({ data: null }, [fuzzy, exact]);
    const out = await createReferrer(db, { ...base, name: 'N', phone: '9000000003' });
    expect(out).toMatchObject({ ok: false, exact: true, existing: { id: 'x1' } });
  });

  it('uses the hidden-duplicate message when the database refuses a number we cannot see', async () => {
    const { db } = fakeDb({ data: null, error: { code: '23505', message: 'dup' } });
    const out = await createReferrer(db, { ...base, name: 'N', phone: '9000000005' });
    expect(out).toEqual({ ok: false, error: HIDDEN_DUPLICATE_MESSAGE });
  });
});
