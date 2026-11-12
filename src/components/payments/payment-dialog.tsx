'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Paperclip } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { uploadAccountMedia } from '@/lib/storage/upload-media';
import {
  attachReceipt,
  duplicateReference,
  loadAccountMembers,
  recordPayment,
} from '@/lib/payments/queries';
import {
  HEAD_LABEL,
  METHOD_LABEL,
  PAYMENT_HEADS,
  PAYMENT_METHODS,
  RECEIVED_BY_LABEL,
  RECEIVED_BY_OPTIONS,
  type FeeHead,
  type FeeInstallment,
  type FeePlan,
  type PaymentMethod,
  type ReceivedBy,
} from '@/lib/payments/types';
import { formatCurrency } from '@/lib/currency';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** 16 MB, matching the bucket's file_size_limit in migration 056. */
const RECEIPT_MAX_BYTES = 16 * 1024 * 1024;

function toLocalInput(d: Date): string {
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

interface PaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  contactName?: string | null;
  plan: FeePlan | null;
  installments: FeeInstallment[];
  currency: string;
  onRecorded: () => void;
  /** A receipt already in hand, e.g. the image of the WhatsApp message it was logged from. */
  initialReceipt?: File | null;
}

/**
 * Record money received. It always lands as `reported` — the RLS INSERT policy
 * rejects any other status — so this dialog has no "verified" control by
 * design; an admin decides that separately.
 */
export function PaymentDialog({
  open,
  onOpenChange,
  contactId,
  contactName,
  plan,
  installments,
  currency,
  onRecorded,
  initialReceipt = null,
}: PaymentDialogProps) {
  const { accountId, accountRole, user } = useAuth();
  const canPickCollector = accountRole === 'owner' || accountRole === 'admin';

  const [paidAt, setPaidAt] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('upi');
  const [installmentId, setInstallmentId] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [head, setHead] = useState<FeeHead | ''>('');
  const [receivedBy, setReceivedBy] = useState<ReceivedBy | ''>('');
  const [collectedBy, setCollectedBy] = useState('');
  const [members, setMembers] = useState<{ userId: string; name: string }[]>(
    []
  );
  const [duplicates, setDuplicates] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPaidAt(toLocalInput(new Date()));
    setAmount('');
    setMethod('upi');
    setInstallmentId('');
    setReference('');
    setNote('');
    setReceipt(initialReceipt);
    setHead('');
    setReceivedBy('');
    setCollectedBy(user?.id ?? '');
    setDuplicates(0);
    // initialReceipt and user are read when the dialog opens, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Owner and admin can say a colleague collected the money.
  useEffect(() => {
    if (!open || !accountId || !canPickCollector) return;
    let cancelled = false;
    loadAccountMembers(createClient(), accountId)
      .then((m) => !cancelled && setMembers(m))
      .catch(() => !cancelled && setMembers([]));
    return () => {
      cancelled = true;
    };
  }, [open, accountId, canPickCollector]);

  // Warn (not block) when another live payment already carries this reference.
  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      duplicateReference(createClient(), accountId, method, reference)
        .then((n) => !cancelled && setDuplicates(n))
        .catch(() => !cancelled && setDuplicates(0));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, accountId, method, reference]);

  const needsReference = method === 'upi' || method === 'bank_transfer';

  // Picking an installment prefills its amount: the common case is settling a
  // line item exactly, and retyping the figure is how it ends up 100 rupees
  // off. Still editable for a part payment.
  function pickInstallment(id: string) {
    setInstallmentId(id);
    const chosen = installments.find((i) => i.id === id);
    if (chosen) setAmount(String(chosen.amount));
  }

  async function save() {
    if (!accountId || !user?.id) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter the amount received');
      return;
    }
    if (!head) {
      toast.error('Choose what the payment is for');
      return;
    }
    if (!receivedBy) {
      toast.error('Say who received the money');
      return;
    }
    if (method === 'cash' && !receipt) {
      toast.error('Attach a receipt for a cash payment');
      return;
    }
    if (receipt && receipt.size > RECEIPT_MAX_BYTES) {
      toast.error('Receipt must be 16 MB or smaller');
      return;
    }

    setSaving(true);
    try {
      const supabase = createClient();
      const paymentId = await recordPayment(supabase, accountId, user.id, {
        contactId,
        planId: plan?.id ?? null,
        installmentId: installmentId || null,
        paidAt: paidAt ? new Date(paidAt).toISOString() : undefined,
        amount: value,
        currency,
        method,
        reference,
        note,
        head,
        receivedBy,
        collectedBy: canPickCollector && collectedBy ? collectedBy : null,
        receipt,
      });

      if (receipt) {
        // Upload after the row exists, so a failed upload leaves a payment
        // without a receipt rather than an orphaned file with no payment.
        // The bucket is private; only the path is kept.
        try {
          const { path } = await uploadAccountMedia(
            'payment-receipts',
            receipt
          );
          await attachReceipt(
            supabase,
            accountId,
            user.id,
            paymentId,
            path,
            receipt.type || null
          );
        } catch (e) {
          toast.warning(
            `Payment recorded, but the receipt did not upload: ${
              e instanceof Error ? e.message : 'unknown error'
            }`
          );
        }
      }

      toast.success('Payment recorded, awaiting verification');
      onOpenChange(false);
      onRecorded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record payment');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Record a payment
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {contactName
              ? `Money received from ${contactName}.`
              : 'Money received.'}{' '}
            It is filed as awaiting verification until an admin checks it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pay-when">Received on</Label>
              <Input
                id="pay-when"
                type="datetime-local"
                value={paidAt}
                max={toLocalInput(new Date())}
                onChange={(e) => setPaidAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-amount">Amount ({currency})</Label>
              <Input
                id="pay-amount"
                type="number"
                min="1"
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          {installments.length > 0 && (
            <div className="space-y-1.5">
              <Label>Settles</Label>
              <Select
                value={installmentId || '__none__'}
                onValueChange={(v) =>
                  !v || v === '__none__'
                    ? setInstallmentId('')
                    : pickInstallment(v)
                }
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue placeholder="— Not against a specific item —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">
                    — Not against a specific item —
                  </SelectItem>
                  {installments.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {HEAD_LABEL[i.head]} · {i.label} ·{' '}
                      {formatCurrency(i.amount, currency)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={head}
                onValueChange={(v) => setHead((v ?? '') as FeeHead | '')}
              >
                <SelectTrigger className="bg-muted" aria-label="Type">
                  <SelectValue placeholder="What is it for?" />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_HEADS.map((h) => (
                    <SelectItem key={h} value={h}>
                      {HEAD_LABEL[h]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Paid to</Label>
              <Select
                value={receivedBy}
                onValueChange={(v) =>
                  setReceivedBy((v ?? '') as ReceivedBy | '')
                }
              >
                <SelectTrigger className="bg-muted" aria-label="Paid to">
                  <SelectValue placeholder="Who received it?" />
                </SelectTrigger>
                <SelectContent>
                  {RECEIVED_BY_OPTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {RECEIVED_BY_LABEL[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {canPickCollector && members.length > 0 && (
            <div className="space-y-1.5">
              <Label>Collected by</Label>
              <Select
                value={collectedBy}
                onValueChange={(v) => setCollectedBy(v ?? '')}
              >
                <SelectTrigger className="bg-muted" aria-label="Collected by">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {members.map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {m.userId === user?.id ? `${m.name} (me)` : m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Method</Label>
              <Select
                value={method}
                onValueChange={(v) => setMethod(v as PaymentMethod)}
              >
                <SelectTrigger className="bg-muted">
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
            <div className="space-y-1.5">
              <Label htmlFor="pay-ref">Reference</Label>
              <Input
                id="pay-ref"
                value={reference}
                placeholder="UPI ref / UTR / cheque no."
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
          </div>

          {needsReference && !reference.trim() && (
            <p className="text-xs text-amber-500">
              Add the {method === 'upi' ? 'UPI ref' : 'UTR'}: it is how an admin
              checks this against the account.
            </p>
          )}
          {duplicates > 0 && (
            <p className="text-xs text-amber-500" role="alert">
              {duplicates === 1
                ? 'Another payment already uses this reference.'
                : `${duplicates} other payments already use this reference.`}{' '}
              Check it is not a double entry.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="pay-receipt">
              Receipt{method === 'cash' ? ' (required for cash)' : ''}
            </Label>
            <Input
              id="pay-receipt"
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(e) =>
                setReceipt(e.target.files?.[0] ?? initialReceipt)
              }
            />
            {receipt && (
              <p className="text-foreground text-xs">
                Attached: {receipt.name}
                {receipt === initialReceipt && ' (from the chat)'}
              </p>
            )}
            <p className="text-muted-foreground flex items-center gap-1 text-xs">
              <Paperclip className="h-3 w-3" />
              Screenshot or bank PDF, up to 16 MB. Stored privately.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pay-note">Note</Label>
            <Textarea
              id="pay-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
