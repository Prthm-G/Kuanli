/**
 * Small display helpers for the analytics page. Kept out of the component so
 * the edge cases (zero denominators, sub-minute times, day-scale times) are
 * unit-tested.
 */

/** "37%" — or "—" when the denominator is zero, never NaN. */
export function pct(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}

/** "45s", "4m", "2.1h", "3d" from a minute count. */
export function formatMinutes(minutes: number): string {
  if (minutes < 1) return `${Math.max(1, Math.round(minutes * 60))}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round(hours / 24)}d`;
}
