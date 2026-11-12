import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/applications/documents: a counsellor uploads a file for a student.
 * The bytes decide the type, the path is server-made, and the row starts at
 * `received`.
 */

const h = vi.hoisted(() => ({
  auth: 'ok' as 'ok' | 'unauthorized' | 'forbidden',
  contact: { id: 'c1', account_id: 'acc1' } as {
    id: string;
    account_id: string;
  } | null,
  uploads: [] as Array<{
    bucket: string;
    path: string;
    contentType?: string;
    upsert?: boolean;
  }>,
  removed: [] as string[],
  inserted: [] as Array<Record<string, unknown>>,
  uploadError: null as { message: string } | null,
  insertError: null as { message: string } | null,
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
      if (h.auth === 'forbidden') throw new actual.ForbiddenError();
      return {
        accountId: 'acc1',
        userId: 'u1',
        role: 'agent',
        supabase: {
          from: (table: string) => {
            const b = {
              select: () => b,
              eq: () => b,
              maybeSingle: async () => ({
                data: table === 'contacts' ? h.contact : null,
                error: null,
              }),
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
        upload: async (
          path: string,
          _body: unknown,
          opts: { contentType?: string; upsert?: boolean }
        ) => {
          h.uploads.push({ bucket, path, ...opts });
          return { error: h.uploadError };
        },
        remove: async (paths: string[]) => {
          h.removed.push(...paths);
          return { error: null };
        },
      }),
    },
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        h.inserted.push({ table, ...row });
        return {
          select: () => ({
            single: async () => ({
              data: h.insertError ? null : { id: 'doc1', ...row },
              error: h.insertError,
            }),
          }),
        };
      },
    }),
  }),
}));

import { POST } from './route';

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37];

function req(opts: {
  file?: File | null;
  contactId?: string | null;
  docType?: string;
}) {
  const form = new FormData();
  if (opts.file !== null) {
    form.set('file', opts.file ?? new File([new Uint8Array(PDF)], 'a.pdf'));
  }
  if (opts.contactId !== null) form.set('contactId', opts.contactId ?? 'c1');
  if (opts.docType !== undefined) form.set('docType', opts.docType);
  return new Request('http://localhost/api/applications/documents', {
    method: 'POST',
    body: form,
  });
}

beforeEach(() => {
  h.auth = 'ok';
  h.contact = { id: 'c1', account_id: 'acc1' };
  h.uploads = [];
  h.removed = [];
  h.inserted = [];
  h.uploadError = null;
  h.insertError = null;
});

describe('POST /api/applications/documents', () => {
  it('is 401 without a session', async () => {
    h.auth = 'unauthorized';
    const res = await POST(req({}));
    expect(res.status).toBe(401);
    expect(h.uploads).toHaveLength(0);
  });

  it('is 403 below the agent role', async () => {
    h.auth = 'forbidden';
    const res = await POST(req({}));
    expect(res.status).toBe(403);
    expect(h.uploads).toHaveLength(0);
  });

  it('is 400 when the file or the contact is missing', async () => {
    expect((await POST(req({ file: null }))).status).toBe(400);
    expect((await POST(req({ contactId: null }))).status).toBe(400);
    expect(h.uploads).toHaveLength(0);
  });

  it('is 400 for bytes that are not pdf, jpeg, png or webp, whatever the name says', async () => {
    const file = new File(['<script>alert(1)</script>'], 'marksheet.pdf', {
      type: 'application/pdf',
    });
    const res = await POST(req({ file }));
    expect(res.status).toBe(400);
    expect(h.uploads).toHaveLength(0);
    expect(h.inserted).toHaveLength(0);
  });

  it('is 400 over 16 MB', async () => {
    const big = new Uint8Array(16 * 1024 * 1024 + 1);
    big.set(PDF);
    const res = await POST(req({ file: new File([big], 'big.pdf') }));
    expect(res.status).toBe(400);
    expect(h.uploads).toHaveLength(0);
  });

  it('is 404 for a contact the caller cannot see (row security hides it)', async () => {
    h.contact = null;
    const res = await POST(req({}));
    expect(res.status).toBe(404);
    expect(h.uploads).toHaveLength(0);
  });

  it('stores under account-<acct>/<contact>/<uuid>.<ext> in application-docs and inserts a received row', async () => {
    const res = await POST(req({ docType: 'photo' }));
    expect(res.status).toBe(201);
    expect(h.uploads).toHaveLength(1);
    const up = h.uploads[0];
    expect(up.bucket).toBe('application-docs');
    expect(up.path).toMatch(
      /^account-acc1\/c1\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/
    );
    expect(up.contentType).toBe('application/pdf');
    expect(up.upsert).toBe(false);
    expect(h.inserted).toEqual([
      expect.objectContaining({
        table: 'application_documents',
        account_id: 'acc1',
        contact_id: 'c1',
        doc_type: 'photo',
        status: 'received',
        mime_type: 'application/pdf',
        storage_path: up.path,
      }),
    ]);
  });

  it('ignores the uploaded file name when it makes the path', async () => {
    const file = new File(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xe0])],
      '../../x.exe'
    );
    const res = await POST(req({ file }));
    expect(res.status).toBe(201);
    expect(h.uploads[0].path).toMatch(/^account-acc1\/c1\/[0-9a-f-]{36}\.jpg$/);
  });

  it('stores a blank or odd doc type as null', async () => {
    await POST(req({ docType: '   ' }));
    expect(h.inserted[0].doc_type).toBeNull();
    await POST(req({ docType: 'x/../y' }));
    expect(h.inserted[1].doc_type).toBeNull();
  });

  it('removes the stored file when the row cannot be inserted', async () => {
    h.insertError = { message: 'nope' };
    const res = await POST(req({}));
    expect(res.status).toBe(500);
    expect(h.removed).toEqual([h.uploads[0].path]);
  });

  it('is 500 when storage refuses and inserts nothing', async () => {
    h.uploadError = { message: 'down' };
    const res = await POST(req({}));
    expect(res.status).toBe(500);
    expect(h.inserted).toHaveLength(0);
  });
});
