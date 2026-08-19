'use client';

import { useMemo, useState } from 'react';

import { formatCurrency } from '@/lib/currency';
import { ledgerTotals } from '@/lib/payments/totals';
import { OPTION_LABEL, type LedgerRow } from '@/lib/payments/types';

type Segment = 'all' | 'outstanding' | 'awaiting' | 'settled';

function inSegment(r: LedgerRow, s: Segment): boolean {
  if (s === 'all') return true;
  if (s === 'outstanding') return r.outstanding > 0;
  if (s === 'awaiting') return r.reported > 0;
  return r.outstanding === 0 && r.agreedTotal > 0;
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

interface LedgerTableProps {
  rows: LedgerRow[];
  loading: boolean;
  error: string | null;
  onOpenStudent: (contactId: string) => void;
}

/**
 * Account-wide money view. The columns answer, in order: what did they agree
 * to, what has actually landed, what is claimed but unchecked, and what is
 * still owed. "Awaiting check" is a separate column rather than folded into
 * received, because a counsellor's claim is not the same as money in the bank.
 */
export function LedgerTable({
  rows,
  loading,
  error,
  onOpenStudent,
}: LedgerTableProps) {
  const [segment, setSegment] = useState<Segment>('all');

  const totals = useMemo(() => ledgerTotals(rows), [rows]);
  const visible = useMemo(
    () => rows.filter((r) => inSegment(r, segment)),
    [rows, segment]
  );

  // The ledger is per-account and one currency in practice; take the first
  // row's rather than assuming, and fall back to the account default.
  const currency = rows[0]?.currency ?? 'INR';

  const segments: { key: Segment; label: string }[] = [
    { key: 'all', label: `All (${rows.length})` },
    {
      key: 'outstanding',
      label: `Outstanding (${rows.filter((r) => inSegment(r, 'outstanding')).length})`,
    },
    {
      key: 'awaiting',
      label: `Awaiting check (${rows.filter((r) => inSegment(r, 'awaiting')).length})`,
    },
    {
      key: 'settled',
      label: `Settled (${rows.filter((r) => inSegment(r, 'settled')).length})`,
    },
  ];

  if (loading)
    return <p className="text-muted-foreground p-6 text-center">Loading…</p>;
  if (error) return <p className="p-6 text-center text-red-400">{error}</p>;
  if (rows.length === 0)
    return (
      <p className="text-muted-foreground p-6 text-center">
        No fee plans or payments yet. Open a student and apply a fee plan to
        start their ledger.
      </p>
    );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Agreed" value={formatCurrency(totals.agreed, currency)} />
        <Stat
          label="Received"
          value={formatCurrency(totals.received, currency)}
        />
        <Stat
          label="Awaiting check"
          value={formatCurrency(totals.reported, currency)}
          tone={totals.reported > 0 ? 'amber' : undefined}
        />
        <Stat
          label="Outstanding"
          value={formatCurrency(totals.outstanding, currency)}
        />
        {/* Settled money in minus settled money out, from the route hops. What
            is sitting with us right now: float plus retained commission. */}
        <Stat label="In hand" value={formatCurrency(totals.inHand, currency)} />
      </div>

      <div className="border-border bg-muted/40 flex gap-1 rounded-lg border p-1">
        {segments.map((t) => (
          <button
            key={t.key}
            onClick={() => setSegment(t.key)}
            className={
              'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ' +
              (segment === t.key
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-left text-xs tracking-wider uppercase">
            <tr>
              <Th>Student</Th>
              <Th>Programme</Th>
              <Th className="text-right">Agreed</Th>
              <Th className="text-right">Received</Th>
              <Th className="text-right">Awaiting</Th>
              <Th className="text-right">Outstanding</Th>
              <Th>Next due</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {visible.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="text-muted-foreground p-6 text-center"
                >
                  Nothing in this segment.
                </td>
              </tr>
            )}
            {visible.map((r) => (
              <tr key={r.contactId} className="hover:bg-muted/30">
                <Td>
                  <div className="text-foreground">
                    {r.name || r.phone || 'Unnamed'}
                  </div>
                  {r.rollNumber && (
                    <div className="text-muted-foreground font-mono text-xs">
                      {r.rollNumber}
                    </div>
                  )}
                </Td>
                <Td>
                  <div className="text-foreground">
                    {[r.university, r.program].filter(Boolean).join(' · ') ||
                      '—'}
                  </div>
                  {r.paymentOption && (
                    <div className="text-muted-foreground text-xs">
                      {OPTION_LABEL[r.paymentOption]}
                    </div>
                  )}
                </Td>
                <Td className="text-right">
                  {formatCurrency(r.agreedTotal, r.currency)}
                </Td>
                <Td className="text-right">
                  {formatCurrency(r.received, r.currency)}
                </Td>
                <Td className="text-right">
                  {r.reported > 0 ? (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-500">
                      {formatCurrency(r.reported, r.currency)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Td>
                <Td className="text-right">
                  <span
                    className={
                      r.outstanding > 0 ? 'text-foreground' : 'text-emerald-500'
                    }
                  >
                    {formatCurrency(r.outstanding, r.currency)}
                  </span>
                </Td>
                <Td>
                  {r.nextDueLabel ? (
                    <>
                      <div className="text-foreground">{r.nextDueLabel}</div>
                      <div className="text-muted-foreground text-xs">
                        {formatDate(r.nextDueDate)}
                        {r.nextDueAmount != null &&
                          ` · ${formatCurrency(r.nextDueAmount, r.currency)}`}
                      </div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Td>
                <Td>
                  <button
                    onClick={() => onOpenStudent(r.contactId)}
                    className="border-border text-foreground hover:bg-muted/50 inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium"
                  >
                    Open
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'amber';
}) {
  return (
    <div className="border-border bg-card rounded-lg border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div
        className={
          'text-lg font-semibold ' +
          (tone === 'amber' ? 'text-amber-500' : 'text-foreground')
        }
      >
        {value}
      </div>
    </div>
  );
}

function Th({
  children,
  className = '',
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <th className={`px-3 py-2 font-medium ${className}`}>{children}</th>;
}

function Td({
  children,
  className = '',
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 align-top ${className}`}>{children}</td>;
}
