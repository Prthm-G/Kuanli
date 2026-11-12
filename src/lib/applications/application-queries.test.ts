import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  loadApplication,
  loadContactDocuments,
  markAllUploaded,
  saveApplication,
  setDocumentUploaded,
} from './application-queries';

type Call = { method: string; args: unknown[] };

/** A recording stand-in for the PostgREST builder: resolves to `result` when awaited. */
function fakeDb(results: Record<string, { data?: unknown; error?: unknown }>) {
  const calls: Array<{ target: string; calls: Call[] }> = [];
  const make = (target: string) => {
    const rec: Call[] = [];
    calls.push({ target, calls: rec });
    const res = results[target] ?? { data: null, error: null };
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'upsert', 'update', 'eq', 'in', 'order', 'is']) {
      b[m] = (...args: unknown[]) => (rec.push({ method: m, args }), b);
    }
    b.maybeSingle = async () => ({
      data: res.data ?? null,
      error: res.error ?? null,
    });
    b.single = b.maybeSingle;
    b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
      Promise.resolve({
        data: res.data ?? null,
        error: res.error ?? null,
      }).then(ok, bad);
    return b;
  };
  const db = {
    from: vi.fn((t: string) => make(t)),
    rpc: vi.fn((fn: string, args: unknown) => {
      const rec: Call[] = [{ method: 'rpc', args: [fn, args] }];
      calls.push({ target: `rpc:${fn}`, calls: rec });
      const res = results[`rpc:${fn}`] ?? { data: null, error: null };
      return Promise.resolve({
        data: res.data ?? null,
        error: res.error ?? null,
      });
    }),
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const upsertArgs = (calls: Array<{ target: string; calls: Call[] }>) =>
  calls
    .find((c) => c.target === 'applications')!
    .calls.find((c) => c.method === 'upsert')!.args;

describe('saveApplication', () => {
  it('upserts on contact_id and sends null, not an empty string, for blanks', async () => {
    const { db, calls } = fakeDb({ applications: { data: null } });
    await saveApplication(db, {
      accountId: 'a1',
      contactId: 'c1',
      fatherName: '   ',
      program: 'MBA',
      specialization: '',
      provisionalAppId: ' ',
      registrationNumber: '',
    });
    const [row, opts] = upsertArgs(calls) as [Record<string, unknown>, unknown];
    expect(opts).toEqual({ onConflict: 'contact_id' });
    expect(row).toEqual({
      account_id: 'a1',
      contact_id: 'c1',
      father_name: null,
      program: 'MBA',
      specialization: null,
      provisional_app_id: null,
      registration_number: null,
    });
  });

  it('trims values and leaves out fields that were not given', async () => {
    const { db, calls } = fakeDb({});
    await saveApplication(db, {
      accountId: 'a1',
      contactId: 'c1',
      registrationNumber: '  R-1 ',
    });
    const [row] = upsertArgs(calls) as [Record<string, unknown>];
    expect(row).toEqual({
      account_id: 'a1',
      contact_id: 'c1',
      registration_number: 'R-1',
    });
  });

  it('records who punched the details and when', async () => {
    const { db, calls } = fakeDb({});
    await saveApplication(db, {
      accountId: 'a1',
      contactId: 'c1',
      detailsPunchedBy: 'u1',
    });
    const [row] = upsertArgs(calls) as [Record<string, unknown>];
    expect(row.details_punched_by).toBe('u1');
    expect(typeof row.details_punched_at).toBe('string');
  });

  it('staff fill records me, student fill records nobody', async () => {
    const staff = fakeDb({});
    await saveApplication(staff.db, {
      accountId: 'a1',
      contactId: 'c1',
      formFilledBy: { kind: 'staff', userId: 'u1' },
    });
    const [s] = upsertArgs(staff.calls) as [Record<string, unknown>];
    expect(s.form_filled_by_kind).toBe('staff');
    expect(s.form_filled_by).toBe('u1');
    expect(typeof s.form_filled_at).toBe('string');

    const student = fakeDb({});
    await saveApplication(student.db, {
      accountId: 'a1',
      contactId: 'c1',
      formFilledBy: { kind: 'student', userId: 'u1' },
    });
    const [t] = upsertArgs(student.calls) as [Record<string, unknown>];
    expect(t.form_filled_by_kind).toBe('student');
    expect(t.form_filled_by).toBeNull();
  });

  it('writes retain_files', async () => {
    const { db, calls } = fakeDb({});
    await saveApplication(db, {
      accountId: 'a1',
      contactId: 'c1',
      retainFiles: true,
    });
    const [row] = upsertArgs(calls) as [Record<string, unknown>];
    expect(row.retain_files).toBe(true);
  });

  it('never moves a card itself: no rpc, no deals write', async () => {
    const { db, calls } = fakeDb({});
    await saveApplication(db, {
      accountId: 'a1',
      contactId: 'c1',
      program: 'MBA',
    });
    expect(calls.map((c) => c.target)).toEqual(['applications']);
  });

  it('throws with the database code so the panel can explain a duplicate', async () => {
    const { db } = fakeDb({
      applications: { error: { message: 'dup', code: '23505' } },
    });
    await expect(
      saveApplication(db, {
        accountId: 'a1',
        contactId: 'c1',
        registrationNumber: 'R',
      })
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('loadApplication', () => {
  it('maps the row, and returns null when the student has none', async () => {
    const row = {
      id: 'x',
      account_id: 'a1',
      contact_id: 'c1',
      university: 'LPU',
      father_name: 'F',
      program: 'MBA',
      specialization: null,
      details_punched_at: '2026-11-01T00:00:00Z',
      details_punched_by: 'u1',
      provisional_app_id: 'P1',
      form_filled_by_kind: 'staff',
      form_filled_by: 'u1',
      form_filled_at: null,
      registration_number: null,
      retain_files: true,
    };
    const { db } = fakeDb({ applications: { data: row } });
    const app = await loadApplication(db, 'c1');
    expect(app).toMatchObject({
      contactId: 'c1',
      fatherName: 'F',
      specialization: null,
      provisionalAppId: 'P1',
      formFilledByKind: 'staff',
      retainFiles: true,
    });
    expect(await loadApplication(fakeDb({}).db, 'c1')).toBeNull();
  });

  it('throws on a read error rather than showing an empty form', async () => {
    const { db } = fakeDb({ applications: { error: { message: 'boom' } } });
    await expect(loadApplication(db, 'c1')).rejects.toThrow('boom');
  });
});

describe('markAllUploaded', () => {
  it('calls mark_documents_uploaded and returns the count', async () => {
    const { db, calls } = fakeDb({
      'rpc:mark_documents_uploaded': { data: 3 },
    });
    expect(await markAllUploaded(db, 'c1')).toBe(3);
    expect(calls[0].calls[0].args).toEqual([
      'mark_documents_uploaded',
      { p_contact_id: 'c1' },
    ]);
  });

  it('throws on error', async () => {
    const { db } = fakeDb({
      'rpc:mark_documents_uploaded': { error: { message: 'no' } },
    });
    await expect(markAllUploaded(db, 'c1')).rejects.toThrow('no');
  });
});

describe('setDocumentUploaded', () => {
  it('stamps time and person, or clears both', async () => {
    const on = fakeDb({});
    await setDocumentUploaded(on.db, 'd1', 'u1', true);
    const up = on.calls[0].calls.find((c) => c.method === 'update')!
      .args[0] as Record<string, unknown>;
    expect(up.uploaded_to_portal_by).toBe('u1');
    expect(typeof up.uploaded_to_portal_at).toBe('string');

    const off = fakeDb({});
    await setDocumentUploaded(off.db, 'd1', 'u1', false);
    expect(
      off.calls[0].calls.find((c) => c.method === 'update')!.args[0]
    ).toEqual({
      uploaded_to_portal_at: null,
      uploaded_to_portal_by: null,
    });
  });
});

describe('loadContactDocuments', () => {
  it('lists the required documents with the latest file of each type, and the rest apart', async () => {
    const { db } = fakeDb({
      university_required_docs: {
        data: [
          { doc_type: 'photo', label: 'Photo', position: 1 },
          { doc_type: 'id_proof', label: 'ID', position: 2 },
        ],
      },
      application_documents: {
        data: [
          {
            id: 'd3',
            doc_type: 'photo',
            status: 'verified',
            created_at: '2026-11-03',
            uploaded_to_portal_at: null,
            file_deleted_at: null,
            storage_path: 'p3',
            mime_type: 'image/png',
          },
          {
            id: 'd2',
            doc_type: 'photo',
            status: 'rejected',
            created_at: '2026-11-02',
            uploaded_to_portal_at: null,
            file_deleted_at: null,
            storage_path: 'p2',
            mime_type: 'image/png',
          },
          {
            id: 'd1',
            doc_type: null,
            status: 'received',
            created_at: '2026-11-01',
            uploaded_to_portal_at: null,
            file_deleted_at: null,
            storage_path: null,
            mime_type: null,
          },
        ],
      },
    });
    const view = await loadContactDocuments(db, 'a1', 'c1', 'LPU');
    expect(view.required.map((r) => [r.docType, r.doc?.id ?? null])).toEqual([
      ['photo', 'd3'],
      ['id_proof', null],
    ]);
    expect(view.other.map((d) => d.id)).toEqual(['d2', 'd1']);
  });
});
