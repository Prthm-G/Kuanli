import { describe, expect, it } from 'vitest';

import { pipelineStats } from './stats';

const stages = [
  { id: 's-new', name: 'New Lead', position: 0 },
  { id: 's-app', name: 'Application Started', position: 1 },
  { id: 's-won', name: 'Enrolled', position: 2 },
  { id: 's-lost', name: 'Lost', position: 3 },
  { id: 's-ni', name: 'Not Interested', position: 4 },
];
const monthStart = new Date('2026-11-01T00:00:00+05:30');
const NOV = '2026-11-05T10:00:00Z';
const OCT = '2026-10-20T10:00:00Z';
const deal = (
  id: string,
  stage_id: string,
  value: number,
  status: 'open' | 'won' | 'lost' = 'open'
) => ({
  id,
  stage_id,
  value,
  status,
});

describe('pipelineStats', () => {
  const deals = [
    deal('d-new', 's-new', 100),
    deal('d-app', 's-app', 200),
    deal('d-won', 's-won', 300, 'won'),
    deal('d-lost-nov', 's-lost', 400), // moved into Lost this month, status stays open
    deal('d-lost-oct', 's-lost', 500),
    deal('d-ni', 's-ni', 600),
    deal('d-marked', 's-app', 700, 'lost'), // marked lost by hand
  ];
  const events = [
    { deal_id: 'd-lost-nov', to_stage_id: 's-lost', changed_at: NOV },
    { deal_id: 'd-lost-oct', to_stage_id: 's-lost', changed_at: OCT },
    { deal_id: 'd-won', to_stage_id: 's-won', changed_at: NOV },
  ];

  it('Lost This Month counts a deal moved into Lost this month', () => {
    const s = pipelineStats(deals, stages, events, monthStart);
    expect(s.lostThisMonth).toBe(1);
    expect(s.wonThisMonth).toBe(1);
  });

  it('active leaves out Lost and Not Interested by stage, and deals marked lost', () => {
    const s = pipelineStats(deals, stages, events, monthStart);
    expect(s.totalCount).toBe(3);
    expect(s.totalValue).toBe(600);
    expect(s.avgValue).toBe(200);
  });

  it('weights open deals over working stages only, Enrolled being the top rung', () => {
    // Ladder New Lead, Application Started, Enrolled: 10%, 90%, 100%; the won deal is not open.
    const s = pipelineStats(deals, stages, events, monthStart);
    expect(s.weightedValue).toBeCloseTo(100 * 0.1 + 200 * 0.9);
  });

  it('month counts are null until the stage events load', () => {
    const s = pipelineStats(deals, stages, null, monthStart);
    expect(s.wonThisMonth).toBeNull();
    expect(s.lostThisMonth).toBeNull();
  });
});
