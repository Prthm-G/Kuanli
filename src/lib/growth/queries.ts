import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  GrowthLive,
  GrowthSnapshot,
  GrowthSnapshotPayload,
} from './types';

/**
 * Live signals via the owner-only `growth_live` RPC (migration 078). Maps the
 * JSONB to camelCase and defaults missing keys to empty sections, following
 * lib/analytics/queries.ts.
 */
export async function loadGrowthLive(
  supabase: SupabaseClient,
  accountId: string,
  days = 30
): Promise<GrowthLive> {
  const { data, error } = await supabase.rpc('growth_live', {
    p_account_id: accountId,
    p_days: days,
  });
  if (error) throw new Error(`Growth query failed: ${error.message}`);

  type Raw = {
    last_ad_referral_at?: string | null;
    daily?: Array<{
      day?: string;
      new_conversations?: number;
      ad_referrals?: number;
    }>;
    by_ad?: Array<{
      ad_source_id?: string;
      conversations?: number;
      last_at?: string;
    }>;
    by_number?: Array<{
      phone_number_id?: string | null;
      display_phone_number?: string | null;
      conversations?: number;
      last_at?: string;
    }>;
    contacts_by_source?: Array<{ source?: string; contacts?: number }>;
  };
  const raw = (data ?? {}) as Raw;

  return {
    lastAdReferralAt: raw.last_ad_referral_at ?? null,
    daily: (raw.daily ?? []).map((d) => ({
      day: d.day ?? '',
      newConversations: d.new_conversations ?? 0,
      adReferrals: d.ad_referrals ?? 0,
    })),
    byAd: (raw.by_ad ?? []).map((a) => ({
      adSourceId: a.ad_source_id ?? '',
      conversations: a.conversations ?? 0,
      lastAt: a.last_at ?? '',
    })),
    byNumber: (raw.by_number ?? []).map((n) => ({
      phoneNumberId: n.phone_number_id ?? null,
      displayPhoneNumber: n.display_phone_number ?? null,
      conversations: n.conversations ?? 0,
      lastAt: n.last_at ?? '',
    })),
    contactsBySource: (raw.contacts_by_source ?? []).map((s) => ({
      source: s.source ?? 'unknown',
      contacts: s.contacts ?? 0,
    })),
  };
}

/** Latest weekly snapshots, newest first. RLS returns rows to the owner only. */
export async function loadGrowthSnapshots(
  supabase: SupabaseClient,
  accountId: string,
  limit = 8
): Promise<GrowthSnapshot[]> {
  const { data, error } = await supabase
    .from('growth_snapshots')
    .select('snapshot_date, payload')
    .eq('account_id', accountId)
    .order('snapshot_date', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Growth snapshots failed: ${error.message}`);

  // Skip rows this page version can't read (another payload version) rather
  // than letting one bad row blank the whole page.
  return (data ?? [])
    .filter((r) => (r.payload as { v?: unknown } | null)?.v === 1)
    .map((r) => ({
      snapshotDate: r.snapshot_date as string,
      payload: r.payload as GrowthSnapshotPayload,
    }));
}
