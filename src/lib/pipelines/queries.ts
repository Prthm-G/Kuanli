import type { SupabaseClient } from '@supabase/supabase-js';

import type { StageEvent } from './closed-this-month';

/** Rows asked for per request. The server may cap lower (max_rows). */
const PAGE = 1000;

/**
 * This month's moves into the pipeline's Enrolled/Lost stages, for the
 * Won/Lost this month tiles. Scoped by account so the (account_id,
 * changed_at) index from migration 042 is used.
 *
 * PostgREST silently truncates at `max_rows`, so this pages with an exact
 * count and keeps reading until it holds every row, advancing by the rows it
 * actually got. A capped page can never shorten the result.
 */
export async function loadCloseEvents(
  supabase: SupabaseClient,
  accountId: string,
  stageIds: string[],
  since: Date
): Promise<StageEvent[]> {
  if (stageIds.length === 0) return [];
  const out: StageEvent[] = [];
  for (;;) {
    const { data, count, error } = await supabase
      .from('deal_stage_events')
      .select('deal_id, to_stage_id, changed_at', { count: 'exact' })
      .eq('account_id', accountId)
      .in('to_stage_id', stageIds)
      .gte('changed_at', since.toISOString())
      .order('changed_at', { ascending: true })
      .order('id', { ascending: true })
      .range(out.length, out.length + PAGE - 1);
    if (error) throw new Error(`Stage events query failed: ${error.message}`);
    const rows = (data ?? []) as StageEvent[];
    out.push(...rows);
    if (rows.length === 0 || out.length >= (count ?? 0)) return out;
  }
}
