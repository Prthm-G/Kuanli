/**
 * Display helpers for the /growth page, kept out of the component so the
 * edge cases (no enrolments, suppressed counts, retired numbers) are tested.
 */

/** "₹14,391" in Indian digit grouping. */
export function inr(amount: number): string {
  return `₹${Math.round(amount).toLocaleString('en-IN')}`;
}

/** Cost per enrolment for the 14-day window, or why there is none. */
export function cpeLabel(spend: number, cpe: number | null): string {
  if (cpe !== null) return inr(cpe);
  return spend > 0 ? 'no enrolments' : 'n/a';
}

/** Whole days between `iso` and `now`; null when there is no timestamp. */
export function daysSince(
  iso: string | null,
  now: Date = new Date()
): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/** Ad clicks are expected daily while ads run; older than this is an alert. */
export const AD_CLICK_STALE_DAYS = 2;

/**
 * The display number when the number is still configured in Kuanli, else a
 * "retired" label with the id's last four digits (numbers removed from
 * whatsapp_config keep their conversations).
 */
export function numberLabel(
  phoneNumberId: string | null,
  display: string | null
): string {
  if (display) return display;
  if (!phoneNumberId) return 'unknown number';
  return `retired number (…${phoneNumberId.slice(-4)})`;
}

/** YYYY-MM-DD in Asia/Kolkata, matching the IST day buckets of growth_live. */
export function istDate(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
