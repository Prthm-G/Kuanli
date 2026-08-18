import type { SupabaseClient } from '@supabase/supabase-js';

import type { DocStatus, TrackerContact } from './types';

/**
 * Load the application tracker via the `application_tracker` RPC
 * (migration 046): contacts at Application Started / Enrolled with their
 * checklist state and unsorted captured documents.
 */
export async function loadApplicationTracker(
  supabase: SupabaseClient,
  accountId: string
): Promise<TrackerContact[]> {
  const { data, error } = await supabase.rpc('application_tracker', {
    p_account_id: accountId,
  });

  if (error)
    throw new Error(`Application tracker query failed: ${error.message}`);

  type Raw = Array<{
    contact_id?: string;
    name?: string | null;
    phone?: string | null;
    roll_number?: string | null;
    university?: string | null;
    stage?: string;
    conversation_id?: string | null;
    required?: Array<{
      doc_type?: string;
      label?: string;
      status?: string;
      document_id?: string | null;
    }>;
    unsorted?: Array<{
      document_id?: string;
      created_at?: string;
      media_url?: string | null;
      content_text?: string | null;
      content_type?: string | null;
    }>;
  }>;

  return ((data ?? []) as unknown as Raw).map((c) => ({
    contactId: c.contact_id ?? '',
    name: c.name ?? null,
    phone: c.phone ?? null,
    rollNumber: c.roll_number ?? null,
    university: c.university ?? null,
    stage: c.stage ?? '',
    conversationId: c.conversation_id ?? null,
    required: (c.required ?? []).map((r) => ({
      docType: r.doc_type ?? '',
      label: r.label ?? '',
      status: (r.status ?? 'missing') as DocStatus,
      documentId: r.document_id ?? null,
    })),
    unsorted: (c.unsorted ?? []).map((u) => ({
      documentId: u.document_id ?? '',
      createdAt: u.created_at ?? '',
      mediaUrl: u.media_url ?? null,
      contentText: u.content_text ?? null,
      contentType: u.content_type ?? null,
    })),
  }));
}
