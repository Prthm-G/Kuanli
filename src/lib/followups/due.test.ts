import { describe, it, expect } from 'vitest';

import {
  actionableCount,
  bucketFor,
  bucketWorklist,
  daysOverdue,
  describeDue,
} from './due';
import type { WorklistRow } from './types';

/** 19 Aug 2026, 17:20 local. Late in the day on purpose: the day-boundary
 *  rule (a commitment due 9am today is still "today" at 5pm) is exactly the
 *  thing an hours-based implementation gets wrong. */
const NOW = new Date(2026, 7, 19, 17, 20, 0);

/** Local-time ISO-ish string for a given day/hour, so tests do not depend on
 *  the machine's UTC offset. */
const at = (day: number, hour = 9) =>
  new Date(2026, 7, day, hour, 0, 0).toISOString();

function row(dueAt: string, id = dueAt): WorklistRow {
  return {
    contactId: id,
    entryId: id,
    conversationId: null,
    name: 'Test Lead',
    phone: null,
    rollNumber: null,
    university: null,
    stageName: null,
    occurredAt: at(15),
    method: 'call',
    outcome: 'callback_requested',
    summary: 'Promised a callback',
    nextDueAt: dueAt,
    nextMethod: 'call',
    loggedBy: 'user-1',
    loggedByName: 'Simran',
  };
}

describe('daysOverdue', () => {
  it('counts whole calendar days, not elapsed hours', () => {
    // Due 9am today, now 5:20pm — same calendar day, so zero.
    expect(daysOverdue(at(19, 9), NOW)).toBe(0);
    // Due 11pm yesterday: only ~18 hours ago, but a day late.
    expect(daysOverdue(at(18, 23), NOW)).toBe(1);
  });

  it('is negative for future commitments', () => {
    expect(daysOverdue(at(22), NOW)).toBe(-3);
  });

  it('handles multi-day overdue', () => {
    expect(daysOverdue(at(12), NOW)).toBe(7);
  });
});

describe('bucketFor', () => {
  it('keeps a commitment made for earlier today in Today', () => {
    expect(bucketFor(at(19, 8), NOW)).toBe('today');
  });

  it('moves yesterday to Overdue', () => {
    expect(bucketFor(at(18), NOW)).toBe('overdue');
  });

  it('treats the next seven days as this week', () => {
    expect(bucketFor(at(20), NOW)).toBe('week');
    expect(bucketFor(at(26), NOW)).toBe('week');
  });

  it('pushes day eight and beyond to Later', () => {
    expect(bucketFor(at(27), NOW)).toBe('later');
    expect(bucketFor(new Date(2026, 9, 1).toISOString(), NOW)).toBe('later');
  });
});

describe('bucketWorklist', () => {
  it('always returns every bucket, even when empty', () => {
    const result = bucketWorklist([], NOW);
    expect(Object.keys(result).sort()).toEqual([
      'later',
      'overdue',
      'today',
      'week',
    ]);
  });

  it('preserves input order within a bucket', () => {
    const result = bucketWorklist(
      [row(at(15), 'a'), row(at(17), 'b'), row(at(19), 'c')],
      NOW
    );
    expect(result.overdue.map((r) => r.contactId)).toEqual(['a', 'b']);
    expect(result.today.map((r) => r.contactId)).toEqual(['c']);
  });
});

describe('actionableCount', () => {
  it('counts overdue and today, never future work', () => {
    const rows = [row(at(15), 'a'), row(at(19), 'b'), row(at(25), 'c')];
    expect(actionableCount(rows, NOW)).toBe(2);
  });

  it('is zero when everything is scheduled ahead', () => {
    expect(actionableCount([row(at(21)), row(at(30))], NOW)).toBe(0);
  });
});

describe('describeDue', () => {
  it('singularises one day', () => {
    expect(describeDue(at(18), NOW)).toBe('1 day overdue');
    expect(describeDue(at(17), NOW)).toBe('2 days overdue');
  });

  it('reads naturally for today and tomorrow', () => {
    expect(describeDue(at(19, 9), NOW)).toBe('due today');
    expect(describeDue(at(20), NOW)).toBe('due tomorrow');
    expect(describeDue(at(23), NOW)).toBe('due in 4 days');
  });
});
