/**
 * Display helpers for the /growth page, kept out of the component so the
 * edge cases (no enrolments, suppressed counts, retired numbers) are tested.
 */

import type { SpendCoverage } from './types';

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

/** "₹250" per unit, or why there is no cost: no spend data, nothing reached yet, or no spend. */
export function costPer(spend: number | null, n: number): string {
  if (spend === null) return 'no data';
  if (n > 0) return inr(spend / n);
  return spend > 0 ? 'none yet' : 'n/a';
}

export function spendCell(spend: number | null): string {
  return spend === null ? 'no data' : inr(spend);
}

/** Meta's region names, with its "null" and "Unknown" both shown as Unknown. */
export function regionLabel(region: string): string {
  const r = region.trim();
  return !r || r === 'null' || r === 'Unknown' ? 'Unknown' : r;
}

/** The catalogue name, else "unknown ad" with Meta's own name when it gave one and the id's last 6 digits. */
export function adLabel(a: {
  adId: string;
  catalogName: string | null;
  metaName: string | null;
  inCatalog: boolean;
}): string {
  if (a.inCatalog && a.catalogName) return a.catalogName;
  return `unknown ad${a.metaName ? ` (${a.metaName})` : ''} …${a.adId.slice(-6)}`;
}

/** Which Meta days are stored, per ad account, in one line for the page. */
export function coverageLine(
  c: SpendCoverage[],
  branchName: (code: string | null) => string,
  days = 30
): string {
  if (c.length === 0)
    return 'No daily Meta spend stored yet, so spend columns say "no data".';
  const tz = (x: SpendCoverage) =>
    x.accountTz === 'Asia/Kolkata'
      ? ''
      : x.accountTz === 'America/Los_Angeles'
        ? ' (Meta day, Pacific)'
        : ` (${x.accountTz})`;
  const one = (x: SpendCoverage) =>
    `${x.daysInWindow} of ${days} days, last ${x.lastDay ?? 'no day'}`;
  if (c.length === 1) {
    const x = c[0];
    const note =
      x.accountTz === 'America/Los_Angeles'
        ? ` (Meta day, Pacific for ${branchName(x.branchCode)})`
        : tz(x);
    return `Spend stored for ${one(x)}${note}. Chats use IST days.`;
  }
  const parts = c.map((x) => `${branchName(x.branchCode)} ${one(x)}${tz(x)}`);
  return `Spend stored for ${parts.join('; ')}. Chats use IST days.`;
}
