/**
 * Due-date bucketing for the follow-up worklist.
 *
 * The `follow_up_worklist` RPC returns every open commitment and deliberately
 * does not bucket them: "today" is a question about the *viewer's* timezone,
 * and answering it in Postgres would bake the server's zone into the data.
 * The split happens here, in local time, where it is testable and correct for
 * whoever is looking at the screen.
 *
 * Boundaries are calendar days, not 24-hour windows. A commitment made for
 * 9am today is "today" at 5pm, not "overdue" — a counsellor still has the day
 * to make the call. It becomes overdue at midnight.
 */

import type { WorklistRow } from './types';

export const DUE_BUCKETS = ['overdue', 'today', 'week', 'later'] as const;

export type DueBucket = (typeof DUE_BUCKETS)[number];

export const BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  later: 'Later',
};

/** Midnight at the start of `d`, in local time. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Whole calendar days between two instants, positive when `due` is in the
 * past. Day-based rather than hour-based so "2 days overdue" means what a
 * person means by it regardless of the time of day either end.
 */
export function daysOverdue(dueAt: string, now: Date = new Date()): number {
  const due = startOfDay(new Date(dueAt)).getTime();
  const today = startOfDay(now).getTime();
  return Math.round((today - due) / 86_400_000);
}

export function bucketFor(dueAt: string, now: Date = new Date()): DueBucket {
  const overdue = daysOverdue(dueAt, now);
  if (overdue > 0) return 'overdue';
  if (overdue === 0) return 'today';
  // -1 through -7: inside the coming week.
  if (overdue >= -7) return 'week';
  return 'later';
}

/**
 * Split the worklist into buckets, preserving the RPC's due-date ordering
 * within each. Always returns all four keys so the UI can render empty
 * sections without null checks.
 */
export function bucketWorklist(
  rows: WorklistRow[],
  now: Date = new Date()
): Record<DueBucket, WorklistRow[]> {
  const out: Record<DueBucket, WorklistRow[]> = {
    overdue: [],
    today: [],
    week: [],
    later: [],
  };
  for (const row of rows) out[bucketFor(row.nextDueAt, now)].push(row);
  return out;
}

/**
 * What the sidebar badge counts: work that is actionable now. Future
 * commitments are not nagging — surfacing them as a badge would make the
 * badge permanently non-zero and therefore ignorable.
 */
export function actionableCount(
  rows: WorklistRow[],
  now: Date = new Date()
): number {
  return rows.filter((r) => {
    const b = bucketFor(r.nextDueAt, now);
    return b === 'overdue' || b === 'today';
  }).length;
}

/** Human phrasing for a due date, e.g. "3 days overdue", "due today". */
export function describeDue(dueAt: string, now: Date = new Date()): string {
  const n = daysOverdue(dueAt, now);
  if (n === 0) return 'due today';
  if (n === 1) return '1 day overdue';
  if (n > 1) return `${n} days overdue`;
  if (n === -1) return 'due tomorrow';
  return `due in ${Math.abs(n)} days`;
}
