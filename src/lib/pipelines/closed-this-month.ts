/**
 * "Won/Lost this month" on the pipeline header. A deal counts when it moved
 * into Enrolled (won) or Lost this month and is still there, timed by the
 * stage change itself (deal_stage_events, migration 042). `deals.updated_at`
 * moves on every edit, so a student enrolled in October and touched in
 * November used to count again.
 */

export const WON_STAGE = 'Enrolled';
export const LOST_STAGE = 'Lost';
/** Out of the running but kept to contact later (migration 093). Deals there
 *  keep status 'open', so only the stage name says they are out. */
export const NOT_INTERESTED_STAGE = 'Not Interested';

export interface StageEvent {
  deal_id: string;
  to_stage_id: string;
  changed_at: string;
}

export function closedThisMonth(
  deals: { id: string; stage_id: string }[],
  stages: { id: string; name: string }[],
  events: StageEvent[],
  monthStart: Date
): { won: number; lost: number } {
  const nameById = new Map(stages.map((s) => [s.id, s.name]));
  const since = monthStart.getTime();
  // Deals whose move into their current stage happened this month.
  const movedIn = new Set(
    events
      .filter((e) => new Date(e.changed_at).getTime() >= since)
      .map((e) => `${e.deal_id}:${e.to_stage_id}`)
  );
  let won = 0;
  let lost = 0;
  for (const d of deals) {
    if (!movedIn.has(`${d.id}:${d.stage_id}`)) continue;
    const name = nameById.get(d.stage_id);
    if (name === WON_STAGE) won++;
    else if (name === LOST_STAGE) lost++;
  }
  return { won, lost };
}

/**
 * Midnight IST on the first of the current IST month. The business runs on
 * India time, so the month must not move with the viewer's browser zone (the
 * owner often works from Vancouver, 12.5 hours behind). IST has no DST, so a
 * fixed +05:30 offset is exact. Same approach as istDate in lib/growth/format.
 */
export function startOfMonth(now: Date = new Date()): Date {
  const istDay = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return new Date(`${istDay.slice(0, 7)}-01T00:00:00+05:30`);
}
