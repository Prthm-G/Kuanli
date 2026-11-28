import type { SupabaseClient } from '@supabase/supabase-js';

export type StudentMatch =
  | 'name'
  | 'phone'
  | 'email'
  | 'provisional_id'
  | 'university_app_number'
  | 'registration_number'
  | 'roll_number';

export interface StudentHit {
  contactId: string;
  name: string | null;
  phone: string | null;
  university: string | null;
  provisionalAppId: string | null;
  universityAppNumber: string | null;
  registrationNumber: string | null;
  matched: StudentMatch;
}

interface StudentRow {
  contact_id: string;
  name: string | null;
  phone: string | null;
  university: string | null;
  provisional_app_id: string | null;
  university_app_number: string | null;
  registration_number: string | null;
  matched: StudentMatch;
}

const LABELS: Record<StudentMatch, string> = {
  provisional_id: 'Provisional ID',
  university_app_number: 'Univ. app no.',
  registration_number: 'Reg. no.',
  phone: 'Phone',
  email: 'Email',
  roll_number: 'Roll no.',
  name: 'Name',
};

/** Short label for the field a search hit matched on. */
export function matchLabel(matched: StudentMatch): string {
  return LABELS[matched] ?? matched;
}

/**
 * Student lookup for the header search (104 `search_students` RPC): name,
 * phone, email, provisional ID, university application number, registration
 * or roll number. RLS-filtered and capped server-side. Throws on RPC error.
 */
export async function searchStudents(
  db: SupabaseClient,
  accountId: string,
  q: string
): Promise<StudentHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const { data, error } = await db.rpc('search_students', {
    p_account: accountId,
    p_q: term,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as StudentRow[]).map((r) => ({
    contactId: r.contact_id,
    name: r.name,
    phone: r.phone,
    university: r.university,
    provisionalAppId: r.provisional_app_id,
    universityAppNumber: r.university_app_number,
    registrationNumber: r.registration_number,
    matched: r.matched,
  }));
}
