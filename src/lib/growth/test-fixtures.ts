/** Shared test fixture: a well-formed growth snapshot POST body. */
export function snapshotBody(overrides: Record<string, unknown> = {}) {
  return {
    account_id: '16cb2ac1-b074-4996-9a2e-260c123eabfe',
    snapshot_date: '2026-10-14',
    payload: {
      v: 1,
      generated_at: '2026-10-14T09:00:00+05:30',
      intake: {
        prefix: '2026-2',
        total: 12,
        ads: '<3',
        target: 250,
        target_ads: 160,
        checkpoint: 75,
        checkpoint_ads: 45,
        checkpoint_date: '2026-12-31',
      },
      window14: { spend: 14390.84, enrolments: 0, cpe: null },
      cells: [
        { cell: 'Control', spend: 14390.84, conversations: 223, enrolled: 0 },
      ],
      ads: [
        {
          ad_id: '6976611089797',
          ad_name: 'A10',
          cell: 'Control',
          spend: 100,
          conversations: 3,
          enrolled: '<3',
        },
      ],
      proposals: [
        { kind: 'note', text: 'budget rules paused until 2026-10-14' },
      ],
      blockers: [
        {
          text: 'Ads point at the retired number',
          owner: 'Pratham',
          since: '2026-10-12',
        },
      ],
      seo: { status: 'GSC disconnected', checked: null },
    },
    ...overrides,
  };
}

/** Shared test fixture: a well-formed meta-daily POST body (made-up ids, two regions summing to the total). */
export function metaDailyBody(overrides: Record<string, unknown> = {}) {
  return {
    ad_account_id: '111111111',
    day: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
    account_tz: 'America/Los_Angeles',
    account_total: { spend: 150.5, impressions: 1400, clicks: 28 },
    rows: [
      { ad_id: '81050001', ad_name: 'P1', campaign_id: '81051001', campaign_name: 'C1', adset_id: '81052001',
        adset_name: 'S1', region: 'Punjab region', spend: 100.25, impressions: 1000, clicks: 20 },
      { ad_id: '81050001', ad_name: 'P1', region: 'Chandigarh', spend: 50.25, impressions: 400, clicks: 8,
        msg_started: null, leads: null },
    ],
    ...overrides,
  };
}
