import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closedThisMonth, startOfMonth } from './closed-this-month';

const stages = [
  { id: 's-new', name: 'New Lead' },
  { id: 's-app', name: 'Application Started' },
  { id: 's-won', name: 'Enrolled' },
  { id: 's-lost', name: 'Lost' },
];
const monthStart = new Date('2026-11-01T00:00:00+05:30');
const NOV = '2026-11-05T10:00:00Z';
const OCT = '2026-10-20T10:00:00Z';

describe('closedThisMonth', () => {
  it('counts a deal by when it moved into Enrolled or Lost, not when it was last edited', () => {
    const deals = [
      // Enrolled in October, edited in November: not this month.
      { id: 'd1', stage_id: 's-won', updated_at: NOV },
      // Enrolled in November: this month.
      { id: 'd2', stage_id: 's-won', updated_at: OCT },
      // Lost in November.
      { id: 'd3', stage_id: 's-lost', updated_at: NOV },
      // Lost in October, touched since.
      { id: 'd4', stage_id: 's-lost', updated_at: NOV },
    ];
    const events = [
      { deal_id: 'd1', to_stage_id: 's-won', changed_at: OCT },
      { deal_id: 'd2', to_stage_id: 's-won', changed_at: NOV },
      { deal_id: 'd3', to_stage_id: 's-lost', changed_at: NOV },
      { deal_id: 'd4', to_stage_id: 's-lost', changed_at: OCT },
    ];
    expect(closedThisMonth(deals, stages, events, monthStart)).toEqual({
      won: 1,
      lost: 1,
    });
  });

  it('ignores a deal that moved into Enrolled this month but has since left it', () => {
    const deals = [{ id: 'd1', stage_id: 's-app' }];
    const events = [{ deal_id: 'd1', to_stage_id: 's-won', changed_at: NOV }];
    expect(closedThisMonth(deals, stages, events, monthStart)).toEqual({
      won: 0,
      lost: 0,
    });
  });

  it('counts a deal once even if it re-entered the stage twice this month', () => {
    const deals = [{ id: 'd1', stage_id: 's-won' }];
    const events = [
      { deal_id: 'd1', to_stage_id: 's-won', changed_at: '2026-11-02T10:00:00Z' },
      { deal_id: 'd1', to_stage_id: 's-won', changed_at: '2026-11-04T10:00:00Z' },
    ];
    expect(closedThisMonth(deals, stages, events, monthStart).won).toBe(1);
  });

  it('does not count a move into Enrolled from before the month started', () => {
    const deals = [{ id: 'd1', stage_id: 's-won' }];
    const events = [
      { deal_id: 'd1', to_stage_id: 's-won', changed_at: '2026-10-31T18:00:00Z' },
    ];
    // 2026-10-31T18:00Z is 23:30 IST on 31 Oct, before the IST month start.
    expect(closedThisMonth(deals, stages, events, monthStart).won).toBe(0);
  });
});

describe('startOfMonth (India time, whatever the browser zone)', () => {
  // The owner works from Vancouver; the business month is the IST month.
  const savedTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/Vancouver';
  });
  afterAll(() => {
    process.env.TZ = savedTz;
  });

  it('is midnight IST on the 1st when it is already the 1st in India', () => {
    // 1 Nov 10:00 IST is still 31 Oct 21:30 in Vancouver.
    const now = new Date('2026-11-01T04:30:00Z');
    expect(startOfMonth(now).toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });

  it('stays on the current IST month until midnight IST on the last day', () => {
    // 30 Nov 23:59 IST.
    expect(startOfMonth(new Date('2026-11-30T18:29:00Z')).toISOString()).toBe(
      '2026-10-31T18:30:00.000Z'
    );
    // 1 Dec 00:01 IST, still 30 Nov 10:31 in Vancouver.
    expect(startOfMonth(new Date('2026-11-30T18:31:00Z')).toISOString()).toBe(
      '2026-11-30T18:30:00.000Z'
    );
  });

  it('counts a 1 Nov 10:00 IST enrolment in November when viewed from Vancouver', () => {
    const now = new Date('2026-11-02T03:00:00Z'); // 1 Nov 20:00 in Vancouver
    const deals = [{ id: 'd1', stage_id: 's-won' }];
    const events = [
      { deal_id: 'd1', to_stage_id: 's-won', changed_at: '2026-11-01T04:30:00Z' },
    ];
    expect(closedThisMonth(deals, stages, events, startOfMonth(now)).won).toBe(1);
  });
});
