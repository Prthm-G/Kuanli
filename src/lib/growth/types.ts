/**
 * Shapes for the owner-only /growth page (KB-GROWTH-R1, migration 078).
 *
 * Snapshot payloads come from the weekly ads scorecard
 * (skeure-growth/measurement/reconcile/publish.py). Counts of 1-2 students
 * arrive as the string "<3", so enrolment counts are `Count`, not number.
 */

export type Count = number | string;

export interface GrowthSnapshotPayload {
  v: 1;
  generated_at: string;
  intake: {
    prefix: string;
    total: Count;
    ads: Count;
    target: number;
    target_ads: number;
    checkpoint: number;
    checkpoint_ads: number;
    checkpoint_date: string;
  };
  window14: { spend: number; enrolments: Count; cpe: number | null };
  cells: Array<{
    cell: string;
    spend: number;
    conversations: number;
    enrolled: Count;
  }>;
  ads: Array<{
    ad_id: string;
    ad_name: string;
    cell: string;
    spend: number;
    conversations: number;
    enrolled: Count;
  }>;
  proposals: Array<{ kind: string; text: string }>;
  blockers: Array<{ text: string; owner: string; since: string | null }>;
  seo: { status: string; checked: string | null };
}

export interface GrowthSnapshot {
  snapshotDate: string;
  payload: GrowthSnapshotPayload;
}

/** Shape returned by the `growth_live` RPC (migration 078). */
export interface GrowthLive {
  lastAdReferralAt: string | null;
  daily: Array<{ day: string; newConversations: number; adReferrals: number }>;
  byAd: Array<{ adSourceId: string; conversations: number; lastAt: string }>;
  byNumber: Array<{
    phoneNumberId: string | null;
    displayPhoneNumber: string | null;
    conversations: number;
    lastAt: string;
  }>;
  contactsBySource: Array<{ source: string; contacts: number }>;
}

/** A branch tab on /growth (migration 097). */
export interface GrowthBranch {
  id: string;
  code: string;
  name: string;
}

/** Distinct contacts reaching each step (any deal, now or by a past stage move). */
export interface FunnelSteps {
  contacts: number;
  qualified: number;
  applicationStarted: number;
  provisional: number;
  fee: number;
  enrolled: number;
}

export interface FunnelBranchRow extends FunnelSteps {
  branchCode: string | null;
  branchName: string | null;
  chats: number;
  adChats: number;
  adUnknownChats: number;
  organicChats: number;
  /** null when no daily Meta spend is stored for the window. */
  spend: number | null;
}

export interface FunnelAdRow extends FunnelSteps {
  adId: string;
  branchCode: string | null;
  catalogName: string | null;
  metaName: string | null;
  inCatalog: boolean;
  chats: number;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
}

export interface FunnelSourceRow extends FunnelSteps {
  source: 'ad_unknown' | 'organic';
  branchCode: string | null;
  chats: number;
}

/** Form leads carry no ad id (Meta returns none to the form workflow), so they are per branch and form. */
export interface FunnelFormRow extends FunnelSteps {
  branchCode: string | null;
  form: string;
  leads: number;
}

/** Meta reports spend, impressions and clicks by state; no chats or leads. */
export interface SpendStateRow {
  region: string;
  branchCode: string | null;
  spend: number;
  impressions: number | null;
  clicks: number | null;
}

export interface SpendCoverage {
  adAccountId: string;
  branchCode: string | null;
  accountTz: string;
  lastDay: string | null;
  daysInWindow: number;
}

/** Shape returned by the `growth_branch_funnel` RPC (migration 105). */
export interface BranchFunnel {
  since: string;
  until: string;
  branches: FunnelBranchRow[];
  byAd: FunnelAdRow[];
  bySource: FunnelSourceRow[];
  formLeads: FunnelFormRow[];
  spendByState: SpendStateRow[];
  coverage: SpendCoverage[];
}
