import { describe, it, expect } from 'vitest';
import {
  normalizeIndianPhone,
  parseMoneyish,
  parseFeeCell,
  parseExcelDate,
  normalizeCourse,
  parseSheetName,
} from './normalize';

describe('normalizeIndianPhone', () => {
  it('prefixes 91 onto a 10-digit mobile — the format Kuanli stores', () => {
    expect(normalizeIndianPhone('9000000001').phone).toBe('919000000001');
  });

  it('accepts an already country-coded number unchanged', () => {
    expect(normalizeIndianPhone('919000000001').phone).toBe('919000000001');
  });

  it('strips separators before deciding', () => {
    expect(normalizeIndianPhone('+91 90000-00001').phone).toBe('919000000001');
  });

  it('drops a trunk 0 prefix', () => {
    expect(normalizeIndianPhone('09000000001').phone).toBe('919000000001');
  });

  it.each([
    ['900000001', '9 digits'],
    ['90000000001', '11 digits, no trunk 0'],
    ['1234567890', 'does not start 6-9'],
  ])('rejects %s (%s) rather than coercing it', (input) => {
    const r = normalizeIndianPhone(input);
    expect(r.phone).toBeNull();
    expect(r.reason).toBe('not-indian-mobile');
  });

  it('reports blank separately from invalid', () => {
    expect(normalizeIndianPhone('').reason).toBe('blank');
  });
});

describe('parseMoneyish', () => {
  it('treats the office shorthand NO as zero', () => {
    expect(parseMoneyish('NO')).toBe(0);
    expect(parseMoneyish('no ')).toBe(0);
  });

  it('treats the office shorthand NIL as zero', () => {
    expect(parseMoneyish('NIL')).toBe(0);
    expect(parseMoneyish(' nil ')).toBe(0);
  });

  it('treats blank as zero by default (FEE DUE / DISC. semantics)', () => {
    expect(parseMoneyish('')).toBe(0);
  });

  it('reports blank as unknown when the caller says so (TOTAL FEE semantics)', () => {
    expect(parseMoneyish('', { blankIsZero: false })).toBeNull();
  });

  it('reads a plain amount', () => {
    expect(parseMoneyish('8100')).toBe(8100);
  });

  it('returns null for text it cannot read, instead of guessing', () => {
    expect(parseMoneyish('NO BOOKS')).toBeNull();
  });
});

describe('parseFeeCell', () => {
  it('sums instalments jammed into one cell', () => {
    expect(parseFeeCell('3600+3500')?.total).toBe(7100);
    expect(parseFeeCell('3000+2500+2600')?.total).toBe(8100);
  });

  it('keeps the individual parts for the report', () => {
    expect(parseFeeCell('1000+7100')?.parts).toEqual([1000, 7100]);
  });

  it('flags comma cells as ambiguous — "3,500" could be thousands', () => {
    expect(parseFeeCell('3,500')?.ambiguous).toBe(true);
    expect(parseFeeCell('3600+3500')?.ambiguous).toBe(false);
  });

  it('returns null for non-numeric text', () => {
    expect(parseFeeCell('paid in full')).toBeNull();
  });
});

describe('parseExcelDate', () => {
  it('converts an Excel serial using the 1899-12-30 epoch', () => {
    // Exact for every date from 1900-03-01 on, which the serial guard ensures.
    expect(parseExcelDate('45964')).toBe('2025-11-03');
    expect(parseExcelDate('46116')).toBe('2026-04-04');
  });

  it('reads a dd-mm-yyyy cell', () => {
    expect(parseExcelDate('30-10-2025')).toBe('2025-10-30');
  });

  it('expands a 2-digit year', () => {
    expect(parseExcelDate('4-2-26')).toBe('2026-02-04');
  });

  it('returns null for multi-date text rather than picking one', () => {
    expect(parseExcelDate('30-10-2025,4-2-26')).toBeNull();
  });

  it('rejects an implausible serial', () => {
    expect(parseExcelDate('99999')).toBeNull();
  });
});

describe('normalizeCourse', () => {
  it.each([
    ['B.Com', 'BCOM'],
    ['B.COM', 'BCOM'],
    ['B.com', 'BCOM'],
    ['BCOM', 'BCOM'],
    ['Ba', 'BA'],
    ['M.COM', 'MCOM'],
  ])('folds the spelling %s to %s', (input, program) => {
    expect(normalizeCourse(input).program).toBe(program);
  });

  it.each([
    ['MA(Soc)', 'Sociology'],
    ['MA SOC', 'Sociology'],
    ['MA (SOC)', 'Sociology'],
    ['MA(His)', 'History'],
    ['MA(ENG)', 'English'],
    ['MA PBI', 'Punjabi'],
    ['MA(pol sci)', 'Polscience'],
    ['MA(EDU)', 'Education'],
  ])('extracts the specialization from %s', (input, spec) => {
    const r = normalizeCourse(input);
    expect(r.program).toBe('MA');
    expect(r.specialization).toBe(spec);
  });

  it('maps MBA concentrations', () => {
    expect(normalizeCourse('MBA HOS.M').specialization).toBe('Hospitalandhealthcare');
    expect(normalizeCourse('Mba D.M').specialization).toBe('Digitalmarketing');
  });

  it('reads BSc/MSc IT variants', () => {
    expect(normalizeCourse('BSC.IT')).toMatchObject({ program: 'BSC', specialization: 'It' });
    expect(normalizeCourse('Bsc IT')).toMatchObject({ program: 'BSC', specialization: 'It' });
    expect(normalizeCourse('M.Sc It')).toMatchObject({ program: 'MSC', specialization: 'It' });
  });

  it('lets the course cell override the sheet mode', () => {
    expect(normalizeCourse('MBA(online)').modeOverride).toBe('online');
    expect(normalizeCourse('BA online')).toMatchObject({ program: 'BA', modeOverride: 'online' });
  });

  it('strips semester noise', () => {
    expect(normalizeCourse('BA 1ST SEM').program).toBe('BA');
  });

  it('drops a subject note for programmes with a single fee row', () => {
    // BA has no per-subject fee rows, so "(Pbi)" is a note, not a fee split.
    expect(normalizeCourse('BA(Pbi)')).toMatchObject({ program: 'BA', specialization: '' });
    expect(normalizeCourse('BLIS(Eng)')).toMatchObject({ program: 'BLIS', specialization: '' });
  });

  it('refuses a bare MA, which cannot identify a fee row', () => {
    const r = normalizeCourse('MA');
    expect(r.program).toBe('MA');
    expect(r.specialization).toBe('');
    expect(r.reason).toMatch(/needs a specialization/);
  });

  it('reports an unrecognised course instead of guessing', () => {
    expect(normalizeCourse('BTech Robotics').program).toBeNull();
  });
});

describe('parseSheetName', () => {
  it('reads mode and intake from the tab name', () => {
    expect(parseSheetName('2025-2')).toEqual({ mode: 'distance', intakeYear: '25', intakeSession: '2' });
    expect(parseSheetName('2025-2 ONLINE')).toEqual({ mode: 'online', intakeYear: '25', intakeSession: '2' });
    expect(parseSheetName('2026-1 online')).toEqual({ mode: 'online', intakeYear: '26', intakeSession: '1' });
  });

  it('returns null for a tab it cannot read', () => {
    expect(parseSheetName('Summary')).toBeNull();
  });
});
