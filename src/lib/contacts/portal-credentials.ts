/**
 * Validation + serialization for student portal credentials (migration 072).
 *
 * The DB row also holds `password_ciphertext`; that column deliberately has
 * no field here and no wire type — plaintext passwords leave the server only
 * through the reveal route, and ciphertext never leaves it at all.
 * `toMetadata` is the safety net: responses are built exclusively from this
 * explicit field pick, so even a stray `select('*')` in a route cannot
 * serialize the ciphertext into a response.
 */

import type { PortalCredential } from '@/types';

/** Metadata columns the routes are allowed to select and return. */
export const CREDENTIAL_SELECT_COLUMNS =
  'id, contact_id, label, kind, portal_url, username, notes, created_by, created_at, updated_at';

export const CREDENTIAL_KINDS = ['provisional', 'registration', 'other'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export const CREDENTIAL_KIND_LABELS: Record<CredentialKind, string> = {
  provisional: 'Provisional',
  registration: 'Registration',
  other: 'Other',
};

export interface CredentialInput {
  label?: string;
  kind?: CredentialKind;
  portal_url?: string | null;
  username?: string | null;
  password?: string;
  notes?: string | null;
}

type ValidationResult =
  | { ok: true; value: CredentialInput }
  | { ok: false; error: string };

const LIMITS = {
  label: 120,
  portal_url: 2048,
  username: 255,
  password: 1024,
  notes: 2000,
} as const;

/**
 * Hand-rolled validation (repo convention — no schema library). With
 * `partial: false` (create) label and password are required; with
 * `partial: true` (update) any present field is validated and absent
 * fields are left out of the result.
 */
export function validateCredentialInput(
  body: unknown,
  opts: { partial: boolean },
): ValidationResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Invalid request body' };
  }
  const b = body as Record<string, unknown>;
  const value: CredentialInput = {};

  if (b.label !== undefined) {
    if (typeof b.label !== 'string' || !b.label.trim()) {
      return { ok: false, error: 'Label is required' };
    }
    if (b.label.trim().length > LIMITS.label) {
      return { ok: false, error: `Label must be at most ${LIMITS.label} characters` };
    }
    value.label = b.label.trim();
  } else if (!opts.partial) {
    return { ok: false, error: 'Label is required' };
  }

  if (b.kind !== undefined) {
    if (
      typeof b.kind !== 'string' ||
      !(CREDENTIAL_KINDS as readonly string[]).includes(b.kind)
    ) {
      return { ok: false, error: 'Kind must be provisional, registration or other' };
    }
    value.kind = b.kind as CredentialKind;
  } else if (!opts.partial) {
    value.kind = 'other';
  }

  if (b.portal_url !== undefined && b.portal_url !== null && b.portal_url !== '') {
    if (typeof b.portal_url !== 'string' || b.portal_url.length > LIMITS.portal_url) {
      return { ok: false, error: 'Invalid portal URL' };
    }
    if (!/^https?:\/\//i.test(b.portal_url.trim())) {
      return { ok: false, error: 'Portal URL must start with http:// or https://' };
    }
    value.portal_url = b.portal_url.trim();
  } else if (b.portal_url === null || b.portal_url === '') {
    value.portal_url = null;
  }

  if (b.username !== undefined && b.username !== null && b.username !== '') {
    if (typeof b.username !== 'string' || b.username.length > LIMITS.username) {
      return { ok: false, error: 'Invalid username' };
    }
    value.username = b.username.trim();
  } else if (b.username === null || b.username === '') {
    value.username = null;
  }

  if (b.password !== undefined) {
    if (typeof b.password !== 'string' || !b.password) {
      return { ok: false, error: 'Password is required' };
    }
    if (b.password.length > LIMITS.password) {
      return { ok: false, error: `Password must be at most ${LIMITS.password} characters` };
    }
    value.password = b.password;
  } else if (!opts.partial) {
    return { ok: false, error: 'Password is required' };
  }

  if (b.notes !== undefined && b.notes !== null && b.notes !== '') {
    if (typeof b.notes !== 'string' || b.notes.length > LIMITS.notes) {
      return { ok: false, error: 'Invalid notes' };
    }
    value.notes = b.notes.trim();
  } else if (b.notes === null || b.notes === '') {
    value.notes = null;
  }

  return { ok: true, value };
}

/** Explicit field pick — the only path from a DB row to a response body. */
export function toMetadata(row: Record<string, unknown>): PortalCredential {
  return {
    id: String(row.id),
    contact_id: String(row.contact_id),
    label: String(row.label ?? ''),
    kind: (CREDENTIAL_KINDS as readonly string[]).includes(row.kind as string)
      ? (row.kind as CredentialKind)
      : 'other',
    portal_url: (row.portal_url as string | null) ?? null,
    username: (row.username as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    created_by: String(row.created_by ?? ''),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

/**
 * A second provisional or registration login for the same student hits the
 * partial unique index (migration 096) and comes back as 23505. Returns the
 * message to show, or null when the error is something else.
 */
export function duplicateLoginMessage(
  error: unknown,
  kind: CredentialKind | undefined,
): string | null {
  if (!error || typeof error !== 'object') return null;
  if ((error as { code?: string }).code !== '23505') return null;
  if (kind !== 'provisional' && kind !== 'registration') return null;
  return `This student already has a ${kind} login`;
}
