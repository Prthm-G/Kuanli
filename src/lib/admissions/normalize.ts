/**
 * Field normalizers for the office admission workbook.
 *
 * Every function here is pure and total: it either returns a confident value
 * or reports that it could not resolve one. Nothing guesses. A row the office
 * typed ambiguously must surface in the reconciliation report rather than
 * quietly become wrong data in production.
 */

/** Excel's day-zero. Serial 1 is 1900-01-01, and 1900 is treated as a leap year. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

/* ------------------------------------------------------------------ phones */

export interface PhoneResult {
  /** E.164-ish digits as Kuanli stores them (91XXXXXXXXXX), or null. */
  phone: string | null;
  reason?: 'blank' | 'not-indian-mobile';
}

/**
 * Indian mobile → the 12-digit `91`-prefixed form Kuanli stores (747 of 751
 * live contacts use it). Getting this wrong would duplicate every student the
 * moment they message on WhatsApp, so anything not confidently a mobile is
 * rejected for manual fixing rather than coerced.
 */
export function normalizeIndianPhone(raw: string | undefined | null): PhoneResult {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (!digits) return { phone: null, reason: 'blank' };

  // 10-digit local: Indian mobiles start 6-9.
  if (digits.length === 10 && /^[6-9]/.test(digits)) return { phone: `91${digits}` };
  // Already country-coded.
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) {
    return { phone: digits };
  }
  // Trunk-prefixed local (0XXXXXXXXXX).
  if (digits.length === 11 && digits.startsWith('0') && /^[6-9]/.test(digits.slice(1))) {
    return { phone: `91${digits.slice(1)}` };
  }
  return { phone: null, reason: 'not-indian-mobile' };
}

/* -------------------------------------------------------------------- money */

/**
 * `NO` and `NIL` → 0; a plain number → itself; anything else → null (unparseable).
 *
 * Blank is column-dependent and the caller must say which it means: an empty
 * DISC. genuinely means zero, but an empty TOTAL FEE or FEE DUE means the
 * office never recorded that figure. Booking a blank TOTAL FEE as 0 would
 * invent a free course; booking a blank FEE DUE as 0 would assert the student
 * owes nothing and make every partly-paid row look like a mismatch.
 */
export function parseMoneyish(
  raw: string | undefined | null,
  opts: { blankIsZero?: boolean } = {},
): number | null {
  const { blankIsZero = true } = opts;
  const v = (raw ?? '').trim();
  if (!v) return blankIsZero ? 0 : null;
  if (/^(no|nil)$/i.test(v)) return 0;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  return null;
}

export interface FeePaidResult {
  total: number;
  /** More than one instalment was jammed into the cell. */
  parts: number[];
  /** Comma-separated parts can't be told from Indian thousands ("3,500"). */
  ambiguous: boolean;
}

/**
 * `FEE PAID` holds either a number or several instalments in one cell
 * ("3600+3500"). All 15 such cells in the active cycles use `+`, which is
 * unambiguous. A comma is flagged rather than summed, because "3,500" and
 * "3,500" meaning two payments are indistinguishable.
 */
export function parseFeeCell(raw: string | undefined | null): FeePaidResult | null {
  const v = (raw ?? '').trim();
  if (!v) return { total: 0, parts: [], ambiguous: false };
  if (/^\d+(\.\d+)?$/.test(v)) return { total: Number(v), parts: [Number(v)], ambiguous: false };

  if (!/^[\d\s+/,.]+$/.test(v)) return null;
  const parts = (v.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (!parts.length) return null;
  return {
    total: parts.reduce((a, b) => a + b, 0),
    parts,
    ambiguous: v.includes(','),
  };
}

/* -------------------------------------------------------------------- dates */

/**
 * The Date column mixes Excel serials (46116) with free text
 * ("30-10-2025,4-2-26"). Only a clean serial or a single unambiguous
 * dd-mm-yyyy is converted; multi-date text returns null and is kept verbatim
 * in the note instead.
 */
export function parseExcelDate(raw: string | undefined | null): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;

  if (/^\d{5}$/.test(v)) {
    const serial = Number(v);
    // Guard against stray 5-digit numbers that aren't plausible dates.
    if (serial < 20000 || serial > 60000) return null;
    return new Date(EXCEL_EPOCH_UTC + serial * 86_400_000).toISOString().slice(0, 10);
  }

  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(v);
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const day = Number(d);
  const month = Number(mo);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ courses */

export type FeeMode = 'distance' | 'online';

export interface CourseResult {
  program: string | null;
  specialization: string;
  /** Set when the course cell itself overrides the sheet's mode ("MBA(online)"). */
  modeOverride?: FeeMode;
  /** Present when the cell could not be resolved to a programme. */
  reason?: string;
}

/** Excel spelling → `fee_templates.program`. */
const PROGRAM_ALIASES: Record<string, string> = {
  BA: 'BA', BBA: 'BBA', BCA: 'BCA', BLIS: 'BLIS', DLIS: 'DLIS', DBA: 'DBA', DCA: 'DCA',
  BCOM: 'BCOM', MCOM: 'MCOM', MA: 'MA', MBA: 'MBA', MCA: 'MCA', MLIS: 'MLIS',
  BSC: 'BSC', MSC: 'MSC',
};

/** Excel subject token → `fee_templates.specialization` (distance spellings). */
const SPEC_ALIASES: Record<string, string> = {
  SOC: 'Sociology', SOCIOLOGY: 'Sociology',
  HIS: 'History', HIST: 'History', HISTORY: 'History',
  ENG: 'English', ENGLISH: 'English',
  PBI: 'Punjabi', PUNJABI: 'Punjabi',
  POL: 'Polscience', POLSC: 'Polscience', POLSCI: 'Polscience',
  POLSCIENCE: 'Polscience',
  POLITICALSCIENCE: 'Polscience',
  EDU: 'Education', EDUCATION: 'Education',
  ECO: 'Economics', ECONOMICS: 'Economics',
  MATHS: 'Mathematics', MATH: 'Mathematics', MATHEMATICS: 'Mathematics',
  HINDI: 'Hindi',
  IT: 'It',
  // MBA concentrations.
  HOSM: 'Hospitalandhealthcare', DM: 'Digitalmarketing', HR: 'Hr',
  FINANCE: 'Finance', MARKETING: 'Marketing',
};

/** Programmes whose fee rows carry no specialization — a subject note is dropped. */
const NO_SPEC_PROGRAMS = new Set(['BA', 'BBA', 'BCA', 'BCOM', 'BLIS', 'DLIS', 'DBA', 'DCA', 'MCA', 'MCOM', 'MLIS']);

/** Programmes that always require a specialization to identify a fee row. */
const SPEC_REQUIRED_PROGRAMS = new Set(['MA', 'BSC', 'MSC']);

/**
 * "MA(Soc)", "MA SOC", "B.Com", "MBA HOS.M" → a programme + specialization that
 * matches `fee_templates`. Returns `program: null` with a reason when the cell
 * cannot be resolved confidently; the caller flags it for a human.
 */
export function normalizeCourse(raw: string | undefined | null): CourseResult {
  const original = (raw ?? '').trim();
  if (!original) return { program: null, specialization: '', reason: 'blank' };

  let s = original.toUpperCase();

  // An explicit mode word inside the course cell wins over the sheet's mode.
  let modeOverride: FeeMode | undefined;
  if (/\bONLINE\b/.test(s)) {
    modeOverride = 'online';
    s = s.replace(/\bONLINE\b/g, ' ');
  }
  if (/\bDISTANCE\b/.test(s)) {
    modeOverride = 'distance';
    s = s.replace(/\bDISTANCE\b/g, ' ');
  }

  // Semester/year noise the office adds ("BA 1ST SEM").
  s = s.replace(/\b\d+\s*(ST|ND|RD|TH)?\s*(SEM|SEMESTER|YEAR)\b/g, ' ');

  // Pull the subject out of brackets or a trailing token, then reduce to letters.
  const bracket = /\(([^)]*)\)/.exec(s);
  let specToken = bracket ? bracket[1] : '';
  s = s.replace(/\([^)]*\)/g, ' ');

  const compact = s.replace(/[^A-Z]/g, '');
  let programToken = '';
  for (const key of Object.keys(PROGRAM_ALIASES).sort((a, b) => b.length - a.length)) {
    if (compact.startsWith(key)) {
      programToken = key;
      if (!specToken) specToken = compact.slice(key.length);
      break;
    }
  }
  if (!programToken) {
    return { program: null, specialization: '', reason: `unrecognised course "${original}"` };
  }

  const program = PROGRAM_ALIASES[programToken];
  const specKey = specToken.replace(/[^A-Z]/gi, '').toUpperCase();

  if (NO_SPEC_PROGRAMS.has(program)) {
    // e.g. "BA(Pbi)" — BA has one fee row; the subject is a note, not a fee split.
    return { program, specialization: '', modeOverride };
  }

  const specialization = specKey ? SPEC_ALIASES[specKey] ?? '' : '';

  if (SPEC_REQUIRED_PROGRAMS.has(program) && !specialization) {
    return {
      program,
      specialization: '',
      modeOverride,
      reason: specKey
        ? `unrecognised ${program} specialization "${specToken}" in "${original}"`
        : `${program} needs a specialization to pick a fee row ("${original}")`,
    };
  }
  return { program, specialization, modeOverride };
}

/* ------------------------------------------------------------------- intake */

export interface SheetMeta {
  mode: FeeMode;
  intakeYear: string;
  intakeSession: string;
}

/** "2025-2 ONLINE" → { online, year 25, session 2 }. */
export function parseSheetName(name: string): SheetMeta | null {
  const m = /(\d{4})\s*-\s*(\d)/.exec(name);
  if (!m) return null;
  return {
    mode: /online/i.test(name) ? 'online' : 'distance',
    intakeYear: m[1].slice(2),
    intakeSession: m[2],
  };
}
