import type { SupabaseClient } from '@supabase/supabase-js';

import type { FunnelAnalytics } from './types';

/**
 * Load the funnel analytics document via the `funnel_analytics` RPC
 * (migration 043). The RPC authorizes the caller against the account and
 * returns one JSONB document; this maps it to camelCase and defends against
 * missing keys so a partial payload degrades to empty sections instead of a
 * crashed page.
 */
export async function loadFunnelAnalytics(
  supabase: SupabaseClient,
  accountId: string
): Promise<FunnelAnalytics> {
  const { data, error } = await supabase.rpc('funnel_analytics', {
    p_account_id: accountId,
  });

  if (error) throw new Error(`Analytics query failed: ${error.message}`);

  // The RPC returns one JSONB value; PostgREST types it loosely. Assert the
  // shape once, following the codebase convention (lib/dashboard/queries.ts).
  type Raw = {
    totals?: {
      leads?: number;
      enrolled?: number;
      lost?: number;
      reached_application?: number;
    };
    sources?: Array<{
      source?: string;
      leads?: number;
      qualified?: number;
      counselor?: number;
      application?: number;
      enrolled?: number;
      lost?: number;
    }>;
    funnel?: Array<{
      stage?: string;
      position?: number;
      current?: number;
      reached?: number | null;
    }>;
    interest?: Array<{
      university?: string;
      leads?: number;
      application?: number;
      enrolled?: number;
      lost?: number;
    }>;
    response_trend?: Array<{
      day?: string;
      median_minutes?: number;
      responses?: number;
    }>;
  };

  const raw = (data ?? {}) as Raw;

  return {
    totals: {
      leads: raw.totals?.leads ?? 0,
      enrolled: raw.totals?.enrolled ?? 0,
      lost: raw.totals?.lost ?? 0,
      reachedApplication: raw.totals?.reached_application ?? 0,
    },
    sources: (raw.sources ?? []).map((s) => ({
      source: s.source ?? 'Organic',
      leads: s.leads ?? 0,
      qualified: s.qualified ?? 0,
      counselor: s.counselor ?? 0,
      application: s.application ?? 0,
      enrolled: s.enrolled ?? 0,
      lost: s.lost ?? 0,
    })),
    funnel: (raw.funnel ?? []).map((f) => ({
      stage: f.stage ?? '',
      position: f.position ?? 0,
      current: f.current ?? 0,
      reached: f.reached ?? null,
    })),
    interest: (raw.interest ?? []).map((i) => ({
      university: i.university ?? 'Unresolved',
      leads: i.leads ?? 0,
      application: i.application ?? 0,
      enrolled: i.enrolled ?? 0,
      lost: i.lost ?? 0,
    })),
    responseTrend: (raw.response_trend ?? []).map((r) => ({
      day: r.day ?? '',
      medianMinutes: r.median_minutes ?? 0,
      responses: r.responses ?? 0,
    })),
  };
}
