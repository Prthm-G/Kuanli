import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Reads and writes for the sidebar's Application panel and Documents tab.
 * Saves go to `applications` only; the database triggers move the cards
 * (migration 096), so nothing here touches deals or calls advance_application.
 */

export interface ApplicationRecord {
  id: string;
  accountId: string;
  contactId: string;
  university: string | null;
  fatherName: string | null;
  program: string | null;
  specialization: string | null;
  detailsPunchedAt: string | null;
  detailsPunchedBy: string | null;
  provisionalAppId: string | null;
  formFilledByKind: 'student' | 'staff' | null;
  formFilledBy: string | null;
  formFilledAt: string | null;
  registrationNumber: string | null;
  retainFiles: boolean;
}

export interface SaveApplicationInput {
  accountId: string;
  contactId: string;
  fatherName?: string | null;
  program?: string | null;
  specialization?: string | null;
  provisionalAppId?: string | null;
  registrationNumber?: string | null;
  /** Stamps details_punched_at now and details_punched_by with this person. */
  detailsPunchedBy?: string;
  /** Stamps form_filled_* now; a student fill records no staff member. */
  formFilledBy?: { kind: 'student' | 'staff'; userId: string };
  retainFiles?: boolean;
}

export class ApplicationDbError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ApplicationDbError';
    this.code = code;
  }
}

const blankToNull = (v: string | null): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

const COLUMNS =
  'id, account_id, contact_id, university, father_name, program, specialization, details_punched_at, details_punched_by, provisional_app_id, form_filled_by_kind, form_filled_by, form_filled_at, registration_number, retain_files';

export async function loadApplication(
  db: SupabaseClient,
  contactId: string
): Promise<ApplicationRecord | null> {
  const { data, error } = await db
    .from('applications')
    .select(COLUMNS)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (error) throw new ApplicationDbError(error.message, error.code);
  if (!data) return null;
  const r = data as Record<string, unknown>;
  const s = (k: string) => (r[k] == null ? null : String(r[k]));
  const kind = s('form_filled_by_kind');
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    contactId: String(r.contact_id),
    university: s('university'),
    fatherName: s('father_name'),
    program: s('program'),
    specialization: s('specialization'),
    detailsPunchedAt: s('details_punched_at'),
    detailsPunchedBy: s('details_punched_by'),
    provisionalAppId: s('provisional_app_id'),
    formFilledByKind: kind === 'student' || kind === 'staff' ? kind : null,
    formFilledBy: s('form_filled_by'),
    formFilledAt: s('form_filled_at'),
    registrationNumber: s('registration_number'),
    retainFiles: r.retain_files === true,
  };
}

/** Upsert on contact_id. Only the fields given are written; blank text becomes null. */
export async function saveApplication(
  db: SupabaseClient,
  input: SaveApplicationInput
): Promise<void> {
  const row: Record<string, unknown> = {
    account_id: input.accountId,
    contact_id: input.contactId,
  };
  const text: Array<[keyof SaveApplicationInput, string]> = [
    ['fatherName', 'father_name'],
    ['program', 'program'],
    ['specialization', 'specialization'],
    ['provisionalAppId', 'provisional_app_id'],
    ['registrationNumber', 'registration_number'],
  ];
  for (const [key, col] of text) {
    const v = input[key];
    if (v !== undefined) row[col] = blankToNull(v as string | null);
  }
  if (input.detailsPunchedBy) {
    row.details_punched_at = new Date().toISOString();
    row.details_punched_by = input.detailsPunchedBy;
  }
  if (input.formFilledBy) {
    row.form_filled_by_kind = input.formFilledBy.kind;
    row.form_filled_by =
      input.formFilledBy.kind === 'staff' ? input.formFilledBy.userId : null;
    row.form_filled_at = new Date().toISOString();
  }
  if (input.retainFiles !== undefined) row.retain_files = input.retainFiles;

  const { error } = await db
    .from('applications')
    .upsert(row, { onConflict: 'contact_id' });
  if (error) throw new ApplicationDbError(error.message, error.code);
}

/** Marks every required document of the student as uploaded to the portal; returns how many changed. */
export async function markAllUploaded(
  db: SupabaseClient,
  contactId: string
): Promise<number> {
  const { data, error } = await db.rpc('mark_documents_uploaded', {
    p_contact_id: contactId,
  });
  if (error) throw new ApplicationDbError(error.message, error.code);
  return typeof data === 'number' ? data : 0;
}

export async function setDocumentUploaded(
  db: SupabaseClient,
  documentId: string,
  userId: string,
  uploaded: boolean
): Promise<void> {
  const { error } = await db
    .from('application_documents')
    .update(
      uploaded
        ? {
            uploaded_to_portal_at: new Date().toISOString(),
            uploaded_to_portal_by: userId,
          }
        : { uploaded_to_portal_at: null, uploaded_to_portal_by: null }
    )
    .eq('id', documentId);
  if (error) throw new ApplicationDbError(error.message, error.code);
}

export interface ContactDocument {
  id: string;
  docType: string | null;
  status: 'received' | 'verified' | 'rejected';
  mimeType: string | null;
  storagePath: string | null;
  createdAt: string;
  uploadedToPortalAt: string | null;
  fileDeletedAt: string | null;
}

export interface RequiredDocumentRow {
  docType: string;
  label: string;
  /** The newest file of this type. */
  doc: ContactDocument | null;
}

export interface ContactDocuments {
  required: RequiredDocumentRow[];
  /** Everything else: older files of a required type, unsorted files, other types. */
  other: ContactDocument[];
}

export async function loadContactDocuments(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  university: string
): Promise<ContactDocuments> {
  const [reqRes, docRes] = await Promise.all([
    db
      .from('university_required_docs')
      .select('doc_type, label, position')
      .eq('account_id', accountId)
      .eq('university', university)
      .order('position'),
    db
      .from('application_documents')
      .select(
        'id, doc_type, status, mime_type, storage_path, created_at, uploaded_to_portal_at, file_deleted_at'
      )
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false }),
  ]);
  if (reqRes.error)
    throw new ApplicationDbError(reqRes.error.message, reqRes.error.code);
  if (docRes.error)
    throw new ApplicationDbError(docRes.error.message, docRes.error.code);

  const docs: ContactDocument[] = (
    (docRes.data ?? []) as Array<Record<string, unknown>>
  ).map((d) => ({
    id: String(d.id),
    docType: d.doc_type == null ? null : String(d.doc_type),
    status: (d.status as ContactDocument['status']) ?? 'received',
    mimeType: d.mime_type == null ? null : String(d.mime_type),
    storagePath: d.storage_path == null ? null : String(d.storage_path),
    createdAt: String(d.created_at ?? ''),
    uploadedToPortalAt:
      d.uploaded_to_portal_at == null ? null : String(d.uploaded_to_portal_at),
    fileDeletedAt: d.file_deleted_at == null ? null : String(d.file_deleted_at),
  }));

  const shown = new Set<string>();
  const required = (
    (reqRes.data ?? []) as Array<{ doc_type: string; label: string }>
  ).map((r) => {
    const doc = docs.find((d) => d.docType === r.doc_type) ?? null;
    if (doc) shown.add(doc.id);
    return { docType: r.doc_type, label: r.label, doc };
  });
  return { required, other: docs.filter((d) => !shown.has(d.id)) };
}
