/**
 * The Contacts page tabs, applied in the query so the total and the pages
 * cover every matching contact, not just the 25 rows already loaded.
 *   Leads:    still on the temporary `LD-` roll number (migration 026).
 *   Enrolled: a university has been set, the same rule as the admission
 *             register.
 *   Unowned:  no owner yet (migration 098). Admin only: these leads are
 *             hidden from counsellors, so this is the queue to hand out.
 */

export type ContactTab = 'all' | 'leads' | 'enrolled' | 'unowned';

interface TabFilterable<Q> {
  like(column: string, pattern: string): Q;
  not(column: string, operator: string, value: unknown): Q;
  is(column: string, value: null): Q;
}

export function applyContactTab<Q extends TabFilterable<Q>>(
  query: Q,
  tab: ContactTab
): Q {
  if (tab === 'leads') return query.like('roll_number', 'LD-%');
  if (tab === 'enrolled') return query.not('university', 'is', null);
  if (tab === 'unowned') return query.is('owner_profile_id', null);
  return query;
}
