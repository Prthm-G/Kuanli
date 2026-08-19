'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { CURRENCIES } from '@/lib/currency';
import { ENROLLMENT_UNIVERSITIES } from '@/lib/reports/university-code';
import {
  OPTION_LABEL,
  PAYMENT_OPTIONS,
  TERM_NOUN,
  type FeeTemplate,
  type PaymentOption,
} from '@/lib/payments/types';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Empty string for an optional numeric field means NULL, not zero. */
function numOrNull(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface FeeTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null to create. */
  template: FeeTemplate | null;
  onSaved: () => void;
}

/**
 * Create or edit a fee template.
 *
 * Editing amounts here cannot move an existing student's balance: a plan
 * snapshots its figures when it is applied (migration 056). What an edit does
 * change is what the next student is quoted, which is why the form states the
 * per-term/total relationship rather than leaving it implied.
 */
export function FeeTemplateDialog({
  open,
  onOpenChange,
  template,
  onSaved,
}: FeeTemplateDialogProps) {
  const { accountId, defaultCurrency } = useAuth();
  const [saving, setSaving] = useState(false);

  // Initial values come straight from the template. The parent keys this
  // component on the open flag and the template id, so switching targets
  // remounts it with fresh state — no reset effect, and no cascading render.
  const str = (v: number | null | undefined) => (v != null ? String(v) : '');

  const [university, setUniversity] = useState(template?.university ?? 'LPU');
  const [mode, setMode] = useState<'online' | 'distance'>(
    template?.mode ?? 'online'
  );
  const [program, setProgram] = useState(template?.program ?? '');
  const [specialization, setSpecialization] = useState(
    template?.specialization ?? ''
  );
  const [paymentOption, setPaymentOption] = useState<PaymentOption>(
    template?.paymentOption ?? 'per_semester'
  );
  const [termCount, setTermCount] = useState(str(template?.termCount));
  const [programmeFee, setProgrammeFee] = useState(str(template?.programmeFee));
  const [examFee, setExamFee] = useState(str(template?.examFee));
  const [totalFee, setTotalFee] = useState(str(template?.totalFee));
  const [applicationFee, setApplicationFee] = useState(
    str(template?.applicationFee)
  );
  const [studyMaterialFee, setStudyMaterialFee] = useState(
    str(template?.studyMaterialFee)
  );
  const [discountPct, setDiscountPct] = useState(
    str(template?.listDiscountPct)
  );
  const [currency, setCurrency] = useState(
    template?.currency ?? defaultCurrency
  );
  const [variant, setVariant] = useState(template?.variant ?? '');

  async function save() {
    if (!accountId) return;
    if (!program.trim()) {
      toast.error('Programme is required');
      return;
    }
    const per = numOrNull(programmeFee);
    const terms = numOrNull(termCount);
    if (per == null && numOrNull(totalFee) == null) {
      toast.error('Give either a per-term fee or a total');
      return;
    }

    setSaving(true);
    const row = {
      account_id: accountId,
      university: university.trim().toUpperCase(),
      mode,
      program: program.trim().toUpperCase(),
      specialization: specialization.trim(),
      payment_option: paymentOption,
      term_count: terms,
      programme_fee: per,
      exam_fee: numOrNull(examFee),
      // Derive the total when it is left blank and the parts are known, so the
      // ledger always has a figure to work from.
      total_fee:
        numOrNull(totalFee) ??
        (per != null && terms != null
          ? (per + (numOrNull(examFee) ?? 0)) * terms
          : null),
      application_fee: numOrNull(applicationFee),
      study_material_fee: numOrNull(studyMaterialFee),
      list_discount_pct: numOrNull(discountPct),
      currency,
      variant: variant.trim(),
      source: template?.source ?? 'entered by hand',
    };

    const supabase = createClient();
    const { error } = template
      ? await supabase.from('fee_templates').update(row).eq('id', template.id)
      : await supabase.from('fee_templates').insert(row);
    setSaving(false);

    if (error) {
      toast.error(
        error.code === '23505'
          ? 'A plan with this university, mode, programme, specialisation and payment option already exists'
          : error.message
      );
      return;
    }
    toast.success(template ? 'Fee plan updated' : 'Fee plan added');
    onOpenChange(false);
    onSaved();
  }

  const per = numOrNull(programmeFee);
  const terms = numOrNull(termCount);
  const derived =
    per != null && terms != null
      ? (per + (numOrNull(examFee) ?? 0)) * terms
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {template ? 'Edit fee plan' : 'Add a fee plan'}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            List prices. Students already on a plan keep the figures they were
            quoted, so changes here only affect plans applied from now on.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label>University</Label>
              <Select
                value={university}
                onValueChange={(v) => v && setUniversity(v)}
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENROLLMENT_UNIVERSITIES.map((u) => (
                    <SelectItem key={u.code} value={u.code}>
                      {u.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Mode</Label>
              <Select
                value={mode}
                onValueChange={(v) => v && setMode(v as 'online' | 'distance')}
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="online">Online</SelectItem>
                  <SelectItem value="distance">Distance</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ft-prog">Programme</Label>
              <Input
                id="ft-prog"
                value={program}
                placeholder="MBA"
                onChange={(e) => setProgram(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ft-spec">Specialisation</Label>
              <Input
                id="ft-spec"
                value={specialization}
                placeholder="(general)"
                onChange={(e) => setSpecialization(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label>Payment option</Label>
              <Select
                value={paymentOption}
                onValueChange={(v) => v && setPaymentOption(v as PaymentOption)}
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_OPTIONS.map((o) => (
                    <SelectItem key={o} value={o}>
                      {OPTION_LABEL[o]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ft-terms">{TERM_NOUN[paymentOption]}s</Label>
              <Input
                id="ft-terms"
                type="number"
                min="1"
                value={termCount}
                onChange={(e) => setTermCount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Select
                value={currency}
                onValueChange={(v) => v && setCurrency(v)}
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ft-variant">Tier</Label>
              <Input
                id="ft-variant"
                value={variant}
                placeholder="(none)"
                onChange={(e) => setVariant(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Money
              id="ft-per"
              label={`Fee per ${TERM_NOUN[paymentOption]}`}
              value={programmeFee}
              onChange={setProgrammeFee}
            />
            <Money
              id="ft-exam"
              label={`Exam fee per ${TERM_NOUN[paymentOption]}`}
              value={examFee}
              onChange={setExamFee}
            />
            <Money
              id="ft-total"
              label="Total (whole programme)"
              value={totalFee}
              onChange={setTotalFee}
            />
            <Money
              id="ft-app"
              label="Application / registration"
              value={applicationFee}
              onChange={setApplicationFee}
            />
            <Money
              id="ft-mat"
              label="Study material"
              value={studyMaterialFee}
              onChange={setStudyMaterialFee}
            />
            <div className="space-y-1.5">
              <Label htmlFor="ft-disc">Discount already applied (%)</Label>
              <Input
                id="ft-disc"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={discountPct}
                onChange={(e) => setDiscountPct(e.target.value)}
              />
            </div>
          </div>

          {derived != null && (
            <p className="text-muted-foreground text-xs">
              Leaving the total blank will store {derived.toLocaleString()}{' '}
              {currency} ({(per ?? 0).toLocaleString()} +{' '}
              {(numOrNull(examFee) ?? 0).toLocaleString()}) × {terms}. Set it
              explicitly if the last term differs.
            </p>
          )}
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
            {saving ? 'Saving…' : template ? 'Save changes' : 'Add fee plan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Money({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min="0"
        step="0.01"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
