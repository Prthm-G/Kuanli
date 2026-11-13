// ============================================================
// GET /api/applications/documents/[documentId]/url
//
// A signed link to one stored document, valid for a minute and never
// cached. Marksheets and IDs are PII, so every open is written to
// document_access_log first, with the caller's own session (row security
// lets a member log only themselves); if that write fails no link is given.
//
// The document row is read with the caller's client: another account's
// document is invisible to them and answers 403, the same as one that
// does not exist.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

const BUCKET = 'application-docs';
const NO_STORE = { 'Cache-Control': 'no-store' };

const fail = (error: string, status: number) =>
  NextResponse.json({ error }, { status, headers: NO_STORE });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> }
) {
  let ctx;
  try {
    ctx = await requireRole('viewer');
  } catch (err) {
    const res = toErrorResponse(err);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
  const { documentId } = await params;

  const { data: doc } = await ctx.supabase
    .from('application_documents')
    .select('id, account_id, storage_path, file_deleted_at')
    .eq('id', documentId)
    .maybeSingle();
  if (!doc || doc.account_id !== ctx.accountId) return fail('Forbidden', 403);
  if (doc.file_deleted_at) return fail('This file was deleted', 410);
  if (!doc.storage_path)
    return fail('This document has no stored file yet', 404);

  const { error: logErr } = await ctx.supabase
    .from('document_access_log')
    .insert({
      account_id: ctx.accountId,
      document_id: doc.id,
      user_id: ctx.userId,
    });
  if (logErr) {
    console.error(
      '[applications/documents/url] access log failed:',
      logErr.message
    );
    return fail('Could not record the access', 500);
  }

  const { data, error } = await supabaseAdmin()
    .storage.from(BUCKET)
    .createSignedUrl(doc.storage_path, 60);
  if (error || !data?.signedUrl) {
    console.error('[applications/documents/url] sign failed:', error?.message);
    return fail('Could not create the link', 500);
  }

  return NextResponse.json({ url: data.signedUrl }, { headers: NO_STORE });
}
