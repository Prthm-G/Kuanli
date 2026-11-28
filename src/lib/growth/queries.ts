import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  BranchFunnel,
  FunnelSteps,
  GrowthBranch,
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
  days = 30,
  branchId: string | null = null
): Promise<GrowthLive> {
  const args: Record<string, unknown> = {
    p_account_id: accountId,
    p_days: days,
  };
  // All never sends p_branch, so the page also works on the 078 catalogue.
  if (branchId) args.p_branch = branchId;
  const { data, error } = await supabase.rpc('growth_live', args);
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

// loadGrowthLive: add `branchId: string | null = null` as the 4th parameter and build the args as
//   const args: Record<string, unknown> = { p_account_id: accountId, p_days: days };
//   if (branchId) args.p_branch = branchId;   // All never sends it, so the page also works on the 078 catalogue
//   const { data, error } = await supabase.rpc('growth_live', args);

/** Branch tabs for /growth: Patiala (PTA) first, then by name. RLS: any member reads branches (097). */
export async function loadBranches(
  supabase: SupabaseClient,
  accountId: string
): Promise<GrowthBranch[]> {
  const { data, error } = await supabase
    .from('branches')
    .select('id, code, name')
    .eq('account_id', accountId)
    .order('name');
  if (error) throw new Error(`Branches failed: ${error.message}`);
  return ((data ?? []) as GrowthBranch[])
    .slice()
    .sort((a, b) =>
      a.code === 'PTA'
        ? -1
        : b.code === 'PTA'
          ? 1
          : a.name.localeCompare(b.name)
    );
}

type RawSteps = {
  contacts?: number;
  qualified?: number;
  application_started?: number;
  provisional?: number;
  fee?: number;
  enrolled?: number;
};
const steps = (r: RawSteps): FunnelSteps => ({
  contacts: r.contacts ?? 0,
  qualified: r.qualified ?? 0,
  applicationStarted: r.application_started ?? 0,
  provisional: r.provisional ?? 0,
  fee: r.fee ?? 0,
  enrolled: r.enrolled ?? 0,
});
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/** Owner-only branch funnel + daily spend via `growth_branch_funnel` (migration 105). */
export async function loadBranchFunnel(
  supabase: SupabaseClient,
  accountId: string,
  days = 30,
  branchId: string | null = null
): Promise<BranchFunnel> {
  const args: Record<string, unknown> = {
    p_account_id: accountId,
    p_days: days,
  };
  if (branchId) args.p_branch = branchId;
  const { data, error } = await supabase.rpc('growth_branch_funnel', args);
  if (error) throw new Error(`Branch funnel failed: ${error.message}`);
  type Row = RawSteps & Record<string, unknown>;
  const raw = (data ?? {}) as Partial<
    Record<
      | 'branches'
      | 'by_ad'
      | 'by_source'
      | 'form_leads'
      | 'spend_by_state'
      | 'coverage',
      Row[]
    >
  > & {
    since?: string;
    until?: string;
  };
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    since: raw.since ?? '',
    until: raw.until ?? '',
    branches: (raw.branches ?? []).map((r) => ({
      ...steps(r),
      branchCode: str(r.branch_code),
      branchName: str(r.branch_name),
      chats: Number(r.chats ?? 0),
      adChats: Number(r.ad_chats ?? 0),
      adUnknownChats: Number(r.ad_unknown_chats ?? 0),
      organicChats: Number(r.organic_chats ?? 0),
      spend: numOrNull(r.spend),
    })),
    byAd: (raw.by_ad ?? []).map((r) => ({
      ...steps(r),
      adId: String(r.ad_id ?? ''),
      branchCode: str(r.branch_code),
      catalogName: str(r.catalog_name),
      metaName: str(r.meta_name),
      inCatalog: r.in_catalog === true,
      chats: Number(r.chats ?? 0),
      spend: numOrNull(r.spend),
      impressions: numOrNull(r.impressions),
      clicks: numOrNull(r.clicks),
    })),
    bySource: (raw.by_source ?? []).map((r) => ({
      ...steps(r),
      source: r.source === 'ad_unknown' ? 'ad_unknown' : 'organic',
      branchCode: str(r.branch_code),
      chats: Number(r.chats ?? 0),
    })),
    formLeads: (raw.form_leads ?? []).map((r) => ({
      ...steps(r),
      branchCode: str(r.branch_code),
      form: String(r.form ?? 'form'),
      leads: Number(r.leads ?? 0),
    })),
    spendByState: (raw.spend_by_state ?? []).map((r) => ({
      region: String(r.region ?? 'Unknown'),
      branchCode: str(r.branch_code),
      spend: Number(r.spend ?? 0),
      impressions: numOrNull(r.impressions),
      clicks: numOrNull(r.clicks),
    })),
    coverage: (raw.coverage ?? []).map((r) => ({
      adAccountId: String(r.ad_account_id ?? ''),
      branchCode: str(r.branch_code),
      accountTz: String(r.account_tz ?? ''),
      lastDay: str(r.last_day),
      daysInWindow: Number(r.days_in_window ?? 0),
    })),
  };
}
