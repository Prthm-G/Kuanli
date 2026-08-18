import { describe, it, expect } from 'vitest';

import {
  toEnrollmentCode,
  defaultIntake,
  ENROLLMENT_UNIVERSITIES,
} from './university-code';

describe('toEnrollmentCode', () => {
  it("maps the bot's Amity to the AMI enrollment code", () => {
    // The regression this exists for: unmapped, this mints DAmity26J0001.
    expect(toEnrollmentCode('Amity')).toBe('AMI');
  });

  it('passes LPU through unchanged', () => {
    expect(toEnrollmentCode('LPU')).toBe('LPU');
  });

  it('is case and whitespace insensitive', () => {
    expect(toEnrollmentCode('  amity ')).toBe('AMI');
    expect(toEnrollmentCode('lpu')).toBe('LPU');
  });

  it("maps the bot's DBU to the DBU enrollment code", () => {
    // Operator decision 2026-08-18: DBU leads are enrolled.
    expect(toEnrollmentCode('DBU')).toBe('DBU');
  });

  it('returns null for CU now that it is no longer offered', () => {
    // Operator decision 2026-08-18: CU is not a live partner any more.
    expect(toEnrollmentCode('CU')).toBeNull();
  });

  it('returns null for empty or unknown input', () => {
    expect(toEnrollmentCode(null)).toBeNull();
    expect(toEnrollmentCode('')).toBeNull();
    expect(toEnrollmentCode('Oxford')).toBeNull();
  });

  it('only ever yields a code the generator actually offers', () => {
    const valid = ENROLLMENT_UNIVERSITIES.map((u) => u.code);
    for (const input of ['LPU', 'Amity', 'DBU', 'CU', 'nonsense', null]) {
      const out = toEnrollmentCode(input);
      if (out !== null) expect(valid).toContain(out);
    }
  });
});

describe('defaultIntake', () => {
  it('gives a two-digit year, matching DLPU26J0001', () => {
    expect(defaultIntake(new Date(2026, 2, 1)).year).toBe('26');
  });

  it('targets July for the first half of the year', () => {
    expect(defaultIntake(new Date(2026, 0, 15))).toEqual({
      year: '26',
      session: 'J',
    });
    expect(defaultIntake(new Date(2026, 6, 2))).toEqual({
      year: '26',
      session: 'J',
    });
  });

  it('targets August during August', () => {
    expect(defaultIntake(new Date(2026, 7, 18))).toEqual({
      year: '26',
      session: 'A',
    });
  });

  it('rolls to next July once both intakes have passed', () => {
    expect(defaultIntake(new Date(2026, 10, 3))).toEqual({
      year: '27',
      session: 'J',
    });
  });

  it('keeps the year two digits across the century boundary', () => {
    // 2100 % 100 is 0; the roll number needs "00", not "0", or DLPU0J0001.
    expect(defaultIntake(new Date(2099, 10, 1))).toEqual({
      year: '00',
      session: 'J',
    });
  });
});
