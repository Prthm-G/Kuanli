// ============================================================
// POST /api/applications/verify   { documentId }
//
// Verify one application document and archive its bytes.
//
// messages.media_url is a proxy over Meta's media store, which
// expires after ~30 days — verified documents are permanent
// records (marksheets, IDs), so verification downloads the file
// and stores it in the PRIVATE `application-docs` bucket at
// application-docs/account-<id>/<contact>/<doc>.<ext>.
//
// Authorization is two-layered: the caller's own session client
// performs the row UPDATE, so RLS enforces the agent+ policy
// from migration 045; only the storage write uses the service
// client (the bucket is private and the archive path is server-
// derived, never caller input).
//
// If Meta no longer has the media (expired), the verify still
// proceeds — the row is marked verified with no storage_path and
// the response says archived:false so the UI can warn. Blocking
// verification on expired media would leave counsellors unable
// to accept documents they can no longer re-request cheaply.
// ============================================================

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { getPrimaryConfig } from '@/lib/whatsapp/config-resolver';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';

const BUCKET = 'application-docs';

function extensionFor(contentType: string): string {
  if (contentType.includes('pdf')) return 'pdf';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  return 'jpg';
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let documentId: string | undefined;
  try {
    ({ documentId } = await request.json());
  } catch {
    // fall through to the check below
  }
  if (!documentId || typeof documentId !== 'string') {
    return NextResponse.json(
      { error: 'documentId is required' },
      { status: 400 }
    );
  }

  // RLS scopes this read to the caller's account.
  const { data: doc, error: docErr } = await supabase
    .from('application_documents')
    .select('id, account_id, contact_id, message_id, storage_path')
    .eq('id', documentId)
    .maybeSingle();
  if (docErr || !doc) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }

  // Archive first (best-effort), then verify.
  let storagePath: string | null = doc.storage_path ?? null;
  let archiveError: string | null = null;

  if (!storagePath && doc.message_id) {
    try {
      const { data: message } = await supabase
        .from('messages')
        .select('media_url')
        .eq('id', doc.message_id)
        .maybeSingle();
      const mediaId = message?.media_url?.match(
        /^\/api\/whatsapp\/media\/(.+)$/
      )?.[1];
      if (!mediaId) throw new Error('message has no proxied media');

      const config = await getPrimaryConfig(supabase, doc.account_id);
      const accessToken = decrypt(config.access_token);
      const mediaInfo = await getMediaUrl({ mediaId, accessToken });
      const { buffer, contentType } = await downloadMedia({
        downloadUrl: mediaInfo.url,
        accessToken,
      });

      const path = `account-${doc.account_id}/${doc.contact_id}/${doc.id}.${extensionFor(contentType)}`;
      const { error: upErr } = await supabaseAdmin()
        .storage.from(BUCKET)
        .upload(path, buffer, { contentType, upsert: true });
      if (upErr) throw new Error(upErr.message);
      storagePath = path;
    } catch (e) {
      archiveError = e instanceof Error ? e.message : String(e);
    }
  }

  // The caller's client performs the update, so the agent+ RLS policy from
  // migration 045 is what authorizes verification.
  const { error: updErr } = await supabase
    .from('application_documents')
    .update({
      status: 'verified',
      storage_path: storagePath,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', documentId);
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 403 });
  }

  return NextResponse.json({
    verified: true,
    archived: !!storagePath,
    archive_error: archiveError,
  });
}
