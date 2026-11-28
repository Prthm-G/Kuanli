import type { SupabaseClient } from '@supabase/supabase-js';

import type { FollowUpMethod, FollowUpOutcome } from '@/lib/followups/types';

/**
 * "Same student" reads and link writes (migration 106). The RPCs are SECURITY INVOKER: RLS decides every row, so a
 * record the caller cannot see is simply absent (never counted). Errors carry fixed text; the PostgREST message is
 * logged, not shown, because it can echo input.
 */
export type StudentVia = 'self' | 'phone' | 'link';

export interface StudentRecord {
  contactId: string;
  via: StudentVia;
  /** contact_links.id that brought a `link` record in; null for self/phone. */
  linkId: string | null;
  name: string | null;
  phone: string | null;
  hasApplication: boolean;
}

export type StudentTimelineKind = 'follow_up' | 'bot_follow_up' | 'note' | 'stage';

export interface StudentTimelineItem {
  kind: StudentTimelineKind;
  id: string;
  at: string;
  who: string | null;
  summary: string;
  contactId: string;
  phoneLast4: string | null;
  method: FollowUpMethod | null;
  outcome: FollowUpOutcome | null;
  nextDueAt: string | null;
  nextMethod: FollowUpMethod | null;
}

export const TIMELINE_PAGE = 50;

/** Thrown by linkStudents when the pair is marked "not the same student" (SQLSTATE P0001 from migration 106). */
export class NotSameStudentError extends Error {
  constructor() {
    super('Marked as not the same student; remove that first');
    this.name = 'NotSameStudentError';
  }
}

function fail(label: string, error: { message: string }): never {
  console.error(`${label}:`, error.message);
  throw new Error(label);
}

/** The (contact_a, contact_b) order the tables' CHECK wants: Postgres compares uuids as lowercase hex. */
export function orderedPair(a: string, b: string): [string, string] {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) throw new Error('A record cannot be linked to itself');
  return x < y ? [x, y] : [y, x];
}

export function recordLabel(r: Pick<StudentRecord, 'name' | 'phone'>): string {
  const name = r.name?.trim();
  if (name) return name;
  const digits = (r.phone ?? '').replace(/\D/g, '');
  return digits ? `…${digits.slice(-4)}` : 'Unnamed record';
}

/** Names for "These may be different students" when 2+ records each hold an application; else null. */
export function differentStudentsWarning(records: StudentRecord[]): string[] | null {
  const withApp = records.filter((r) => r.hasApplication);
  return withApp.length >= 2 ? withApp.map(recordLabel) : null;
}

const VIA_RANK: Record<StudentVia, number> = { self: 0, phone: 1, link: 2 };

export async function loadStudentSet(db: SupabaseClient, accountId: string, contactId: string): Promise<StudentRecord[]> {
  const { data, error } = await db.rpc('student_set', { p_account: accountId, p_contact: contactId });
  if (error) fail('Could not load linked records', error);
  const set = (data ?? []) as Array<{ contact_id: string; via: StudentVia; link_id: string | null }>;
  if (set.length === 0) return [];
  const ids = set.map((r) => r.contact_id);
  const [contacts, apps] = await Promise.all([
    db.from('contacts').select('id, name, phone').in('id', ids),
    db.from('applications').select('contact_id').in('contact_id', ids),
  ]);
  if (contacts.error) fail('Could not load linked records', contacts.error);
  if (apps.error) fail('Could not load linked records', apps.error);
  const byId = new Map(((contacts.data ?? []) as Array<{ id: string; name: string | null; phone: string | null }>).map((c) => [c.id, c]));
  const withApp = new Set(((apps.data ?? []) as Array<{ contact_id: string }>).map((a) => a.contact_id));
  return set
    .filter((r) => byId.has(r.contact_id))
    .map((r) => {
      const c = byId.get(r.contact_id)!;
      return { contactId: r.contact_id, via: r.via, linkId: r.link_id ?? null, name: c.name ?? null, phone: c.phone ?? null,
               hasApplication: withApp.has(r.contact_id) };
    })
    .sort((a, b) => VIA_RANK[a.via] - VIA_RANK[b.via] || recordLabel(a).localeCompare(recordLabel(b)));
}

export async function loadStudentTimeline(db: SupabaseClient, accountId: string, contactId: string,
                                          before: string | null = null, limit: number = TIMELINE_PAGE): Promise<StudentTimelineItem[]> {
  const { data, error } = await db.rpc('student_timeline', { p_account: accountId, p_contact: contactId, p_before: before, p_limit: limit });
  if (error) fail('Could not load activity', error);
  type Raw = { kind: StudentTimelineKind; id: string; at: string; who: string | null; summary: string; contact_id: string;
               phone_last4: string | null; method: FollowUpMethod | null; outcome: FollowUpOutcome | null;
               next_due_at: string | null; next_method: FollowUpMethod | null };
  return ((data ?? []) as unknown as Raw[]).map((r) => ({
    kind: r.kind, id: r.id, at: r.at, who: r.who ?? null, summary: r.summary, contactId: r.contact_id,
    phoneLast4: r.phone_last4 ?? null, method: r.method ?? null, outcome: r.outcome ?? null,
    nextDueAt: r.next_due_at ?? null, nextMethod: r.next_method ?? null,
  }));
}

export async function loadBranchAndOwner(db: SupabaseClient, branchId: string | null, ownerProfileId: string | null):
  Promise<{ branchName: string | null; ownerName: string | null }> {
  const [branch, owner] = await Promise.all([
    branchId ? db.from('branches').select('name').eq('id', branchId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ownerProfileId ? db.from('profiles').select('full_name').eq('id', ownerProfileId).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  if (branch.error) fail('Could not load branch', branch.error);
  if (owner.error) fail('Could not load owner', owner.error);
  return {
    branchName: (branch.data as { name: string } | null)?.name ?? null,
    ownerName: (owner.data as { full_name: string | null } | null)?.full_name ?? null,
  };
}

/** Link two records as one student. Clears a "not the same student" mark on the pair first. */
export async function linkStudents(db: SupabaseClient, accountId: string, userId: string, a: string, b: string): Promise<void> {
  const [x, y] = orderedPair(a, b);
  const cleared = await db.from('contact_link_exclusions').delete().eq('account_id', accountId).eq('contact_a', x).eq('contact_b', y);
  if (cleared.error) fail('Could not link these records', cleared.error);
  const { data, error } = await db.from('contact_links')
    .insert({ account_id: accountId, contact_a: x, contact_b: y, created_by: userId }).select('id');
  if (error?.code === '23505') return;
  if (error?.code === 'P0001') throw new NotSameStudentError();
  if (error) fail('Could not link these records', error);
  if (!(data as unknown[] | null)?.length) throw new Error('Could not link these records');
}

export async function unlinkStudents(db: SupabaseClient, linkId: string): Promise<void> {
  const { data, error } = await db.from('contact_links').delete().eq('id', linkId).select('id');
  if (error) fail('Could not unlink', error);
  if (!(data as unknown[] | null)?.length) throw new Error('Could not unlink: the link is gone or you cannot change it');
}

export async function markNotSameStudent(db: SupabaseClient, accountId: string, userId: string, a: string, b: string): Promise<void> {
  const [x, y] = orderedPair(a, b);
  const { data, error } = await db.from('contact_link_exclusions')
    .insert({ account_id: accountId, contact_a: x, contact_b: y, created_by: userId }).select('id');
  if (error?.code === '23505') return;
  if (error) fail('Could not save that', error);
  if (!(data as unknown[] | null)?.length) throw new Error('Could not save that');
}
