import { describe, it, expect } from 'vitest';

import {
  isSettled,
  ledgerTotals,
  nextUnsettled,
  overdueInstallments,
  overpayment,
  round,
  sum,
  totalsFor,
} from './totals';
import type { FeeInstallment, LedgerRow, Payment } from './types';

function pay(over: Partial<Payment> = {}): Payment {
  return {
    id: 'p1',
    contactId: 'c1',
    planId: 'pl1',
    installmentId: null,
    paidAt: '2026-08-19T09:00:00.000Z',
    amount: 15000,
    currency: 'INR',
    method: 'upi',
    reference: null,
    note: null,
    status: 'verified',
    loggedBy: 'u1',
    loggedByName: 'Simran',
    verifiedBy: 'u0',
    verifiedByName: 'Pratham',
    verifiedAt: '2026-08-20T09:00:00.000Z',
    decisionNote: null,
    receipts: [],
    ...over,
  };
}

function inst(over: Partial<FeeInstallment> = {}): FeeInstallment {
  return {
    id: 'i1',
    planId: 'pl1',
    head: 'semester',
    termIndex: 1,
    label: 'Semester 1',
    amount: 15000,
    dueDate: '2026-08-19',
    position: 10,
    ...over,
  };
}

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    contactId: 'c1',
    name: 'Rahul',
    phone: null,
    rollNumber: null,
    university: 'LPU',
    program: 'MBA',
    paymentOption: 'per_semester',
    currency: 'INR',
    planId: 'pl1',
    agreedTotal: 66600,
    received: 15000,
    reported: 0,
    outstanding: 51600,
    nextDueLabel: 'Application fee',
    nextDueDate: '2026-08-19',
    nextDueAmount: 600,
    lastPaymentAt: null,
    ...over,
  };
}

describe('round and sum', () => {
  it('rounds to paise rather than trusting float addition', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point.
    expect(sum([0.1, 0.2])).toBe(0.3);
    expect(round(1234.567)).toBe(1234.57);
  });

  it('treats junk as zero rather than producing NaN', () => {
    expect(sum([1000, NaN, 500])).toBe(1500);
    expect(round(undefined as unknown as number)).toBe(0);
  });
});

describe('totalsFor', () => {
  it('counts only verified money as received', () => {
    const t = totalsFor(66600, [
      pay({ id: 'a', amount: 15000, status: 'verified' }),
      pay({ id: 'b', amount: 20000, status: 'reported' }),
      pay({ id: 'c', amount: 5000, status: 'rejected' }),
    ]);
    expect(t.received).toBe(15000);
    expect(t.pending).toBe(20000);
    expect(t.rejected).toBe(5000);
    // Outstanding ignores the pending claim: it is not money yet.
    expect(t.outstanding).toBe(51600);
  });

  it('never reports a negative outstanding', () => {
    const t = totalsFor(10000, [pay({ amount: 12000 })]);
    expect(t.outstanding).toBe(0);
    expect(overpayment(10000, t.received)).toBe(2000);
  });

  it('is zero across the board with no payments', () => {
    const t = totalsFor(50000, []);
    expect(t).toEqual({
      received: 0,
      pending: 0,
      rejected: 0,
      outstanding: 50000,
    });
  });
});

describe('ledgerTotals', () => {
  it('rolls the per-student rows up without recomputing them', () => {
    const t = ledgerTotals([
      row({
        agreedTotal: 66600,
        received: 15000,
        reported: 0,
        outstanding: 51600,
      }),
      row({
        contactId: 'c2',
        agreedTotal: 40000,
        received: 40000,
        reported: 0,
        outstanding: 0,
      }),
    ]);
    expect(t).toEqual({
      agreed: 106600,
      received: 55000,
      reported: 0,
      outstanding: 51600,
      students: 2,
    });
  });
});

describe('isSettled', () => {
  it('needs a verified payment against that specific installment', () => {
    const i = inst({ id: 'sem1' });
    expect(
      isSettled(i, [pay({ installmentId: 'sem1', status: 'verified' })])
    ).toBe(true);
    // Right installment, still only reported.
    expect(
      isSettled(i, [pay({ installmentId: 'sem1', status: 'reported' })])
    ).toBe(false);
    // Verified, but against a different line item.
    expect(
      isSettled(i, [pay({ installmentId: 'sem2', status: 'verified' })])
    ).toBe(false);
    // Verified with no line item at all: money on the ledger, nothing settled.
    expect(
      isSettled(i, [pay({ installmentId: null, status: 'verified' })])
    ).toBe(false);
  });
});

describe('nextUnsettled', () => {
  const app = inst({
    id: 'app',
    head: 'application',
    label: 'Application fee',
    amount: 600,
    dueDate: '2026-08-19',
    position: 0,
  });
  const s1 = inst({
    id: 's1',
    label: 'Semester 1',
    dueDate: '2026-08-19',
    position: 10,
  });
  const s2 = inst({
    id: 's2',
    label: 'Semester 2',
    dueDate: '2027-02-19',
    position: 20,
  });

  it('picks the earliest open item, breaking ties by position', () => {
    expect(nextUnsettled([s1, app, s2], [])?.id).toBe('app');
  });

  it('skips settled items', () => {
    const paid = [
      pay({ id: 'x', installmentId: 'app', status: 'verified' }),
      pay({ id: 'y', installmentId: 's1', status: 'verified' }),
    ];
    expect(nextUnsettled([app, s1, s2], paid)?.id).toBe('s2');
  });

  it('sorts undated items last', () => {
    const undated = inst({ id: 'u', dueDate: null, position: 1 });
    expect(nextUnsettled([undated, s2], [])?.id).toBe('s2');
  });

  it('returns null when the plan is fully settled', () => {
    const paid = [
      pay({ id: 'x', installmentId: 'app', status: 'verified' }),
      pay({ id: 'y', installmentId: 's1', status: 'verified' }),
      pay({ id: 'z', installmentId: 's2', status: 'verified' }),
    ];
    expect(nextUnsettled([app, s1, s2], paid)).toBeNull();
  });
});

describe('overdueInstallments', () => {
  const NOW = new Date(2026, 7, 19, 17, 0, 0);

  it('counts an item due earlier today as not yet overdue', () => {
    // Due today, now 5pm. A counsellor still has the day to collect it.
    expect(
      overdueInstallments([inst({ dueDate: '2026-08-19' })], [], NOW)
    ).toEqual([]);
  });

  it('flags a past-due unsettled item', () => {
    const late = inst({ id: 'late', dueDate: '2026-07-01' });
    expect(overdueInstallments([late], [], NOW).map((i) => i.id)).toEqual([
      'late',
    ]);
  });

  it('does not flag a past-due item that was paid and verified', () => {
    const late = inst({ id: 'late', dueDate: '2026-07-01' });
    const paid = [pay({ installmentId: 'late', status: 'verified' })];
    expect(overdueInstallments([late], paid, NOW)).toEqual([]);
  });

  it('still flags one whose payment is only reported', () => {
    const late = inst({ id: 'late', dueDate: '2026-07-01' });
    const claimed = [pay({ installmentId: 'late', status: 'reported' })];
    expect(overdueInstallments([late], claimed, NOW).map((i) => i.id)).toEqual([
      'late',
    ]);
  });
});
