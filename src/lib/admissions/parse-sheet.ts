/**
 * Workbook sheet → structured admission rows.
 *
 * Columns are resolved from the HEADER TEXT, never from fixed letters: the
 * office's sheets drift (2026-1 dropped BOOKS, shifting EMAIL ID from S to R),
 * and two columns share the header "CONATCT NO". Header-driven resolution is
 * what lets the same parser serve future cycles in the import UI.
 */

import type { SheetRows } from './xlsx-lite';
import {
  normalizeCourse,
  normalizeIndianPhone,
  parseExcelDate,
  parseFeeCell,
  parseMoneyish,
  parseSheetName,
  type CourseResult,
  type FeeMode,
} from './normalize';

export interface ParsedAdmissionRow {
  /** 1-based row number in the sheet, for pointing the office at a cell. */
  rowNumber: number;
  sheet: string;
  mode: FeeMode;
  intakeYear: string;
  intakeSession: string;

  name: string;
  fatherName: string;
  rawCourse: string;
  course: CourseResult;
  /** Course-cell mode override already applied. */
  effectiveMode: FeeMode;

  /** 91-prefixed, or null when absent/unparseable. */
  phone: string | null;
  phoneRaw: string;
  phoneIssue?: 'blank' | 'not-indian-mobile';
  secondaryPhone: string | null;

  email: string;
  universityRollNumber: string;
  portalPassword: string;
  receiptNumber: string;
  paymentDate: string | null;
  rawPaymentDate: string;

  totalFee: number | null;
  feePaid: number;
  feePaidAmbiguous: boolean;
  feeDue: number | null;
  discount: number | null;
  /** Cells that could not be read as money at all. */
  unparseableMoney: string[];
}

/** Normalize a header cell for matching: upper, letters+digits only. */
const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** header key → the column letters carrying it, in sheet order. */
function headerIndex(header: Record<string, string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const letters = Object.keys(header).sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
  for (const col of letters) {
    const k = key(header[col] ?? '');
    if (!k) continue;
    const list = map.get(k) ?? [];
    list.push(col);
    map.set(k, list);
  }
  return map;
}

/** First column whose header matches any of `names`; `nth` picks a repeat. */
function pick(
  idx: Map<string, string[]>,
  names: string[],
  nth = 0,
): string | undefined {
  for (const n of names) {
    const cols = idx.get(key(n));
    if (cols && cols[nth]) return cols[nth];
  }
  return undefined;
}

export interface SheetParseResult {
  rows: ParsedAdmissionRow[];
  /** Header names present in the sheet but not mapped — surfaced, not ignored. */
  unmappedHeaders: string[];
}

/** True when a sheet looks like an admission register (has the core columns). */
export function looksLikeAdmissionSheet(rows: SheetRows): boolean {
  if (!rows.length) return false;
  const idx = headerIndex(rows[0]);
  return Boolean(pick(idx, ['NAME']) && pick(idx, ['COURSE']) && pick(idx, ['TOTAL FEE']));
}

export function parseAdmissionSheet(
  sheetName: string,
  rows: SheetRows,
): SheetParseResult {
  const meta = parseSheetName(sheetName);
  if (!meta) throw new Error(`Cannot read intake from sheet name "${sheetName}"`);
  if (!rows.length) return { rows: [], unmappedHeaders: [] };

  const header = rows[0];
  const idx = headerIndex(header);

  const col = {
    name: pick(idx, ['NAME']),
    father: pick(idx, ["FATHER'S NAME", 'FATHERS NAME', 'FATHER NAME']),
    course: pick(idx, ['COURSE']),
    regNo: pick(idx, ['REG NO', 'REGNO']),
    password: pick(idx, ['PASSWORD']),
    phone1: pick(idx, ['CONATCT NO', 'CONTACT NO'], 0),
    phone2: pick(idx, ['CONATCT NO', 'CONTACT NO'], 1),
    totalFee: pick(idx, ['TOTAL FEE']),
    feePaid: pick(idx, ['FEE PAID']),
    feeDue: pick(idx, ['FEE DUE']),
    discount: pick(idx, ['DISC.', 'DISC', 'DISCOUNT']),
    payDate: pick(idx, ['DATE'], 0),
    receipt: pick(idx, ['REC. NO', 'REC NO', 'RECNO']),
    email: pick(idx, ['EMAIL ID', 'EMAIL', 'EMAILID']),
  };

  const mapped = new Set(Object.values(col).filter(Boolean) as string[]);
  const unmappedHeaders = Object.keys(header)
    .filter((c) => !mapped.has(c) && (header[c] ?? '').trim())
    .map((c) => header[c].trim());

  const get = (r: Record<string, string>, c: string | undefined) =>
    (c ? r[c] ?? '' : '').trim();

  const out: ParsedAdmissionRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = get(r, col.name);
    if (!name) continue; // blank spacer rows

    const rawCourse = get(r, col.course);
    const course = normalizeCourse(rawCourse);
    const phoneRaw = get(r, col.phone1);
    const primary = normalizeIndianPhone(phoneRaw);
    const secondary = normalizeIndianPhone(get(r, col.phone2));

    const totalFee = parseMoneyish(get(r, col.totalFee), { blankIsZero: false });
    const paidCell = parseFeeCell(get(r, col.feePaid));
    const feeDue = parseMoneyish(get(r, col.feeDue), { blankIsZero: false });
    const discount = parseMoneyish(get(r, col.discount));

    const unparseableMoney: string[] = [];
    // A blank total is reported as `no-total-fee`, not as unreadable text.
    if (totalFee === null && get(r, col.totalFee)) {
      unparseableMoney.push(`TOTAL FEE="${get(r, col.totalFee)}"`);
    }
    if (paidCell === null) unparseableMoney.push(`FEE PAID="${get(r, col.feePaid)}"`);
    if (feeDue === null && get(r, col.feeDue)) {
      unparseableMoney.push(`FEE DUE="${get(r, col.feeDue)}"`);
    }
    if (discount === null) unparseableMoney.push(`DISC="${get(r, col.discount)}"`);

    const rawPaymentDate = get(r, col.payDate);

    out.push({
      rowNumber: i + 1,
      sheet: sheetName,
      mode: meta.mode,
      intakeYear: meta.intakeYear,
      intakeSession: meta.intakeSession,
      name,
      fatherName: get(r, col.father),
      rawCourse,
      course,
      effectiveMode: course.modeOverride ?? meta.mode,
      phone: primary.phone,
      phoneRaw,
      phoneIssue: primary.reason,
      secondaryPhone: secondary.phone,
      email: get(r, col.email),
      universityRollNumber: get(r, col.regNo),
      portalPassword: get(r, col.password),
      receiptNumber: get(r, col.receipt),
      paymentDate: parseExcelDate(rawPaymentDate),
      rawPaymentDate,
      totalFee,
      feePaid: paidCell?.total ?? 0,
      feePaidAmbiguous: paidCell?.ambiguous ?? false,
      feeDue,
      discount,
      unparseableMoney,
    });
  }

  return { rows: out, unmappedHeaders };
}
