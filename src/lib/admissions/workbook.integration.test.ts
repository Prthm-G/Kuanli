/**
 * Integration check against the office's real workbook.
 *
 * The file holds live student PII and is gitignored, so it is absent on any
 * other machine: these cases skip rather than fail when it is missing. They
 * exist to keep the parser honest about the actual sheet, and the expected
 * counts double as the migration's acceptance criteria.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { readWorkbook } from './xlsx-lite';
import { parseAdmissionSheet } from './parse-sheet';
import { reconcile } from './reconcile';
import { ACTIVE_SHEETS } from './index';

// Path comes from the environment: the workbook contains live student data and
// must never be referenced by an absolute path committed to this repository.
//   ADMISSION_WORKBOOK=/path/to/book.xlsx npm run test
const WORKBOOK = process.env.ADMISSION_WORKBOOK ?? '';

const hasWorkbook = Boolean(WORKBOOK) && existsSync(WORKBOOK);
const maybe = hasWorkbook ? describe : describe.skip;

maybe('real admission workbook', () => {
  // Read inside beforeAll, not in the describe body: a skipped describe still
  // has its body evaluated during collection, so touching the file here would
  // break the suite on machines that do not have the workbook.
  let wb: ReturnType<typeof readWorkbook>;
  let parsed: ReturnType<typeof parseAdmissionSheet>['rows'];
  let res: ReturnType<typeof reconcile>;

  beforeAll(() => {
    wb = readWorkbook(readFileSync(WORKBOOK));
    parsed = ACTIVE_SHEETS.flatMap((name) => parseAdmissionSheet(name, wb.sheet(name)).rows);
    res = reconcile(parsed);
  });

  it('reads all twelve cycle tabs', () => {
    expect(wb.sheetNames).toHaveLength(12);
    expect(wb.sheetNames).toContain('2025-2');
    expect(wb.sheetNames).toContain('2026-1 online');
  });

  it('parses 345 students across the active cycles', () => {
    expect(parsed).toHaveLength(345);
  });

  it('holds back the five shared-phone pairs and imports 335', () => {
    expect(res.stats.heldBack).toBe(10);
    expect(res.stats.importable).toBe(335);
  });

  it('splits stages by registration number', () => {
    expect(res.stats.enrolled + res.stats.applicationStarted).toBe(335);
    // Every Enrolled student must actually carry a university roll number.
    expect(res.importable.filter((r) => r.stage === 'Enrolled').every((r) => r.universityRollNumber)).toBe(true);
  });

  it('normalizes every importable phone to the 91-prefixed form Kuanli stores', () => {
    const withPhone = res.importable.filter((r) => r.importPhone);
    expect(withPhone.length).toBeGreaterThan(300);
    expect(withPhone.every((r) => /^91[6-9]\d{9}$/.test(r.importPhone))).toBe(true);
  });

  it('resolves all but the known-ambiguous courses', () => {
    // 9 bare "MA" rows plus MSC ECO / MSC Maths, which exist only in online mode.
    expect(res.stats.unresolvedCourse).toBe(9);
  });

  it('surfaces the fee rows that do not add up instead of correcting them', () => {
    expect(res.stats.feeMismatches).toBeGreaterThan(0);
    expect(res.flags.some((f) => f.code === 'fee-mismatch')).toBe(true);
  });

  it('finds the seven plaintext portal passwords', () => {
    expect(res.stats.withPassword).toBe(7);
  });

  it('never emits a negative or NaN fee figure', () => {
    for (const r of res.importable) {
      expect(Number.isFinite(r.openingPaid)).toBe(true);
      expect(r.openingPaid).toBeGreaterThanOrEqual(0);
      expect(r.discountAmount).toBeGreaterThanOrEqual(0);
      if (r.agreedTotal !== null) expect(r.agreedTotal).toBeGreaterThan(0);
    }
  });
});
