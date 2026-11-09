import { describe, expect, it } from 'vitest';

import { formatIntake, holdBackForIntake, implausibleIntake } from './intake';
import type { ReconcileResult } from './reconcile';

const I = (year: string, session: string) => ({ year, session });
// 9 Nov 2026, 12:00 IST.
const NOW = new Date('2026-11-09T06:30:00Z');

describe('formatIntake', () => {
  it('reads 2- and 4-digit years as the same year', () => {
    expect(formatIntake(I('26', '1'))).toBe('2026-1');
    expect(formatIntake(I('2025', '2'))).toBe('2025-2');
  });
});

describe('implausibleIntake', () => {
  it('this year, last year and next year are fine', () => {
    for (const i of [
      I('26', '1'),
      I('2026', '2'),
      I('25', '2'),
      I('2024', '1'),
      I('27', '1'),
    ]) {
      expect(implausibleIntake(i, NOW)).toBeNull();
    }
  });

  it('a 2062-1 tab is implausible, and so is the year after next', () => {
    expect(implausibleIntake(I('62', '1'), NOW)).toMatch(
      /2062-1 is after 2027/
    );
    expect(implausibleIntake(I('2028', '1'), NOW)).toMatch(/2028-1/);
  });

  it('the year is compared numerically whatever its width', () => {
    expect(implausibleIntake(I('2027', '2'), NOW)).toBeNull();
    expect(implausibleIntake(I('27', '2'), NOW)).toBeNull();
    expect(implausibleIntake(I('2062', '1'), NOW)).toMatch(/2062-1/);
  });

  it('an unreadable intake is implausible', () => {
    expect(implausibleIntake(I('26', '5'), NOW)).toMatch(/cannot be read/);
    expect(implausibleIntake(I('2x', '1'), NOW)).toMatch(/cannot be read/);
    expect(implausibleIntake(I('26026', '1'), NOW)).toMatch(/cannot be read/);
  });

  it('uses the IST calendar year', () => {
    // 31 Dec 2026, 20:00 UTC is already 1 Jan 2027 in India: 2028 is next year there.
    expect(
      implausibleIntake(I('28', '1'), new Date('2026-12-31T20:00:00Z'))
    ).toBeNull();
  });
});

describe('holdBackForIntake', () => {
  const row = (n: number) =>
    ({
      name: `Student ${n}`,
      rowNumber: n,
      sheet: '2062-1 ONLINE',
      stage: 'Enrolled',
      importPhone: `91000000000${n}`,
    }) as never;
  const result = {
    importable: [row(2), row(3)],
    heldBack: [{ row: row(4), reason: 'phone shared' }],
    flags: [],
    stats: {
      parsed: 3,
      importable: 2,
      heldBack: 1,
      enrolled: 2,
      applicationStarted: 0,
      feeMismatches: 0,
      noPhone: 0,
      badPhone: 0,
      unresolvedCourse: 0,
      withPassword: 1,
      withPayment: 1,
      withDiscount: 0,
    },
  } as unknown as ReconcileResult;

  it('holds every row back with a blocker, so no implausible intake is written', () => {
    const r = holdBackForIntake(result, 'intake 2062-1 is after 2027');
    expect(r.importable).toEqual([]);
    expect(r.heldBack.map((h) => h.row.rowNumber)).toEqual([4, 2, 3]);
    expect(
      r.flags.filter(
        (f) => f.level === 'blocker' && f.code === 'implausible-intake'
      )
    ).toHaveLength(2);
    expect(r.stats).toMatchObject({
      parsed: 3,
      importable: 0,
      heldBack: 3,
      enrolled: 0,
      withPassword: 0,
    });
  });
});
