import {
  adLabel,
  costPer,
  inr,
  regionLabel,
  spendCell,
  syncableDays,
} from './format';
import type { BranchFunnel, FunnelSteps } from './types';

/**
 * Table rows for /growth (KB-JOURNEY-R2), kept out of the component so ordering, labels and the cost edge cases are
 * tested. Heads (page.tsx must match):
 *  branchRows: Branch, Chats, Ad, Ad (exact ad unknown), Organic, Qualified, App started, Provisional, Fee, Enrolled,
 *              Spend, Cost/ad chat, Spend per provisional (all sources),
 *              Spend per enrolment (all sources)
 *  adRows:     Ad, [Branch], Chats, Qualified, Provisional, Enrolled, Spend, Cost/chat, Cost/provisional, Cost/enrolment
 *  formRows:   Form, Branch, Leads, Contacts, Qualified, App started, Provisional, Fee, Enrolled
 *  stateRows:  State, Branch, Spend, Impressions, Clicks   (Meta gives no chats by state)
 */
export type Cell = string | number | { text: string; title: string };
const WINDOW_DAYS = 30;

/**
 * A cost cell. When fewer spend days are stored for the branch than the chat
 * window has, the number would divide a few days of spend by 30 days of
 * chats, so it says "partial" with the stored-day count in the tooltip.
 */
function cost(
  f: BranchFunnel,
  branchCode: string | null,
  spend: number | null,
  n: number
): Cell {
  const short = f.coverage.find(
    (c) =>
      c.branchCode === branchCode &&
      c.daysInWindow < syncableDays(c.accountTz, WINDOW_DAYS)
  );
  if (spend !== null && short)
    return {
      text: 'partial',
      title: `spend for ${short.daysInWindow} of ${syncableDays(short.accountTz, WINDOW_DAYS)} days stored`,
    };
  const full = f.coverage.find((c) => c.branchCode === branchCode);
  const text = costPer(spend, n);
  if (spend !== null && full) {
    const days = Math.min(
      full.daysInWindow,
      syncableDays(full.accountTz, WINDOW_DAYS)
    );
    return {
      text,
      title: `Spend for ${days} stored days / chats over ${WINDOW_DAYS} days`,
    };
  }
  return text;
}
const funnel = (s: FunnelSteps): Cell[] => [
  s.qualified,
  s.applicationStarted,
  s.provisional,
  s.fee,
  s.enrolled,
];

export function branchRows(f: BranchFunnel): Cell[][] {
  return f.branches.map((b) => [
    b.branchName ?? 'No branch',
    b.chats,
    b.adChats,
    b.adUnknownChats,
    b.organicChats,
    ...funnel(b),
    spendCell(b.spend),
    cost(f, b.branchCode, b.spend, b.adChats + b.adUnknownChats),
    cost(f, b.branchCode, b.spend, b.provisional),
    cost(f, b.branchCode, b.spend, b.enrolled),
  ]);
}

export function adRows(f: BranchFunnel, showBranch: boolean): Cell[][] {
  const br = (c: string | null): Cell[] => (showBranch ? [c ?? 'none'] : []);
  const ads = f.byAd.map((a): Cell[] => [
    adLabel(a),
    ...br(a.branchCode),
    a.chats,
    a.qualified,
    a.provisional,
    a.enrolled,
    spendCell(a.spend),
    cost(f, a.branchCode, a.spend, a.chats),
    cost(f, a.branchCode, a.spend, a.provisional),
    cost(f, a.branchCode, a.spend, a.enrolled),
  ]);
  const sources = f.bySource.map((s): Cell[] => [
    s.source === 'ad_unknown' ? 'Ad, exact ad unknown' : 'Organic',
    ...br(s.branchCode),
    s.chats,
    s.qualified,
    s.provisional,
    s.enrolled,
    'n/a',
    'n/a',
    'n/a',
    'n/a',
  ]);
  return [...ads, ...sources];
}

export function formRows(f: BranchFunnel): Cell[][] {
  return f.formLeads.map((r) => [
    r.form,
    r.branchCode ?? 'none',
    r.leads,
    r.contacts,
    ...funnel(r),
  ]);
}

/** Rows plus a "top 25 of N" note when truncated. "null" and "Unknown" regions merge into one Unknown row. */
export function stateRows(f: BranchFunnel): {
  rows: Cell[][];
  note: string | null;
} {
  const merged = new Map<
    string,
    {
      region: string;
      branchCode: string | null;
      spend: number;
      impressions: number | null;
      clicks: number | null;
    }
  >();
  const add = (a: number | null, b: number | null) =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  for (const s of f.spendByState) {
    const region = regionLabel(s.region);
    const key = `${s.branchCode ?? ''}|${region}`;
    const m = merged.get(key);
    if (m) {
      m.spend += s.spend;
      m.impressions = add(m.impressions, s.impressions);
      m.clicks = add(m.clicks, s.clicks);
    } else merged.set(key, { ...s, region });
  }
  const all = [...merged.values()].sort((a, b) => b.spend - a.spend);
  return {
    rows: all
      .slice(0, 25)
      .map((s) => [
        s.region,
        s.branchCode ?? 'none',
        inr(s.spend),
        s.impressions ?? '-',
        s.clicks ?? '-',
      ]),
    note: all.length > 25 ? `Top 25 of ${all.length} states by spend.` : null,
  };
}
