/**
 * The Contacts page tabs, applied in the query so the total and the pages
 * cover every matching contact, not just the 25 rows already loaded.
 *   Leads:    still on the temporary `LD-` roll number (migration 026).
 *   Enrolled: a university has been set, the same rule as the admission
 *             register.
 */

export type ContactTab = 'all' | 'leads' | 'enrolled';

interface TabFilterable<Q> {
  like(column: string, pattern: string): Q;
  not(column: string, operator: string, value: unknown): Q;
}

export function applyContactTab<Q extends TabFilterable<Q>>(
  query: Q,
  tab: ContactTab
): Q {
  if (tab === 'leads') return query.like('roll_number', 'LD-%');
  if (tab === 'enrolled') return query.not('university', 'is', null);
  return query;
}
