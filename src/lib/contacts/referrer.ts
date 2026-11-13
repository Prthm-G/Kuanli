import type { SupabaseClient } from '@supabase/supabase-js';

import {
  HIDDEN_DUPLICATE_MESSAGE,
  isExactMatch,
  isUniqueViolation,
  type ExistingContact,
} from '@/lib/contacts/dedupe';
import { normalizeIndianPhone } from '@/lib/admissions/normalize';
import { normalizePhone, phonesMatch } from '@/lib/whatsapp/phone-utils';

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
  | {
      ok: false;
      error: string;
      /** A contact with this number (or a close variant) already exists. */
      existing?: ReferrerOption;
      /** True when the digits are identical: creating another is blocked.
       *  False is a last-8-digit look-alike: warn, but "create anyway" works. */
      exact?: boolean;
    };

/**
 * "New person": a plain contact (name + phone) in the same account. The
 * referrer's own `source` is left alone; only the referred student is
 * marked Reference.
 */
/**
 * Indian shapes become the 91-prefixed 12-digit form Kuanli stores; anything
 * else must be 7-15 digits with its country code (as the contact form allows).
 */
function normalizeReferrerPhone(raw: string): string | null {
  const indian = normalizeIndianPhone(raw).phone;
  if (indian) return indian;
  const digits = normalizePhone(raw);
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/** Visible contacts matching `phone`, an exact match first. */
async function findPhoneMatch(
  db: SupabaseClient,
  accountId: string,
  phone: string,
): Promise<{ contact: ExistingContact; exact: boolean } | null> {
  const suffix = phone.length >= 8 ? phone.slice(-8) : phone;
  const { data, error } = await db
    .from('contacts')
    .select('id, name, phone')
    .eq('account_id', accountId)
    .like('phone', `%${suffix}`);
  if (error || !data) return null;
  const matches = (data as ExistingContact[]).filter((c) =>
    phonesMatch(c.phone, phone),
  );
  const exact = matches.find((c) => isExactMatch(c, phone));
  if (exact) return { contact: exact, exact: true };
  return matches[0] ? { contact: matches[0], exact: false } : null;
}

export async function createReferrer(
  db: SupabaseClient,
  input: { accountId: string; userId: string; name: string; phone: string },
  opts: { allowFuzzy?: boolean } = {},
): Promise<CreateReferrerResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Name is required' };
  if (!input.phone.trim()) return { ok: false, error: 'Phone is required' };

  const phone = normalizeReferrerPhone(input.phone);
  if (!phone) {
    return {
      ok: false,
      error: 'Enter a phone number with its country code (7 to 15 digits)',
    };
  }

  // Same rule as the contact form: identical digits block, a look-alike only
  // warns. Visible contacts only (RLS).
  const match = await findPhoneMatch(db, input.accountId, phone);
  if (match && (match.exact || !opts.allowFuzzy)) {
    return {
      ok: false,
      error: match.exact
        ? 'This number is already a contact. Link that person instead.'
        : 'A contact with a very similar number exists. Link them, or create anyway.',
      exact: match.exact,
      existing: {
        id: match.contact.id,
        name: (match.contact.name as string | null) ?? null,
        phone: match.contact.phone,
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
