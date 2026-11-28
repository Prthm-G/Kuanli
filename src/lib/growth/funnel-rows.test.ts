import { describe, expect, it } from 'vitest';

import { adRows, branchRows, formRows, stateRows } from './funnel-rows';
import type { BranchFunnel } from './types';

const steps = {
  contacts: 1,
  qualified: 1,
  applicationStarted: 1,
  provisional: 1,
  fee: 0,
  enrolled: 0,
};
const f: BranchFunnel = {
  since: '2026-10-30',
  until: '2026-11-28',
  branches: [
    {
      ...steps,
      branchCode: 'PTA',
      branchName: 'Patiala',
      chats: 4,
      adChats: 2,
      adUnknownChats: 1,
      organicChats: 1,
      spend: 600,
    },
    {
      ...steps,
      branchCode: null,
      branchName: null,
      chats: 1,
      adChats: 0,
      adUnknownChats: 1,
      organicChats: 0,
      spend: null,
    },
  ],
  byAd: [
    {
      ...steps,
      adId: '81050001',
      branchCode: 'PTA',
      catalogName: 'Ad P1',
      metaName: null,
      inCatalog: true,
      chats: 2,
      spend: 500,
      impressions: 9,
      clicks: 1,
    },
    {
      ...steps,
      adId: '81059999',
      branchCode: 'MOH',
      catalogName: null,
      metaName: null,
      inCatalog: false,
      chats: 0,
      spend: 90,
      impressions: 1,
      clicks: 0,
    },
  ],
  bySource: [
    { ...steps, source: 'ad_unknown', branchCode: null, chats: 1 },
    { ...steps, source: 'organic', branchCode: 'PTA', chats: 1 },
  ],
  formLeads: [{ ...steps, branchCode: 'PTA', form: 'Form A', leads: 3 }],
  spendByState: [
    { region: 'null', branchCode: 'PTA', spend: 5, impressions: 1, clicks: 0 },
  ],
  coverage: [],
};

describe('funnel rows', () => {
  it('branch rows: chat split, funnel, spend and costs', () => {
    expect(branchRows(f)[0]).toEqual([
      'Patiala',
      4,
      2,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      '₹600',
      '₹200',
      '₹600',
      'none yet',
    ]);
    expect(branchRows(f)[1][0]).toBe('No branch');
    expect(branchRows(f)[1][10]).toBe('no data');
  });

  it('ad rows: unknown ads kept, then the no-ad-id sources, branch column only on All', () => {
    const rows = adRows(f, true);
    expect(rows[0]).toEqual([
      'Ad P1',
      'PTA',
      2,
      1,
      1,
      0,
      '₹500',
      '₹250',
      '₹500',
      'none yet',
    ]);
    expect(rows[1][0]).toBe('unknown ad …059999');
    expect(rows[1][7]).toBe('none yet');
    expect(rows[2][0]).toBe('Ad, exact ad unknown');
    expect(rows[2][6]).toBe('n/a');
    expect(rows[3][0]).toBe('Organic');
    expect(adRows(f, false)[0]).toHaveLength(9);
  });

  it('form and state rows', () => {
    expect(formRows(f)[0]).toEqual(['Form A', 'PTA', 3, 1, 1, 1, 1, 0, 0]);
    expect(stateRows(f)[0]).toEqual(['Unknown', 'PTA', '₹5', 1, 0]);
  });
});
