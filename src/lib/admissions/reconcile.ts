/**
 * Decides what may be imported, what is held back, and what a human must look
 * at. Both the one-time backfill and the import UI route every row through
 * here, so the two can never disagree about a borderline student.
 *
 * Policy (set with the operator, 2026-08-26):
 *  - a phone that appears on more than one row is AMBIGUOUS: it may be the same
 *    student re-enrolling or two siblings sharing a handset. All such rows are
 *    held back for a human, never merged silently.
 *  - a row with no phone at all still imports (phone ''), because the DB's
 *    unique index deliberately excludes empty values.
 *  - fee arithmetic that does not close is imported and flagged, not corrected.
 */

import type { ParsedAdmissionRow } from './parse-sheet';

export type FlagLevel = 'blocker' | 'review';

export interface Flag {
  level: FlagLevel;
  sheet: string;
  rowNumber: number;
  student: string;
  code: string;
  detail: string;
}

export interface ReconciledRow extends ParsedAdmissionRow {
  /** 91-prefixed number, or '' for the phone-less students. */
  importPhone: string;
  /** List price the student was quoted. Null when the sheet omitted it. */
  agreedTotal: number | null;
  /** Concession to record as an approved discount. */
  discountAmount: number;
  /** Single opening-balance payment. Zero means no payment row is written. */
  openingPaid: number;
  /** total - discount - paid, when all three are known. */
  outstanding: number | null;
  /** Enrolled once the university has issued a registration number. */
  stage: 'Enrolled' | 'Application Started';
  feeReconciles: boolean;
}

export interface ReconcileResult {
  importable: ReconciledRow[];
  heldBack: Array<{ row: ParsedAdmissionRow; reason: string }>;
  flags: Flag[];
  stats: {
    parsed: number;
    importable: number;
    heldBack: number;
    enrolled: number;
    applicationStarted: number;
    feeMismatches: number;
    noPhone: number;
    badPhone: number;
    unresolvedCourse: number;
    withPassword: number;
    withPayment: number;
    withDiscount: number;
  };
}

/** Rupee tolerance when checking whether a row's fee columns agree. */
const FEE_TOLERANCE = 1;

export function reconcile(rows: ParsedAdmissionRow[]): ReconcileResult {
  const flags: Flag[] = [];
  const heldBack: ReconcileResult['heldBack'] = [];

  const flag = (r: ParsedAdmissionRow, level: FlagLevel, code: string, detail: string) =>
    flags.push({ level, sheet: r.sheet, rowNumber: r.rowNumber, student: r.name, code, detail });

  // A phone shared by two rows cannot be resolved without a human: the DB
  // allows only one contact per number per account.
  const byPhone = new Map<string, ParsedAdmissionRow[]>();
  for (const r of rows) {
    if (!r.phone) continue;
    const list = byPhone.get(r.phone) ?? [];
    list.push(r);
    byPhone.set(r.phone, list);
  }
  const duplicated = new Set<string>();
  for (const [phone, list] of byPhone) {
    if (list.length > 1) duplicated.add(phone);
  }

  const importable: ReconciledRow[] = [];

  for (const r of rows) {
    if (r.phone && duplicated.has(r.phone)) {
      const others = byPhone
        .get(r.phone)!
        .filter((o) => o !== r)
        .map((o) => `${o.name} (${o.sheet} row ${o.rowNumber})`)
        .join(', ');
      heldBack.push({ row: r, reason: `phone shared with ${others}` });
      flag(r, 'blocker', 'duplicate-phone', `${r.phoneRaw} also on: ${others}`);
      continue;
    }

    if (r.phoneIssue === 'not-indian-mobile') {
      flag(r, 'review', 'bad-phone', `"${r.phoneRaw}" is not a valid Indian mobile; imported without a number`);
    } else if (r.phoneIssue === 'blank') {
      flag(r, 'review', 'no-phone', 'no contact number in the sheet');
    }

    // A course is unusable if it names no programme OR names one that cannot
    // identify a single fee row (a bare "MA" — every MA fee row has a subject).
    // Keying on `reason` catches both; keying on `program` alone missed the
    // second kind and let those rows import unflagged.
    if (r.course.reason && r.course.reason !== 'blank') {
      flag(r, 'review', 'course-unresolved', r.course.reason);
    } else if (!r.course.program) {
      flag(r, 'review', 'course-unresolved', `course "${r.rawCourse}" is blank`);
    }
    for (const m of r.unparseableMoney) {
      flag(r, 'review', 'money-unreadable', m);
    }
    if (r.feePaidAmbiguous) {
      flag(r, 'review', 'fee-ambiguous', 'FEE PAID uses commas; could be thousands or separate instalments');
    }

    const agreedTotal = r.totalFee;
    const discountAmount = r.discount ?? 0;
    const openingPaid = r.feePaid;

    if (agreedTotal === null) {
      flag(r, 'review', 'no-total-fee', 'TOTAL FEE is blank; no fee plan will be created');
    }

    // The office states a due figure too; when total/paid/discount/due
    // disagree we keep the sheet's numbers and surface the discrepancy.
    let feeReconciles = true;
    let outstanding: number | null = null;
    if (agreedTotal !== null) {
      outstanding = agreedTotal - discountAmount - openingPaid;
      const stated = r.feeDue;
      if (stated !== null && Math.abs(stated - outstanding) > FEE_TOLERANCE) {
        feeReconciles = false;
        flag(
          r,
          'review',
          'fee-mismatch',
          `total ${agreedTotal} - discount ${discountAmount} - paid ${openingPaid} = ${outstanding}, but sheet says due ${stated}`,
        );
      }
      if (outstanding < -FEE_TOLERANCE) {
        feeReconciles = false;
        flag(r, 'review', 'overpaid', `paid+discount exceeds total by ${Math.abs(outstanding)}`);
      }
    }

    importable.push({
      ...r,
      importPhone: r.phone ?? '',
      agreedTotal,
      discountAmount,
      openingPaid,
      outstanding,
      stage: r.universityRollNumber ? 'Enrolled' : 'Application Started',
      feeReconciles,
    });
  }

  return {
    importable,
    heldBack,
    flags,
    stats: {
      parsed: rows.length,
      importable: importable.length,
      heldBack: heldBack.length,
      enrolled: importable.filter((r) => r.stage === 'Enrolled').length,
      applicationStarted: importable.filter((r) => r.stage === 'Application Started').length,
      feeMismatches: importable.filter((r) => !r.feeReconciles).length,
      noPhone: importable.filter((r) => !r.importPhone).length,
      badPhone: importable.filter((r) => r.phoneIssue === 'not-indian-mobile').length,
      /** Cannot be tied to a fee row — no programme, or a programme with no subject. */
      unresolvedCourse: importable.filter((r) => !r.course.program || r.course.reason).length,
      withPassword: importable.filter((r) => r.portalPassword).length,
      withPayment: importable.filter((r) => r.openingPaid > 0).length,
      withDiscount: importable.filter((r) => r.discountAmount > 0).length,
    },
  };
}
