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
