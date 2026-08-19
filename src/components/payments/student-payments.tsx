'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, FileText, Plus, X } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import {
  applyFeeTemplate,
  decideDiscount,
  decidePayment,
  loadDiscounts,
  loadFeeTemplates,
  loadStudentAccount,
  proposeDiscount,
  receiptUrl,
} from '@/lib/payments/queries';
import {
  isSettled,
  nextUnsettled,
  overdueInstallments,
  overpayment,
  totalsFor,
} from '@/lib/payments/totals';
import {
  DISCOUNT_STATUS_LABEL,
  HEAD_LABEL,
  METHOD_LABEL,
  OPTION_LABEL,
  STATUS_LABEL,
  TERM_NOUN,
  type FeeDiscount,
  type FeeInstallment,
  type FeePlan,
  type FeeTemplate,
  type Payment,
} from '@/lib/payments/types';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { PaymentDialog } from './payment-dialog';
import { RouteEditor } from './route-editor';

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function describeTemplate(t: FeeTemplate): string {
  const total = t.totalFee ?? null;
  const per = t.programmeFee ?? null;
  const bits = [
    [t.university, t.mode, t.program, t.specialization]
      .filter(Boolean)
      .join(' · '),
    OPTION_LABEL[t.paymentOption],
  ];
  if (per != null && t.termCount) {
    bits.push(
      `${formatCurrency(per, t.currency)} × ${t.termCount} ${TERM_NOUN[t.paymentOption]}${
        t.termCount === 1 ? '' : 's'
      }`
    );
  }
  if (total != null) bits.push(`total ${formatCurrency(total, t.currency)}`);
  if (t.variant) bits.push(t.variant);
  return bits.filter(Boolean).join(' · ');
}

interface StudentPaymentsProps {
  contactId: string;
  contactName?: string | null;
  /** Bumped by the parent to force a refetch. */
  refreshKey?: number;
  onChanged?: () => void;
}

/**
 * One student's money: the agreed plan, the installment schedule, and every
 * payment against it. This is where a counsellor records money and where an
 * admin verifies it.
 */
export function StudentPayments({
  contactId,
  contactName,
  refreshKey = 0,
  onChanged,
}: StudentPaymentsProps) {
  const { accountId, accountRole, defaultCurrency, user } = useAuth();
  const [plan, setPlan] = useState<FeePlan | null>(null);
  const [installments, setInstallments] = useState<FeeInstallment[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [discounts, setDiscounts] = useState<FeeDiscount[]>([]);
  const [discountAmount, setDiscountAmount] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [proposing, setProposing] = useState(false);
  const [templates, setTemplates] = useState<FeeTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [reload, setReload] = useState(0);

  const canRecord = accountRole !== null && accountRole !== 'viewer';
  const canVerify = accountRole === 'owner' || accountRole === 'admin';

  useEffect(() => {
    if (!accountId || !contactId) return;
    let cancelled = false;

    void (async () => {
      try {
        const supabase = createClient();
        const [acctData, tpls, discs] = await Promise.all([
          loadStudentAccount(supabase, contactId),
          loadFeeTemplates(supabase, accountId),
          loadDiscounts(supabase, contactId),
        ]);
        if (cancelled) return;
        setPlan(acctData.plan);
        setInstallments(acctData.installments);
        setPayments(acctData.payments);
        setTemplates(tpls);
        setDiscounts(discs);
        setError(null);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Could not load payments');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, contactId, refreshKey, reload]);

  const refresh = useCallback(() => {
    setReload((k) => k + 1);
    onChanged?.();
  }, [onChanged]);

  const currency = plan?.currency ?? defaultCurrency;
  const totals = useMemo(
    () => totalsFor(plan?.agreedTotal ?? 0, payments),
    [plan?.agreedTotal, payments]
  );
  // Everything not rejected counts, so a pending discount already reduces the
  // balance. That is the operator's immediate-effect decision, and it has to
  // match the payment_ledger RPC exactly or the drawer and the table disagree.
  const liveDiscounts = useMemo(
    () =>
      discounts
        .filter((d) => d.status !== 'rejected')
        .reduce((a, d) => a + d.amount, 0),
    [discounts]
  );
  const pendingDiscounts = useMemo(
    () =>
      discounts
        .filter((d) => d.status === 'pending')
        .reduce((a, d) => a + d.amount, 0),
    [discounts]
  );
  const outstanding = Math.max(
    0,
    (plan?.agreedTotal ?? 0) - totals.received - liveDiscounts
  );
  const extra = overpayment(
    (plan?.agreedTotal ?? 0) - liveDiscounts,
    totals.received
  );
  const next = useMemo(
    () => nextUnsettled(installments, payments),
    [installments, payments]
  );
  const overdue = useMemo(
    () => new Set(overdueInstallments(installments, payments).map((i) => i.id)),
    [installments, payments]
  );

  async function applyTemplate() {
    if (!templateId) return;
    setBusy('template');
    try {
      await applyFeeTemplate(createClient(), contactId, templateId);
      toast.success('Fee plan applied');
      setTemplateId('');
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not apply the plan');
    } finally {
      setBusy(null);
    }
  }

  async function decide(p: Payment, status: 'verified' | 'rejected') {
    setBusy(p.id);
    try {
      await decidePayment(createClient(), p.id, status);
      toast.success(
        status === 'verified' ? 'Payment verified' : 'Payment rejected'
      );
      refresh();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : 'Could not update the payment'
      );
    } finally {
      setBusy(null);
    }
  }

  async function submitDiscount() {
    if (!accountId || !user?.id) return;
    const value = Number(discountAmount);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter the discount amount');
      return;
    }
    if (!discountReason.trim()) {
      toast.error('Say why — the reason is what an admin decides on');
      return;
    }
    setBusy('discount');
    try {
      await proposeDiscount(createClient(), accountId, user.id, {
        contactId,
        planId: plan?.id ?? null,
        amount: value,
        reason: discountReason,
      });
      toast.success('Discount applied, pending approval');
      setDiscountAmount('');
      setDiscountReason('');
      setProposing(false);
      refresh();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : 'Could not add the discount'
      );
    } finally {
      setBusy(null);
    }
  }

  async function onDiscountDecision(
    d: FeeDiscount,
    status: 'approved' | 'rejected'
  ) {
    setBusy(d.id);
    try {
      await decideDiscount(createClient(), d.id, status);
      toast.success(
        status === 'approved'
          ? 'Discount approved'
          : 'Rejected — the balance has gone back up and a follow-up was logged'
      );
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not decide');
    } finally {
      setBusy(null);
    }
  }

  async function openReceipt(path: string) {
    const url = await receiptUrl(createClient(), path);
    if (url) window.open(url, '_blank', 'noopener');
    else toast.error('Could not open that receipt');
  }

  if (loading)
    return <p className="text-muted-foreground p-4 text-sm">Loading…</p>;
  if (error) return <p className="p-4 text-sm text-red-400">{error}</p>;

  return (
    <div className="space-y-4">
      {!plan && (
        <div className="border-border space-y-2 rounded-lg border border-dashed p-4">
          <p className="text-muted-foreground text-sm">
            No fee plan yet. Applying one snapshots today&apos;s prices onto
            this student, so a later change to the template will not move what
            they owe.
          </p>
          {canRecord && templates.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Select
                value={templateId}
                onValueChange={(v) => setTemplateId(v ?? '')}
              >
                <SelectTrigger className="bg-muted min-w-[18rem] flex-1">
                  <SelectValue placeholder="Choose a fee plan…" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {describeTemplate(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                onClick={() => void applyTemplate()}
                disabled={!templateId || busy === 'template'}
              >
                Apply
              </Button>
            </div>
          )}
          {templates.length === 0 && (
            <p className="text-muted-foreground text-xs">
              No fee templates exist yet. An admin adds them under Settings →
              Fees.
            </p>
          )}
        </div>
      )}

      {plan && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Agreed"
              value={formatCurrency(plan.agreedTotal, currency)}
            />
            <Stat
              label="Received"
              value={formatCurrency(totals.received, currency)}
            />
            <Stat
              label="Awaiting check"
              value={formatCurrency(totals.pending, currency)}
              tone={totals.pending > 0 ? 'amber' : undefined}
            />
            <Stat
              label="Outstanding"
              value={formatCurrency(outstanding, currency)}
            />
          </div>

          {liveDiscounts > 0 && (
            <p className="text-muted-foreground text-xs">
              {formatCurrency(liveDiscounts, currency)} discounted
              {pendingDiscounts > 0 && (
                <span className="text-amber-500">
                  {' '}
                  · {formatCurrency(pendingDiscounts, currency)} of that is
                  awaiting approval and may be reversed
                </span>
              )}
            </p>
          )}

          {extra > 0 && (
            <p className="text-xs text-emerald-500">
              Overpaid by {formatCurrency(extra, currency)}.
            </p>
          )}

          <div className="text-muted-foreground text-xs">
            {[plan.university, plan.program, plan.specialization]
              .filter(Boolean)
              .join(' · ')}
            {plan.paymentOption && ` · ${OPTION_LABEL[plan.paymentOption]}`}
            {next && ` · next: ${next.label}, ${formatDate(next.dueDate)}`}
          </div>

          <section>
            <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase">
              Schedule
            </h3>
            <div className="border-border divide-border divide-y rounded-lg border">
              {installments.map((i) => {
                const settled = isSettled(i, payments);
                return (
                  <div
                    key={i.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <span className="text-foreground">{i.label}</span>
                      <span className="text-muted-foreground ml-2 text-xs">
                        {HEAD_LABEL[i.head]} · {formatDate(i.dueDate)}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-foreground">
                        {formatCurrency(i.amount, currency)}
                      </span>
                      {settled ? (
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-500">
                          Paid
                        </span>
                      ) : overdue.has(i.id) ? (
                        <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-400">
                          Overdue
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          Due
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            Payments
          </h3>
          {canRecord && (
            <Button size="sm" onClick={() => setRecording(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Record payment
            </Button>
          )}
        </div>

        {payments.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing received yet.</p>
        ) : (
          <div className="border-border divide-border divide-y rounded-lg border">
            {payments.map((p) => (
              <div key={p.id} className="space-y-1 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-foreground font-medium">
                    {formatCurrency(p.amount, p.currency)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {METHOD_LABEL[p.method]} · {formatDate(p.paidAt)}
                  </span>
                  <span
                    className={
                      'rounded-full px-2 py-0.5 text-xs font-medium ' +
                      (p.status === 'verified'
                        ? 'bg-emerald-500/15 text-emerald-500'
                        : p.status === 'rejected'
                          ? 'bg-red-500/15 text-red-400'
                          : 'bg-amber-500/15 text-amber-500')
                    }
                  >
                    {STATUS_LABEL[p.status]}
                  </span>
                  {p.loggedByName && (
                    <span className="text-muted-foreground text-xs">
                      by {p.loggedByName}
                    </span>
                  )}
                </div>
                {(p.reference || p.note) && (
                  <p className="text-muted-foreground text-xs">
                    {[p.reference, p.note].filter(Boolean).join(' · ')}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {p.receipts.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => void openReceipt(r.storagePath)}
                      className="border-border text-foreground hover:bg-muted/50 inline-flex items-center rounded-md border px-2 py-0.5 text-xs"
                    >
                      <FileText className="mr-1 h-3 w-3" />
                      Receipt
                    </button>
                  ))}
                  {canVerify && p.status === 'reported' && (
                    <>
                      <button
                        onClick={() => void decide(p, 'verified')}
                        disabled={busy === p.id}
                        className="inline-flex items-center rounded-md border border-emerald-500/40 px-2 py-0.5 text-xs font-medium text-emerald-500 hover:bg-emerald-500/10"
                      >
                        <Check className="mr-1 h-3 w-3" />
                        Verify
                      </button>
                      <button
                        onClick={() => void decide(p, 'rejected')}
                        disabled={busy === p.id}
                        className="inline-flex items-center rounded-md border border-red-500/40 px-2 py-0.5 text-xs font-medium text-red-400 hover:bg-red-500/10"
                      >
                        <X className="mr-1 h-3 w-3" />
                        Reject
                      </button>
                    </>
                  )}
                </div>
                {/* Where this money actually went. Only meaningful once it is
                    real money, so hidden for a rejected payment. */}
                {p.status !== 'rejected' && (
                  <RouteEditor
                    paymentId={p.id}
                    paymentAmount={p.amount}
                    currency={p.currency}
                    canEdit={canRecord}
                    refreshKey={reload}
                    onChanged={refresh}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            Discounts
          </h3>
          {canRecord && plan && !proposing && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setProposing(true)}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add discount
            </Button>
          )}
        </div>

        {proposing && (
          <div className="border-border mb-2 space-y-2 rounded-lg border p-3">
            <p className="text-muted-foreground text-xs">
              This reduces the balance straight away. An admin reviews it after,
              and if it is rejected the balance goes back up — so agree it
              before quoting a lower number.
            </p>
            <div className="grid grid-cols-3 gap-2">
              <Input
                type="number"
                min="1"
                step="0.01"
                placeholder="Amount"
                value={discountAmount}
                onChange={(e) => setDiscountAmount(e.target.value)}
              />
              <div className="col-span-2">
                <Input
                  placeholder="Why (an admin decides on this)"
                  value={discountReason}
                  onChange={(e) => setDiscountReason(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setProposing(false)}
                disabled={busy === 'discount'}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void submitDiscount()}
                disabled={busy === 'discount'}
              >
                Apply discount
              </Button>
            </div>
          </div>
        )}

        {discounts.length === 0 ? (
          <p className="text-muted-foreground text-sm">None.</p>
        ) : (
          <div className="border-border divide-border divide-y rounded-lg border">
            {discounts.map((d) => (
              <div key={d.id} className="space-y-1 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-foreground font-medium">
                    {formatCurrency(d.amount, currency)}
                  </span>
                  <span
                    className={
                      'rounded-full px-2 py-0.5 text-xs font-medium ' +
                      (d.status === 'approved'
                        ? 'bg-emerald-500/15 text-emerald-500'
                        : d.status === 'rejected'
                          ? 'bg-red-500/15 text-red-400'
                          : 'bg-amber-500/15 text-amber-500')
                    }
                  >
                    {DISCOUNT_STATUS_LABEL[d.status]}
                  </span>
                  {d.proposedByName && (
                    <span className="text-muted-foreground text-xs">
                      by {d.proposedByName}
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground text-xs">{d.reason}</p>
                {d.decisionNote && (
                  <p className="text-muted-foreground text-xs">
                    Decision: {d.decisionNote}
                  </p>
                )}
                {canVerify && d.status === 'pending' && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => void onDiscountDecision(d, 'approved')}
                      disabled={busy === d.id}
                      className="inline-flex items-center rounded-md border border-emerald-500/40 px-2 py-0.5 text-xs font-medium text-emerald-500 hover:bg-emerald-500/10"
                    >
                      <Check className="mr-1 h-3 w-3" />
                      Approve
                    </button>
                    <button
                      onClick={() => void onDiscountDecision(d, 'rejected')}
                      disabled={busy === d.id}
                      className="inline-flex items-center rounded-md border border-red-500/40 px-2 py-0.5 text-xs font-medium text-red-400 hover:bg-red-500/10"
                    >
                      <X className="mr-1 h-3 w-3" />
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <PaymentDialog
        open={recording}
        onOpenChange={setRecording}
        contactId={contactId}
        contactName={contactName}
        plan={plan}
        installments={installments}
        currency={currency}
        onRecorded={refresh}
      />
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
    <div className="border-border bg-card rounded-lg border p-2.5">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div
        className={
          'text-base font-semibold ' +
          (tone === 'amber' ? 'text-amber-500' : 'text-foreground')
        }
      >
        {value}
      </div>
    </div>
  );
}
