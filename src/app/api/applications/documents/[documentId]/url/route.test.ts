import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/applications/documents/[documentId]/url: a signed link that lives
 * for a minute, never cached, and every open leaves a row in the access log.
 */

const h = vi.hoisted(() => ({
  auth: 'ok' as 'ok' | 'unauthorized',
  doc: null as Record<string, unknown> | null,
  logged: [] as Array<Record<string, unknown>>,
  logError: null as { message: string } | null,
  signed: [] as Array<{ bucket: string; path: string; expiresIn: number }>,
  signError: null as { message: string } | null,
}));

vi.mock('@/lib/auth/account', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/account')>(
      '@/lib/auth/account'
    );
  return {
    ...actual,
    requireRole: async () => {
      if (h.auth === 'unauthorized') throw new actual.UnauthorizedError();
      return {
        accountId: 'acc1',
        userId: 'u1',
        role: 'viewer',
        supabase: {
          from: (table: string) => {
            if (table === 'document_access_log') {
              return {
                insert: async (row: Record<string, unknown>) => {
                  h.logged.push(row);
                  return { error: h.logError };
                },
              };
            }
            const b = {
              select: () => b,
              eq: () => b,
              maybeSingle: async () => ({ data: h.doc, error: null }),
            };
            return b;
          },
        },
      };
    },
  };
});

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, expiresIn: number) => {
          h.signed.push({ bucket, path, expiresIn });
          return h.signError
            ? { data: null, error: h.signError }
            : {
                data: {
                  signedUrl: `https://files.example.invalid/${path}?t=1`,
                },
                error: null,
              };
        },
      }),
    },
  }),
}));

import { GET } from './route';

const call = () =>
  GET(new Request('http://localhost/x'), {
    params: Promise.resolve({ documentId: 'd1' }),
  });

beforeEach(() => {
  h.auth = 'ok';
  h.doc = {
    id: 'd1',
    account_id: 'acc1',
    storage_path: 'account-acc1/c1/f.pdf',
    file_deleted_at: null,
  };
  h.logged = [];
  h.logError = null;
  h.signed = [];
  h.signError = null;
});

describe('GET /api/applications/documents/[documentId]/url', () => {
  it('is 401 without a session', async () => {
    h.auth = 'unauthorized';
    expect((await call()).status).toBe(401);
    expect(h.signed).toHaveLength(0);
    expect(h.logged).toHaveLength(0);
  });

  it('is 403 for a viewer outside the account (row security returns no row)', async () => {
    h.doc = null;
    const res = await call();
    expect(res.status).toBe(403);
    expect(h.signed).toHaveLength(0);
    expect(h.logged).toHaveLength(0);
  });

  it('is 403 when the row belongs to another account, even if it came back', async () => {
    h.doc = { ...h.doc, account_id: 'acc2' };
    expect((await call()).status).toBe(403);
    expect(h.signed).toHaveLength(0);
  });

  it('returns a 60 second signed URL, uncached, and logs the open', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.url).toBe(
      'https://files.example.invalid/account-acc1/c1/f.pdf?t=1'
    );
    expect(h.signed).toEqual([
      {
        bucket: 'application-docs',
        path: 'account-acc1/c1/f.pdf',
        expiresIn: 60,
      },
    ]);
    expect(h.logged).toEqual([
      { account_id: 'acc1', document_id: 'd1', user_id: 'u1' },
    ]);
  });

  it('gives no link when the log row cannot be written', async () => {
    h.logError = { message: 'denied' };
    const res = await call();
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(h.signed).toHaveLength(0);
  });

  it('is 410 once the file was deleted, and logs nothing', async () => {
    h.doc = { ...h.doc, file_deleted_at: '2026-11-01T00:00:00Z' };
    const res = await call();
    expect(res.status).toBe(410);
    expect(h.signed).toHaveLength(0);
    expect(h.logged).toHaveLength(0);
  });

  it('is 404 when the document has no stored file yet', async () => {
    h.doc = { ...h.doc, storage_path: null };
    expect((await call()).status).toBe(404);
    expect(h.signed).toHaveLength(0);
  });

  it('is 500 when signing fails', async () => {
    h.signError = { message: 'down' };
    const res = await call();
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
