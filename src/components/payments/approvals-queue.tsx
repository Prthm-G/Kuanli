'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, ShieldCheck, X } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import {
  decideDiscount,
  decidePayment,
  loadPendingDiscounts,
  loadPendingPayments,
} from '@/lib/payments/queries';
import {
  METHOD_LABEL,
  type FeeDiscount,
  type Payment,
} from '@/lib/payments/types';

type PendingPayment = Payment & { contactName: string | null };
type PendingDiscount = FeeDiscount & { contactName: string | null };

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

interface ApprovalsQueueProps {
  /** Bumped by the parent to refetch. */
  refreshKey?: number;
  onDecided: () => void;
}

/**
 * The owner/admin desk: money counsellors say arrived, and discounts they have
 * already applied.
 *
 * The discounts half is the one that needs watching. Per the operator's
 * decision they take effect on the outstanding balance immediately, so this
 * queue is reviewing something already in force — rejecting one puts the
 * balance back up, and that is said plainly on each row rather than left for
 * someone to discover.
 */
export function ApprovalsQueue({
  refreshKey = 0,
  onDecided,
}: ApprovalsQueueProps) {
  const { accountId, accountRole, defaultCurrency } = useAuth();
  const [payments, setPayments] = useState<PendingPayment[]>([]);
  const [discounts, setDiscounts] = useState<PendingDiscount[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const canDecide = accountRole === 'owner' || accountRole === 'admin';

  useEffect(() => {
    if (!accountId || !canDecide) return;
    let cancelled = false;

    void (async () => {
      try {
        const supabase = createClient();
        const [p, d] = await Promise.all([
          loadPendingPayments(supabase, accountId),
          loadPendingDiscounts(supabase, accountId),
        ]);
        if (cancelled) return;
        setPayments(p);
        setDiscounts(d);
      } catch {
        // The queue is a convenience over the per-student view; a failed load
        // hides it rather than blocking the ledger behind it.
        if (!cancelled) {
          setPayments([]);
          setDiscounts([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, canDecide, refreshKey, reload]);

  function refresh() {
    setReload((k) => k + 1);
    onDecided();
  }

  async function onPayment(p: PendingPayment, status: 'verified' | 'rejected') {
    setBusy(p.id);
    try {
      await decidePayment(createClient(), p.id, status);
      toast.success(
        status === 'verified' ? 'Payment verified' : 'Payment rejected'
      );
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not decide');
    } finally {
      setBusy(null);
    }
  }

  async function onDiscount(
    d: PendingDiscount,
    status: 'approved' | 'rejected'
  ) {
    setBusy(d.id);
    try {
      await decideDiscount(createClient(), d.id, status);
      toast.success(
        status === 'approved'
          ? 'Discount approved'
          : 'Discount rejected — the balance has gone back up and a follow-up was logged'
      );
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not decide');
    } finally {
      setBusy(null);
    }
  }

  if (!canDecide) return null;
  if (payments.length === 0 && discounts.length === 0) return null;

  return (
    <section className="border-border bg-card space-y-3 rounded-lg border p-4">
      <h2 className="text-foreground flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="h-4 w-4" />
        Needs your decision
        <span className="text-muted-foreground font-normal">
          ({payments.length + discounts.length})
        </span>
      </h2>

      {payments.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            Payments reported
          </h3>
          <div className="border-border divide-border divide-y rounded-lg border">
            {payments.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <span className="text-foreground font-medium">
                    {formatCurrency(p.amount, p.currency)}
                  </span>
                  <span className="text-muted-foreground ml-2 text-xs">
                    {p.contactName ?? 'Unnamed'} · {METHOD_LABEL[p.method]} ·{' '}
                    {formatDate(p.paidAt)}
                    {p.reference && ` · ${p.reference}`}
                    {p.loggedByName && ` · by ${p.loggedByName}`}
                    {p.receipts.length > 0 &&
                      ` · ${p.receipts.length} receipt${p.receipts.length === 1 ? '' : 's'}`}
                  </span>
                </div>
                <div className="flex shrink-0 gap-2">
                  <DecideButton
                    tone="ok"
                    label="Verify"
                    disabled={busy === p.id}
                    onClick={() => void onPayment(p, 'verified')}
                  />
                  <DecideButton
                    tone="no"
                    label="Reject"
                    disabled={busy === p.id}
                    onClick={() => void onPayment(p, 'rejected')}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {discounts.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            Discounts already applied
          </h3>
          <p className="text-muted-foreground text-xs">
            These are already reducing the student&apos;s balance. Rejecting one
            puts it back up and logs a follow-up so the counsellor can correct
            whatever was quoted.
          </p>
          <div className="border-border divide-border divide-y rounded-lg border">
            {discounts.map((d) => (
              <div
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <span className="text-foreground font-medium">
                    {formatCurrency(d.amount, defaultCurrency)}
                  </span>
                  <span className="text-muted-foreground ml-2 text-xs">
                    {d.contactName ?? 'Unnamed'} · {formatDate(d.createdAt)}
                    {d.proposedByName && ` · by ${d.proposedByName}`}
                  </span>
                  <p className="text-muted-foreground text-xs">{d.reason}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <DecideButton
                    tone="ok"
                    label="Approve"
                    disabled={busy === d.id}
                    onClick={() => void onDiscount(d, 'approved')}
                  />
                  <DecideButton
                    tone="no"
                    label="Reject"
                    disabled={busy === d.id}
                    onClick={() => void onDiscount(d, 'rejected')}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function DecideButton({
  tone,
  label,
  disabled,
  onClick,
}: {
  tone: 'ok' | 'no';
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = tone === 'ok' ? Check : X;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ' +
        (tone === 'ok'
          ? 'border-emerald-500/40 text-emerald-500 hover:bg-emerald-500/10'
          : 'border-red-500/40 text-red-400 hover:bg-red-500/10')
      }
    >
      <Icon className="mr-1 h-3 w-3" />
      {label}
    </button>
  );
}
