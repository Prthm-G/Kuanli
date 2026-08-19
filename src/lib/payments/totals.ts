/**
 * Money arithmetic for the payment ledger.
 *
 * Kept out of components and unit-tested for the same reason `lib/queue/score.ts`
 * is: a wrong number here does not look wrong. A miscount in the queue costs a
 * lead its place in a list; a miscount here tells a counsellor a student is
 * paid up when they are not.
 *
 * The one rule everything else follows from: **only verified money counts as
 * received.** A reported payment is a claim a counsellor typed in, not money
 * confirmed in the account, and folding claims into the received figure is how
 * a ledger starts lying.
 */

import type { FeeInstallment, LedgerRow, Payment } from './types';

/** Sum with a fixed 2dp rounding, so repeated addition cannot drift. */
export function sum(values: number[]): number {
  return round(values.reduce((a, b) => a + (Number(b) || 0), 0));
}

/** Round to paise. Currency is stored NUMERIC(12,2); JS floats are not. */
export function round(v: number): number {
  return Math.round((Number(v) || 0) * 100) / 100;
}

export interface PaymentTotals {
  /** Verified only. */
  received: number;
  /** Reported, awaiting a decision. */
  pending: number;
  /** Rejected. Shown so a disputed payment does not simply vanish. */
  rejected: number;
  outstanding: number;
}

export function totalsFor(
  agreedTotal: number,
  payments: Payment[]
): PaymentTotals {
  const byStatus = (s: Payment['status']) =>
    sum(payments.filter((p) => p.status === s).map((p) => p.amount));

  const received = byStatus('verified');
  return {
    received,
    pending: byStatus('reported'),
    rejected: byStatus('rejected'),
    // Never negative: an overpayment is a credit, not a negative debt, and a
    // minus sign in an "outstanding" column reads as a data bug to whoever
    // sees it. `overpayment()` reports the excess separately.
    outstanding: Math.max(0, round((Number(agreedTotal) || 0) - received)),
  };
}

/** How much verified money exceeds the agreed total, if any. */
export function overpayment(agreedTotal: number, received: number): number {
  return Math.max(0, round(received - (Number(agreedTotal) || 0)));
}

/**
 * Account-wide roll-up for the ledger header. Sums the RPC's per-student rows
 * rather than recomputing from payments, so the page and the database cannot
 * disagree about the same number.
 */
export function ledgerTotals(rows: LedgerRow[]): {
  agreed: number;
  received: number;
  reported: number;
  outstanding: number;
  students: number;
} {
  return {
    agreed: sum(rows.map((r) => r.agreedTotal)),
    received: sum(rows.map((r) => r.received)),
    reported: sum(rows.map((r) => r.reported)),
    outstanding: sum(rows.map((r) => r.outstanding)),
    students: rows.length,
  };
}

/**
 * Whether an installment is settled: covered by a verified payment against it.
 * Matches the `payment_ledger` RPC's next-due rule exactly, so the row's
 * highlight and the RPC's "next due" never contradict each other.
 */
export function isSettled(
  installment: FeeInstallment,
  payments: Payment[]
): boolean {
  return payments.some(
    (p) => p.installmentId === installment.id && p.status === 'verified'
  );
}

/**
 * The installment a counsellor should collect next: the earliest unsettled
 * one. Undated installments sort last, matching the RPC's NULLS LAST.
 */
export function nextUnsettled(
  installments: FeeInstallment[],
  payments: Payment[]
): FeeInstallment | null {
  const open = installments.filter((i) => !isSettled(i, payments));
  if (open.length === 0) return null;
  return [...open].sort((a, b) => {
    if (a.dueDate && b.dueDate) {
      // Fall through to position on an equal date rather than returning the
      // comparison directly. Several installments legitimately share a due
      // date — the application fee and semester 1 are both due on day one —
      // and position is what separates them. Returning 0 here would leave the
      // order down to however the rows happened to arrive, which is how this
      // disagreed with the RPC's `ORDER BY due_date NULLS LAST, position`.
      const byDate = a.dueDate.localeCompare(b.dueDate);
      if (byDate !== 0) return byDate;
    } else if (a.dueDate) return -1;
    else if (b.dueDate) return 1;
    return a.position - b.position;
  })[0];
}

/** Installments past their due date with no verified payment against them. */
export function overdueInstallments(
  installments: FeeInstallment[],
  payments: Payment[],
  now: Date = new Date()
): FeeInstallment[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return installments.filter(
    (i) =>
      i.dueDate != null &&
      new Date(i.dueDate) < today &&
      !isSettled(i, payments)
  );
}
