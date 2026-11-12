import type { SupabaseClient } from '@supabase/supabase-js';

import {
  findExistingContact,
  HIDDEN_DUPLICATE_MESSAGE,
  isUniqueViolation,
} from '@/lib/contacts/dedupe';
import { normalizeIndianPhone } from '@/lib/admissions/normalize';

/**
 * Referrer lookup for the contact forms (migration 096:
 * contacts.referred_by_contact_id).
 *
 * Pass the caller's own RLS session client, never the service client: row
 * security then keeps another account's contacts and the counsellor-number
 * contacts hidden from agents out of every result, and the explicit
 * account filter keeps an admin's view to one account too.
 */

export interface ReferrerOption {
  id: string;
  name: string | null;
  phone: string;
}

const MIN_QUERY = 2;
const MAX_RESULTS = 8;

/** Name or phone search inside one account. */
export async function searchReferrers(
  db: SupabaseClient,
  accountId: string,
  query: string,
  excludeContactId?: string,
): Promise<ReferrerOption[]> {
  // Characters with meaning in a PostgREST or() filter or an ilike pattern.
  const q = query.replace(/[,()%*\\_"']/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < MIN_QUERY) return [];

  const clauses = [`name.ilike.%${q}%`, `phone.ilike.%${q}%`];
  const digits = q.replace(/\D/g, '');
  if (digits.length >= MIN_QUERY) {
    clauses.push(`phone_normalized.ilike.%${digits}%`);
  }

  let req = db
    .from('contacts')
    .select('id, name, phone')
    .eq('account_id', accountId)
    .or(clauses.join(','))
    .order('name', { ascending: true })
    .limit(MAX_RESULTS);
  if (excludeContactId) req = req.neq('id', excludeContactId);

  const { data, error } = await req;
  if (error || !data) return [];
  return data as ReferrerOption[];
}

export type CreateReferrerResult =
  | { ok: true; referrer: ReferrerOption }
  | { ok: false; error: string; existing?: ReferrerOption };

/**
 * "New person": a plain contact (name + phone) in the same account. The
 * referrer's own `source` is left alone; only the referred student is
 * marked Reference.
 */
export async function createReferrer(
  db: SupabaseClient,
  input: { accountId: string; userId: string; name: string; phone: string },
): Promise<CreateReferrerResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Name is required' };
  if (!input.phone.trim()) return { ok: false, error: 'Phone is required' };

  // Kuanli stores the 91-prefixed 12-digit form; imports that skip this
  // silently duplicate contacts.
  const { phone } = normalizeIndianPhone(input.phone);
  if (!phone) {
    return {
      ok: false,
      error: 'Enter an Indian mobile number: 10 digits, or with 91 in front',
    };
  }

  // Same check the contact form uses: a match in any number format means
  // link that person, not create a second one. Visible contacts only (RLS).
  const existing = await findExistingContact(db, input.accountId, phone);
  if (existing) {
    return {
      ok: false,
      error: 'This number is already a contact. Link that person instead.',
      existing: {
        id: existing.id,
        name: (existing.name as string | null) ?? null,
        phone: existing.phone,
      },
    };
  }

  const { data, error } = await db
    .from('contacts')
    .insert({
      user_id: input.userId,
      account_id: input.accountId,
      name,
      phone,
    })
    .select('id, name, phone')
    .single();

  if (error || !data) {
    // A number we could not see above but the database refuses: it belongs
    // to a contact hidden from this user. Say no more than that.
    if (isUniqueViolation(error)) {
      return { ok: false, error: HIDDEN_DUPLICATE_MESSAGE };
    }
    return { ok: false, error: 'Could not add this person' };
  }
  return { ok: true, referrer: data as ReferrerOption };
}
