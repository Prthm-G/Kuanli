/**
 * Date-range maths for the EOD report tabs.
 *
 * Kept separate from the queries so the boundary rules are testable without a
 * database. Ranges are half-open [start, end): the end is the first instant
 * *after* the period, which is what a `created_at < end` filter wants and
 * avoids the usual "23:59:59.999 drops the last millisecond" bug.
 *
 * Boundaries are computed in the viewer's local timezone, not UTC. "Today" on
 * an end-of-day report means the operator's today. The UI prints the resolved
 * range next to the tabs so there is never a question about which window is on
 * screen — that matters here because the business runs on IST while the
 * operator is often not.
 */

export type EodPeriod = "day" | "week" | "month";

export interface DateRange {
  /** Inclusive start. */
  start: Date;
  /** Exclusive end. */
  end: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Resolve a tab to a concrete range.
 *
 * - `day`   — the local day containing `now`.
 * - `week`  — the trailing 7 days ending with today, so the week tab always
 *   holds a full week of history. A Monday-anchored week would show a single
 *   day's data every Monday morning, which is useless on a daily report.
 * - `month` — the calendar month containing `now`, which is what people mean
 *   by "this month" when reconciling against monthly targets.
 */
export function resolveRange(period: EodPeriod, now: Date = new Date()): DateRange {
  const today = startOfLocalDay(now);
  const end = new Date(today.getTime() + DAY_MS);

  if (period === "day") return { start: today, end };
  if (period === "week") {
    return { start: new Date(today.getTime() - 6 * DAY_MS), end };
  }
  return { start: new Date(now.getFullYear(), now.getMonth(), 1), end };
}

/** Human label for the resolved window, shown beside the tabs. */
export function describeRange({ start, end }: DateRange): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  // `end` is exclusive; show the last day actually included.
  const lastDay = new Date(end.getTime() - DAY_MS);
  const a = fmt(start);
  const b = fmt(lastDay);
  return a === b ? a : `${a} – ${b}`;
}
