import { describe, it, expect } from 'vitest';
import { parseAdmissionSheet } from './parse-sheet';
import { reconcile } from './reconcile';
import type { SheetRows } from './xlsx-lite';

/** The office layout, as column letters, so tests read like the real sheet. */
const HEADER: Record<string, string> = {
  A: 'S.NO.', B: 'NAME ', C: "FATHER'S NAME", D: 'COURSE', E: 'dd/mm/yr',
  F: 'EXAM CENTRE', G: 'REG NO', H: 'Password', I: 'Ref Person',
  J: 'CONATCT NO', K: 'CONATCT NO', L: 'TOTAL FEE', M: 'FEE PAID',
  N: 'FEE DUE', O: 'DISC.', P: 'Date', Q: 'REC. NO', R: 'BOOKS', S: 'EMAIL ID',
};

function sheet(...rows: Array<Record<string, string>>): SheetRows {
  return [HEADER, ...rows];
}

describe('parseAdmissionSheet', () => {
  it('resolves columns from header text, not fixed letters', () => {
    // A later cycle dropped BOOKS, so EMAIL ID sits at R instead of S.
    const drifted: Record<string, string> = { ...HEADER };
    delete drifted.R;
    drifted.R = 'EMAIL ID';
    delete drifted.S;
    const { rows } = parseAdmissionSheet('2026-1', [
      drifted,
      { B: 'Student On Drifted Sheet', D: 'B.Com', L: '11100', M: '10000', R: 'k@example.com' },
    ]);
    expect(rows[0].email).toBe('k@example.com');
  });

  it('takes the first CONATCT NO column as the primary number', () => {
    const { rows } = parseAdmissionSheet('2025-2', sheet({
      B: 'Student With Two Numbers', J: '9000000001', K: '9000000002', L: '8100', M: '3600+3500',
    }));
    expect(rows[0].phone).toBe('919000000001');
    expect(rows[0].secondaryPhone).toBe('919000000002');
  });

  it('sums a multi-instalment fee cell', () => {
    const { rows } = parseAdmissionSheet('2025-2', sheet({
      B: 'A', J: '9000000001', L: '8100', M: '3600+3500', N: 'NO', O: '1000',
    }));
    expect(rows[0].feePaid).toBe(7100);
  });

  it('skips blank spacer rows', () => {
    const { rows } = parseAdmissionSheet('2025-2', sheet({ A: '1' }, { B: 'Student After Spacer Row', J: '9000000001' }));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Student After Spacer Row');
  });

  it('reports headers it did not map instead of dropping them silently', () => {
    const { unmappedHeaders } = parseAdmissionSheet('2025-2', sheet({ B: 'A' }));
    expect(unmappedHeaders).toContain('BOOKS');
    expect(unmappedHeaders).toContain('Ref Person');
  });

  it('carries mode and intake from the sheet name', () => {
    const { rows } = parseAdmissionSheet('2025-2 ONLINE', sheet({ B: 'A', J: '9000000001' }));
    expect(rows[0]).toMatchObject({ mode: 'online', intakeYear: '25', intakeSession: '2' });
  });
});

describe('reconcile', () => {
  const parse = (...rows: Array<Record<string, string>>) =>
    parseAdmissionSheet('2025-2', sheet(...rows)).rows;

  it('holds back BOTH rows of a shared phone rather than merging students', () => {
    const res = reconcile(parse(
      { B: 'Shared Phone Student A', J: '9000000003', L: '8100', M: '8100' },
      { B: 'Shared Phone Student B', J: '9000000003', L: '8100', M: '8100' },
      { B: 'Unique student', J: '9000000001', L: '8100', M: '8100' },
    ));
    expect(res.heldBack).toHaveLength(2);
    expect(res.importable).toHaveLength(1);
    expect(res.importable[0].name).toBe('Unique student');
    expect(res.flags.filter((f) => f.code === 'duplicate-phone')).toHaveLength(2);
  });

  it('still imports a student with no phone at all', () => {
    const res = reconcile(parse({ B: 'Student Without Phone', L: '8100', M: '8100' }));
    expect(res.importable).toHaveLength(1);
    expect(res.importable[0].importPhone).toBe('');
    expect(res.flags.some((f) => f.code === 'no-phone')).toBe(true);
  });

  it('imports a malformed phone without a number, and flags it', () => {
    const res = reconcile(parse({ B: 'Student With Bad Phone', J: '900000001', L: '8100', M: '8100' }));
    expect(res.importable[0].importPhone).toBe('');
    expect(res.flags.some((f) => f.code === 'bad-phone')).toBe(true);
  });

  it('computes the balance as total - discount - paid', () => {
    const res = reconcile(parse({ B: 'A', J: '9000000001', L: '8100', M: '3600+3500', N: 'NO', O: '1000' }));
    expect(res.importable[0].outstanding).toBe(0);
    expect(res.importable[0].feeReconciles).toBe(true);
  });

  it('imports a non-reconciling row and flags the discrepancy', () => {
    // Mirrors a real shape from the office sheet: the stated due does not
    // match total - discount - paid.
    const res = reconcile(parse({ B: 'Student With Mismatched Fees', J: '9000000001', L: '13500', M: '3500', N: '10000', O: '600' }));
    expect(res.importable).toHaveLength(1);
    expect(res.importable[0].feeReconciles).toBe(false);
    expect(res.flags.some((f) => f.code === 'fee-mismatch')).toBe(true);
  });

  it('stages by registration number, not by fee status', () => {
    const res = reconcile(parse(
      { B: 'Has roll', J: '9000000001', G: '22500000001', L: '8100', M: '0' },
      { B: 'No roll', J: '9000000004', L: '8100', M: '8100' },
    ));
    expect(res.importable.find((r) => r.name === 'Has roll')!.stage).toBe('Enrolled');
    expect(res.importable.find((r) => r.name === 'No roll')!.stage).toBe('Application Started');
  });

  it('flags a missing total fee and creates no plan figure', () => {
    const res = reconcile(parse({ B: 'A', J: '9000000001', M: '1000' }));
    expect(res.importable[0].agreedTotal).toBeNull();
    expect(res.flags.some((f) => f.code === 'no-total-fee')).toBe(true);
  });

  it('flags a bare MA, which names a programme but no fee row', () => {
    const res = reconcile(parse({ B: 'A', J: '9000000001', D: 'MA', L: '8100', M: '8100' }));
    expect(res.flags.some((f) => f.code === 'course-unresolved')).toBe(true);
    expect(res.stats.unresolvedCourse).toBe(1);
  });

  it('does not flag a course that resolves cleanly', () => {
    const res = reconcile(parse({ B: 'A', J: '9000000001', D: 'MA(Soc)', L: '8100', M: '8100' }));
    expect(res.flags.some((f) => f.code === 'course-unresolved')).toBe(false);
  });

  it('flags an overpayment', () => {
    const res = reconcile(parse({ B: 'A', J: '9000000001', L: '8100', M: '9000' }));
    expect(res.flags.some((f) => f.code === 'overpaid')).toBe(true);
  });
});
