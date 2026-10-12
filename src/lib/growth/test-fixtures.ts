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
