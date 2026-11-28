import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  NotSameStudentError, differentStudentsWarning, linkStudents, loadStudentSet, loadStudentTimeline, markNotSameStudent,
  orderedPair, recordLabel, unlinkStudents, type StudentRecord,
} from './queries';

type Result = { data: unknown; error: { message: string; code?: string } | null };
/** A thenable query builder: every method returns itself; awaiting it yields `result`. Calls are recorded. */
function builder(result: Result) {
  const calls: Array<[string, unknown[]]> = [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'in', 'eq', 'delete', 'insert', 'maybeSingle']) {
    b[m] = vi.fn((...args: unknown[]) => { calls.push([m, args]); return b; });
  }
  b.then = (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return { b, calls };
}
function fakeDb(rpcResult: Result, tables: Record<string, Result | Result[]> = {}) {
  const used: Record<string, Array<ReturnType<typeof builder>>> = {};
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  const from = vi.fn((t: string) => {
    const r = tables[t];
    const next = Array.isArray(r) ? r[(used[t]?.length ?? 0)] : r;
    const q = builder(next ?? { data: [], error: null });
    (used[t] ??= []).push(q);
    return q.b;
  });
  return { db: { rpc, from } as unknown as SupabaseClient, rpc, from, used };
}
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

describe('orderedPair', () => {
  it('orders lowercase uuids the way Postgres does', () => {
    expect(orderedPair(B, A)).toEqual([A, B]);
    expect(orderedPair(A.toUpperCase(), B)).toEqual([A, B]);
  });
  it('refuses a self pair', () => expect(() => orderedPair(A, A)).toThrow());
});

describe('recordLabel', () => {
  it('uses the name, else the last 4 digits', () => {
    expect(recordLabel({ name: 'Riya', phone: '919876500001' })).toBe('Riya');
    expect(recordLabel({ name: null, phone: '919876500001' })).toBe('…0001');
    expect(recordLabel({ name: ' ', phone: null })).toBe('Unnamed record');
  });
});

describe('differentStudentsWarning', () => {
  const rec = (id: string, name: string, hasApplication: boolean): StudentRecord =>
    ({ contactId: id, via: 'link', linkId: null, name, phone: null, hasApplication });
  it('is null with fewer than 2 applications', () => {
    expect(differentStudentsWarning([rec('1', 'A', true), rec('2', 'B', false)])).toBeNull();
  });
  it('names each record holding an application when 2+', () => {
    expect(differentStudentsWarning([rec('1', 'A', true), rec('2', 'B', true), rec('3', 'C', false)])).toEqual(['A', 'B']);
  });
});

describe('loadStudentSet', () => {
  it('calls student_set, joins visible contacts and applications, self first', async () => {
    const { db, rpc } = fakeDb(
      { data: [{ contact_id: B, via: 'link', link_id: 'L1' }, { contact_id: A, via: 'self', link_id: null }], error: null },
      {
        contacts: { data: [{ id: A, name: 'Self', phone: '919876500001' }, { id: B, name: 'Other', phone: '919876500002' }], error: null },
        applications: { data: [{ contact_id: B }], error: null },
      },
    );
    const out = await loadStudentSet(db, 'acc', A);
    expect(rpc).toHaveBeenCalledWith('student_set', { p_account: 'acc', p_contact: A });
    expect(out.map((r) => [r.contactId, r.via, r.linkId, r.hasApplication])).toEqual([[A, 'self', null, false], [B, 'link', 'L1', true]]);
  });
  it('drops ids whose contact row did not come back', async () => {
    const { db } = fakeDb({ data: [{ contact_id: A, via: 'self', link_id: null }, { contact_id: B, via: 'phone', link_id: null }], error: null },
      { contacts: { data: [{ id: A, name: 'Self', phone: null }], error: null }, applications: { data: [], error: null } });
    expect((await loadStudentSet(db, 'acc', A)).map((r) => r.contactId)).toEqual([A]);
  });
  it('returns [] without table reads when the set is empty', async () => {
    const { db, from } = fakeDb({ data: [], error: null });
    expect(await loadStudentSet(db, 'acc', A)).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });
  it('throws a fixed message on an RPC error', async () => {
    const { db } = fakeDb({ data: null, error: { message: 'boom' } });
    await expect(loadStudentSet(db, 'acc', A)).rejects.toThrow('Could not load linked records');
  });
});

describe('loadStudentTimeline', () => {
  it('passes before/limit and maps rows', async () => {
    const { db, rpc } = fakeDb({ data: [{ kind: 'stage', id: 'e1', at: '2026-11-20T01:30:00Z', who: 'Agent', summary: 'Qualified to Application Started',
      contact_id: B, phone_last4: '0002', method: null, outcome: null, next_due_at: null, next_method: null }], error: null });
    const out = await loadStudentTimeline(db, 'acc', A, '2026-11-21T00:00:00Z');
    expect(rpc).toHaveBeenCalledWith('student_timeline', { p_account: 'acc', p_contact: A, p_before: '2026-11-21T00:00:00Z', p_limit: 50 });
    expect(out[0]).toMatchObject({ kind: 'stage', contactId: B, phoneLast4: '0002', method: null });
  });
  it('sends p_before null on the first page', async () => {
    const { db, rpc } = fakeDb({ data: [], error: null });
    await loadStudentTimeline(db, 'acc', A);
    expect(rpc).toHaveBeenCalledWith('student_timeline', { p_account: 'acc', p_contact: A, p_before: null, p_limit: 50 });
  });
});

describe('link writes', () => {
  it('linkStudents clears an exclusion for the pair, then inserts the ordered link', async () => {
    const { db, used } = fakeDb({ data: null, error: null }, {
      contact_link_exclusions: { data: [], error: null },
      contact_links: { data: [{ id: 'L1' }], error: null },
    });
    await linkStudents(db, 'acc', 'u1', B, A);
    expect(used.contact_link_exclusions[0].calls.map((c) => c[0])).toEqual(['delete', 'eq', 'eq', 'eq']);
    expect(used.contact_links[0].calls[0]).toEqual(['insert', [{ account_id: 'acc', contact_a: A, contact_b: B, created_by: 'u1' }]]);
  });
  it('linkStudents treats an existing link (23505) as done', async () => {
    const { db } = fakeDb({ data: null, error: null }, { contact_link_exclusions: { data: [], error: null },
      contact_links: { data: null, error: { message: 'dup', code: '23505' } } });
    await expect(linkStudents(db, 'acc', 'u1', A, B)).resolves.toBeUndefined();
  });
  it('linkStudents throws when RLS refuses', async () => {
    const { db } = fakeDb({ data: null, error: null }, { contact_link_exclusions: { data: [], error: null },
      contact_links: { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } } });
    await expect(linkStudents(db, 'acc', 'u1', A, B)).rejects.toThrow('Could not link these records');
  });
  it('unlinkStudents throws when no row was deleted', async () => {
    const { db } = fakeDb({ data: null, error: null }, { contact_links: { data: [], error: null } });
    await expect(unlinkStudents(db, 'L1')).rejects.toThrow('Could not unlink');
  });
  it('markNotSameStudent inserts the ordered exclusion and accepts 23505', async () => {
    const { db, used } = fakeDb({ data: null, error: null }, { contact_link_exclusions: { data: null, error: { message: 'dup', code: '23505' } } });
    await markNotSameStudent(db, 'acc', 'u1', B, A);
    expect(used.contact_link_exclusions[0].calls[0]).toEqual(['insert', [{ account_id: 'acc', contact_a: A, contact_b: B, created_by: 'u1' }]]);
  });
  it('linkStudents surfaces the P0001 refusal as a typed error', async () => {
    const { db } = fakeDb({ data: null, error: null }, { contact_link_exclusions: { data: [], error: null },
      contact_links: { data: null, error: { message: 'these two records are marked as not the same student; remove that first', code: 'P0001' } } });
    const err = await linkStudents(db, 'acc', 'u1', A, B).catch((e) => e);
    expect(err).toBeInstanceOf(NotSameStudentError);
    expect(err.message).toBe('Marked as not the same student; remove that first');
  });
  it('linkStudents fixed-message error does not echo the PostgREST message', async () => {
    const { db } = fakeDb({ data: null, error: null }, { contact_link_exclusions: { data: [], error: null },
      contact_links: { data: null, error: { message: 'secret detail', code: 'XX000' } } });
    const err = await linkStudents(db, 'acc', 'u1', A, B).catch((e) => e);
    expect(err.message).toBe('Could not link these records');
  });
});
