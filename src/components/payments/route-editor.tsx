'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, Plus } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import { loadHops, recordHop } from '@/lib/payments/queries';
import {
  ROUTE_STATE_LABEL,
  inHand,
  overRemitted,
  routeState,
} from '@/lib/payments/route';
import {
  HOP_STATUSES,
  HOP_STATUS_LABEL,
  METHOD_LABEL,
  PARTY_LABEL,
  PAYMENT_METHODS,
  ROUTE_PARTIES,
  type HopStatus,
  type PaymentHop,
  type PaymentMethod,
  type RouteParty,
} from '@/lib/payments/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const STATE_CLASS: Record<string, string> = {
  unrecorded: 'bg-muted text-muted-foreground',
  in_transit: 'bg-sky-500/15 text-sky-400',
  held: 'bg-amber-500/15 text-amber-500',
  settled: 'bg-emerald-500/15 text-emerald-500',
  failed: 'bg-red-500/15 text-red-400',
};

interface RouteEditorProps {
  paymentId: string;
  paymentAmount: number;
  currency: string;
  canEdit: boolean;
  /** Bumped by the parent to refetch after a change elsewhere. */
  refreshKey?: number;
  onChanged?: () => void;
}

/**
 * The legs of one payment: student → Skeure → university. What makes "who is
 * holding this money right now" answerable, and where the commission is
 * derived from rather than typed in.
 */
export function RouteEditor({
  paymentId,
  paymentAmount,
  currency,
  canEdit,
  refreshKey = 0,
  onChanged,
}: RouteEditorProps) {
  const { accountId, user } = useAuth();
  const [hops, setHops] = useState<PaymentHop[]>([]);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);

  const [fromParty, setFromParty] = useState<RouteParty>('student');
  const [toParty, setToParty] = useState<RouteParty>('skeure');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<HopStatus>('settled');
  const [method, setMethod] = useState<PaymentMethod>('upi');
  const [reference, setReference] = useState('');

  useEffect(() => {
    if (!paymentId) return;
    let cancelled = false;

    void (async () => {
      try {
        const rows = await loadHops(createClient(), paymentId);
        if (!cancelled) setHops(rows);
      } catch {
        // The route is supplementary to the payment; a failed load leaves the
        // chip reading "not recorded" rather than erroring over the ledger.
        if (!cancelled) setHops([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [paymentId, refreshKey, reload]);

  // Opening the form pre-fills the obvious next leg: the first is the money
  // arriving, and after that it is us paying it onward.
  function openForm() {
    const next = hops.length === 0;
    setFromParty(next ? 'student' : 'skeure');
    setToParty(next ? 'skeure' : 'university');
    setAmount(
      next ? String(paymentAmount) : String(inHand(hops) || paymentAmount)
    );
    setStatus('settled');
    setMethod('upi');
    setReference('');
    setAdding(true);
  }

  async function save() {
    if (!accountId || !user?.id) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter the amount that moved');
      return;
    }
    if (fromParty === toParty) {
      toast.error('A leg has to move between two different parties');
      return;
    }
    setSaving(true);
    try {
      await recordHop(createClient(), accountId, user.id, paymentId, {
        fromParty,
        toParty,
        amount: value,
        status,
        method,
        reference,
      });
      setAdding(false);
      setReload((k) => k + 1);
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record the leg');
    } finally {
      setSaving(false);
    }
  }

  const state = routeState(hops);
  const held = inHand(hops);
  const tooMuch = overRemitted(hops, paymentAmount);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_CLASS[state]}`}
        >
          {ROUTE_STATE_LABEL[state]}
        </span>
        {held > 0 && (
          <span className="text-muted-foreground text-xs">
            {formatCurrency(held, currency)} with us
          </span>
        )}
        {tooMuch && (
          <span className="text-xs text-red-400">
            More has been remitted than came in — check the legs.
          </span>
        )}
        {canEdit && !adding && (
          <button
            onClick={openForm}
            className="border-border text-foreground hover:bg-muted/50 inline-flex items-center rounded-md border px-2 py-0.5 text-xs"
          >
            <Plus className="mr-1 h-3 w-3" />
            Add leg
          </button>
        )}
      </div>

      {hops.length > 0 && (
        <ol className="space-y-1">
          {hops.map((h) => (
            <li
              key={h.id}
              className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs"
            >
              <span className="text-foreground">
                {PARTY_LABEL[h.fromParty]}
              </span>
              <ArrowRight className="h-3 w-3" />
              <span className="text-foreground">{PARTY_LABEL[h.toParty]}</span>
              <span>· {formatCurrency(h.amount, currency)}</span>
              {h.method && <span>· {METHOD_LABEL[h.method]}</span>}
              {h.reference && <span>· {h.reference}</span>}
              <span
                className={
                  h.status === 'settled'
                    ? 'text-emerald-500'
                    : h.status === 'failed'
                      ? 'text-red-400'
                      : 'text-amber-500'
                }
              >
                · {HOP_STATUS_LABEL[h.status]}
              </span>
            </li>
          ))}
        </ol>
      )}

      {adding && (
        <div className="border-border space-y-2 rounded-lg border p-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">From</Label>
              <Select
                value={fromParty}
                onValueChange={(v) => v && setFromParty(v as RouteParty)}
              >
                <SelectTrigger className="bg-muted h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROUTE_PARTIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PARTY_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To</Label>
              <Select
                value={toParty}
                onValueChange={(v) => v && setToParty(v as RouteParty)}
              >
                <SelectTrigger className="bg-muted h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROUTE_PARTIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PARTY_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Amount</Label>
              <Input
                type="number"
                min="1"
                step="0.01"
                className="h-8 text-xs"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Method</Label>
              <Select
                value={method}
                onValueChange={(v) => v && setMethod(v as PaymentMethod)}
              >
                <SelectTrigger className="bg-muted h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {METHOD_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Status</Label>
              <Select
                value={status}
                onValueChange={(v) => v && setStatus(v as HopStatus)}
              >
                <SelectTrigger className="bg-muted h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOP_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {HOP_STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Reference</Label>
            <Input
              className="h-8 text-xs"
              value={reference}
              placeholder="UTR / UPI ref"
              onChange={(e) => setReference(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAdding(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Add leg'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
