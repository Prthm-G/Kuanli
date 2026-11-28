import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadBranchFunnel, loadBranches, loadGrowthLive } from './queries';

const rpcDb = (data: unknown) => {
  const rpc = vi.fn().mockResolvedValue({ data, error: null });
  return { db: { rpc } as unknown as SupabaseClient, rpc };
};

describe('loadGrowthLive', () => {
  it('sends p_branch only on a branch tab', async () => {
    const { db, rpc } = rpcDb({});
    await loadGrowthLive(db, 'acc', 30);
    expect(rpc).toHaveBeenLastCalledWith('growth_live', {
      p_account_id: 'acc',
      p_days: 30,
    });
    await loadGrowthLive(db, 'acc', 30, 'br1');
    expect(rpc).toHaveBeenLastCalledWith('growth_live', {
      p_account_id: 'acc',
      p_days: 30,
      p_branch: 'br1',
    });
  });
});

describe('loadBranchFunnel', () => {
  it('maps the RPC JSON and keeps null spend as null', async () => {
    const { db, rpc } = rpcDb({
      since: '2026-10-30',
      until: '2026-11-28',
      branches: [
        {
          branch_code: 'PTA',
          branch_name: 'Patiala',
          chats: 2,
          ad_chats: 1,
          ad_unknown_chats: 0,
          organic_chats: 1,
          contacts: 1,
          qualified: 1,
          application_started: 1,
          provisional: 1,
          fee: 0,
          enrolled: 0,
          spend: 215.5,
        },
      ],
      by_ad: [
        {
          ad_id: '81050009',
          branch_code: 'MOH',
          catalog_name: null,
          meta_name: 'X',
          in_catalog: false,
          chats: 1,
          contacts: 1,
          qualified: 0,
          application_started: 0,
          provisional: 0,
          fee: 0,
          enrolled: 0,
          spend: null,
          impressions: null,
          clicks: null,
        },
      ],
      by_source: [
        {
          source: 'organic',
          branch_code: null,
          chats: 3,
          contacts: 3,
          qualified: 0,
          application_started: 0,
          provisional: 0,
          fee: 0,
          enrolled: 0,
        },
      ],
      form_leads: [
        {
          branch_code: 'PTA',
          form: 'Form A',
          leads: 4,
          contacts: 4,
          qualified: 2,
          application_started: 1,
          provisional: 0,
          fee: 0,
          enrolled: 0,
        },
      ],
      spend_by_state: [
        {
          region: 'Punjab region',
          branch_code: 'PTA',
          spend: 200,
          impressions: 2000,
          clicks: 30,
        },
      ],
      coverage: [
        {
          ad_account_id: '111111111',
          branch_code: 'PTA',
          account_tz: 'America/Los_Angeles',
          last_day: '2026-11-26',
          days_in_window: 3,
        },
      ],
    });
    const f = await loadBranchFunnel(db, 'acc', 30, null);
    expect(rpc).toHaveBeenCalledWith('growth_branch_funnel', {
      p_account_id: 'acc',
      p_days: 30,
    });
    expect(f.branches[0]).toMatchObject({
      branchCode: 'PTA',
      adChats: 1,
      applicationStarted: 1,
      spend: 215.5,
    });
    expect(f.byAd[0]).toMatchObject({
      adId: '81050009',
      inCatalog: false,
      metaName: 'X',
      spend: null,
    });
    expect(f.bySource[0].source).toBe('organic');
    expect(f.formLeads[0]).toMatchObject({ form: 'Form A', leads: 4 });
    expect(f.coverage[0]).toMatchObject({
      accountTz: 'America/Los_Angeles',
      lastDay: '2026-11-26',
      daysInWindow: 3,
    });
  });

  it('defaults missing sections to empty', async () => {
    const { db } = rpcDb(null);
    const f = await loadBranchFunnel(db, 'acc');
    expect(f.byAd).toEqual([]);
    expect(f.spendByState).toEqual([]);
  });

  it('throws with the RPC error', async () => {
    const db = {
      rpc: vi
        .fn()
        .mockResolvedValue({ data: null, error: { message: 'nope' } }),
    } as unknown as SupabaseClient;
    await expect(loadBranchFunnel(db, 'acc')).rejects.toThrow(
      'Branch funnel failed: nope'
    );
  });
});

describe('loadBranches', () => {
  it('puts Patiala first, then by name', async () => {
    const chain = { select: vi.fn(), eq: vi.fn(), order: vi.fn() };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.order.mockResolvedValue({
      data: [
        { id: 'm', code: 'MOH', name: 'Mohali' },
        { id: 'p', code: 'PTA', name: 'Patiala' },
        { id: 'z', code: 'ZRK', name: 'Zirakpur' },
      ],
      error: null,
    });
    const db = {
      from: vi.fn().mockReturnValue(chain),
    } as unknown as SupabaseClient;
    expect((await loadBranches(db, 'acc')).map((b) => b.code)).toEqual([
      'PTA',
      'MOH',
      'ZRK',
    ]);
    expect(chain.eq).toHaveBeenCalledWith('account_id', 'acc');
  });
});
