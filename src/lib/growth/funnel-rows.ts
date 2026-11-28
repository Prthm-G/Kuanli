import { adLabel, costPer, inr, regionLabel, spendCell } from './format';
import type { BranchFunnel, FunnelSteps } from './types';

/**
 * Table rows for /growth (KB-JOURNEY-R2), kept out of the component so ordering, labels and the cost edge cases are
 * tested. Heads (page.tsx must match):
 *  branchRows: Branch, Chats, Ad, Ad (exact ad unknown), Organic, Qualified, App started, Provisional, Fee, Enrolled,
 *              Spend, Cost/ad chat, Cost/provisional, Cost/enrolment
 *  adRows:     Ad, [Branch], Chats, Qualified, Provisional, Enrolled, Spend, Cost/chat, Cost/provisional, Cost/enrolment
 *  formRows:   Form, Branch, Leads, Contacts, Qualified, App started, Provisional, Fee, Enrolled
 *  stateRows:  State, Branch, Spend, Impressions, Clicks   (Meta gives no chats by state)
 */
type Cell = string | number;
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
    costPer(b.spend, b.adChats + b.adUnknownChats),
    costPer(b.spend, b.provisional),
    costPer(b.spend, b.enrolled),
  ]);
}

export function adRows(f: BranchFunnel, showBranch: boolean): Cell[][] {
  const br = (c: string | null): Cell[] => (showBranch ? [c ?? 'none'] : []);
  const ads = f.byAd.map((a) => [
    adLabel(a),
    ...br(a.branchCode),
    a.chats,
    a.qualified,
    a.provisional,
    a.enrolled,
    spendCell(a.spend),
    costPer(a.spend, a.chats),
    costPer(a.spend, a.provisional),
    costPer(a.spend, a.enrolled),
  ]);
  const sources = f.bySource.map((s) => [
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

export function stateRows(f: BranchFunnel): Cell[][] {
  return f.spendByState
    .slice(0, 25)
    .map((s) => [
      regionLabel(s.region),
      s.branchCode ?? 'none',
      inr(s.spend),
      s.impressions ?? 0,
      s.clicks ?? 0,
    ]);
}
