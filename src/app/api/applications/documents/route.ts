// ============================================================
// POST /api/applications/documents   multipart: file, contactId, docType?
//
// A counsellor uploads a student's document from the Documents tab.
//
// The caller's own client proves the contact is theirs (row security
// hides other accounts' contacts); the service client writes, because
// the bucket is private and `authenticated` holds no INSERT on
// application_documents. The type comes from the file's bytes, the
// path from the server (account / contact / random uuid): neither the
// file name nor the browser's content type is trusted.
// ============================================================

import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  detectFileType,
  extensionFor,
  mimeFor,
} from '@/lib/applications/file-type';

const BUCKET = 'application-docs';
const MAX_BYTES = 16 * 1024 * 1024;
const DOC_TYPE = /^[a-z0-9_]{1,40}$/;

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: 'Expected a form upload' },
      { status: 400 }
    );
  }
  const file = form.get('file');
  const contactId = form.get('contactId');
  if (!(file instanceof File) || typeof contactId !== 'string' || !contactId) {
    return NextResponse.json(
      { error: 'file and contactId are required' },
      { status: 400 }
    );
  }
  if (file.size === 0 || file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: 'The file must be between 1 byte and 16 MB' },
      { status: 400 }
    );
  }

  const rawType = form.get('docType');
  const docType =
    typeof rawType === 'string' && DOC_TYPE.test(rawType.trim())
      ? rawType.trim()
      : null;

  const { data: contact } = await ctx.supabase
    .from('contacts')
    .select('id, account_id')
    .eq('id', contactId)
    .maybeSingle();
  if (!contact || contact.account_id !== ctx.accountId) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectFileType(bytes);
  if (!type) {
    return NextResponse.json(
      { error: 'Only PDF, JPEG, PNG or WebP files are accepted' },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();
  const path = `account-${ctx.accountId}/${contact.id}/${randomUUID()}.${extensionFor(type)}`;
  const mime = mimeFor(type);

  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (upErr) {
    console.error('[applications/documents] upload failed:', upErr.message);
    return NextResponse.json(
      { error: 'Could not store the file' },
      { status: 500 }
    );
  }

  const { data: row, error: insErr } = await admin
    .from('application_documents')
    .insert({
      account_id: ctx.accountId,
      contact_id: contact.id,
      doc_type: docType,
      status: 'received',
      mime_type: mime,
      storage_path: path,
    })
    .select('id, doc_type, status, mime_type, storage_path, created_at')
    .single();
  if (insErr || !row) {
    console.error('[applications/documents] insert failed:', insErr?.message);
    // No orphan bytes behind a row that never existed.
    await admin.storage.from(BUCKET).remove([path]);
    return NextResponse.json(
      { error: 'Could not save the document' },
      { status: 500 }
    );
  }

  return NextResponse.json({ document: row }, { status: 201 });
}
