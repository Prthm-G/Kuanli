import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  FeeInstallment,
  FeePlan,
  FeeTemplate,
  LedgerRow,
  NewPayment,
  Payment,
  PaymentMethod,
  PaymentOption,
  PaymentStatus,
} from './types';

const n = (v: unknown): number => Number(v ?? 0);
const nOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * Account-wide ledger via the `payment_ledger` RPC (migration 056). One row
 * per student who has a plan or has paid something. `received` counts verified
 * money only; `reported` is the unchecked claim, kept separate on purpose.
 */
export async function loadLedger(
  supabase: SupabaseClient,
  accountId: string
): Promise<LedgerRow[]> {
  const { data, error } = await supabase.rpc('payment_ledger', {
    p_account_id: accountId,
  });

  if (error) throw new Error(`Payment ledger query failed: ${error.message}`);

  type Raw = {
    contact_id: string;
    name: string | null;
    phone: string | null;
    roll_number: string | null;
    university: string | null;
    program: string | null;
    payment_option: PaymentOption | null;
    currency: string;
    plan_id: string | null;
    agreed_total: string | number;
    received: string | number;
    reported: string | number;
    outstanding: string | number;
    next_due_label: string | null;
    next_due_date: string | null;
    next_due_amount: string | number | null;
    last_payment_at: string | null;
  };

  return ((data ?? []) as unknown as Raw[]).map((r) => ({
    contactId: r.contact_id,
    name: r.name ?? null,
    phone: r.phone ?? null,
    rollNumber: r.roll_number ?? null,
    university: r.university ?? null,
    program: r.program ?? null,
    paymentOption: r.payment_option ?? null,
    currency: r.currency || 'INR',
    planId: r.plan_id ?? null,
    agreedTotal: n(r.agreed_total),
    received: n(r.received),
    reported: n(r.reported),
    outstanding: n(r.outstanding),
    nextDueLabel: r.next_due_label ?? null,
    nextDueDate: r.next_due_date ?? null,
    nextDueAmount: nOrNull(r.next_due_amount),
    lastPaymentAt: r.last_payment_at ?? null,
  }));
}

/** Active fee templates for the account, for the picker and the settings panel. */
export async function loadFeeTemplates(
  supabase: SupabaseClient,
  accountId: string,
  { includeInactive = false }: { includeInactive?: boolean } = {}
): Promise<FeeTemplate[]> {
  let q = supabase
    .from('fee_templates')
    .select(
      'id, university, mode, program, specialization, payment_option, term_count, ' +
        'programme_fee, exam_fee, total_fee, application_fee, study_material_fee, ' +
        'list_discount_pct, currency, variant, source, effective_from, active'
    )
    .eq('account_id', accountId);

  if (!includeInactive) q = q.eq('active', true);

  const { data, error } = await q
    .order('university')
    .order('mode')
    .order('program')
    .order('specialization')
    .order('payment_option');

  if (error) throw new Error(`Fee templates query failed: ${error.message}`);

  type Raw = Record<string, unknown>;
  return ((data ?? []) as unknown as Raw[]).map((r) => ({
    id: String(r.id),
    university: String(r.university ?? ''),
    mode: (r.mode as 'online' | 'distance') ?? 'online',
    program: String(r.program ?? ''),
    specialization: String(r.specialization ?? ''),
    paymentOption: r.payment_option as PaymentOption,
    termCount: nOrNull(r.term_count),
    programmeFee: nOrNull(r.programme_fee),
    examFee: nOrNull(r.exam_fee),
    totalFee: nOrNull(r.total_fee),
    applicationFee: nOrNull(r.application_fee),
    studyMaterialFee: nOrNull(r.study_material_fee),
    listDiscountPct: nOrNull(r.list_discount_pct),
    currency: String(r.currency ?? 'INR'),
    variant: String(r.variant ?? ''),
    source: (r.source as string) ?? null,
    effectiveFrom: String(r.effective_from ?? ''),
    active: Boolean(r.active),
  }));
}

/** One student's plan, its installments, and every payment against them. */
export async function loadStudentAccount(
  supabase: SupabaseClient,
  contactId: string
): Promise<{
  plan: FeePlan | null;
  installments: FeeInstallment[];
  payments: Payment[];
}> {
  const { data: planRow, error: planErr } = await supabase
    .from('student_fee_plans')
    .select(
      'id, contact_id, university, mode, program, specialization, ' +
        'payment_option, currency, agreed_total, note'
    )
    .eq('contact_id', contactId)
    .maybeSingle();

  if (planErr) throw new Error(`Fee plan query failed: ${planErr.message}`);

  // PostgREST types rows loosely for tables the generated types do not know
  // yet; the codebase's convention (lib/queue/queries.ts) is to assert the
  // shape once, at the boundary.
  const planRaw = planRow as unknown as Record<string, unknown> | null;

  const plan: FeePlan | null = planRaw
    ? {
        id: String(planRaw.id),
        contactId: String(planRaw.contact_id),
        university: (planRaw.university as string) ?? null,
        mode: (planRaw.mode as string) ?? null,
        program: (planRaw.program as string) ?? null,
        specialization: String(planRaw.specialization ?? ''),
        paymentOption: (planRaw.payment_option as PaymentOption) ?? null,
        currency: String(planRaw.currency ?? 'INR'),
        agreedTotal: n(planRaw.agreed_total),
        note: (planRaw.note as string) ?? null,
      }
    : null;

  const [instRes, payRes] = await Promise.all([
    plan
      ? supabase
          .from('student_fee_installments')
          .select(
            'id, plan_id, head, term_index, label, amount, due_date, position'
          )
          .eq('plan_id', plan.id)
          .order('position')
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('payments')
      .select(
        'id, contact_id, plan_id, installment_id, paid_at, amount, currency, ' +
          'method, reference, note, status, logged_by, verified_by, verified_at, ' +
          'decision_note, ' +
          'logged:profiles!payments_logged_by_fkey(full_name), ' +
          'receipts:payment_receipts(id, storage_path, mime_type, created_at)'
      )
      .eq('contact_id', contactId)
      .order('paid_at', { ascending: false }),
  ]);

  if (instRes.error)
    throw new Error(`Installments query failed: ${instRes.error.message}`);
  if (payRes.error)
    throw new Error(`Payments query failed: ${payRes.error.message}`);

  type RawInst = Record<string, unknown>;
  const installments: FeeInstallment[] = (
    (instRes.data ?? []) as unknown as RawInst[]
  ).map((r) => ({
    id: String(r.id),
    planId: String(r.plan_id),
    head: r.head as FeeInstallment['head'],
    termIndex: nOrNull(r.term_index),
    label: String(r.label ?? ''),
    amount: n(r.amount),
    dueDate: (r.due_date as string) ?? null,
    position: n(r.position),
  }));

  type RawPay = Record<string, unknown>;
  const payments: Payment[] = ((payRes.data ?? []) as unknown as RawPay[]).map(
    (r) => {
      // PostgREST types embedded to-one relations loosely; normalise the array
      // case rather than trusting the shape (same as lib/reports/queries.ts).
      const logged = Array.isArray(r.logged) ? r.logged[0] : r.logged;
      return {
        id: String(r.id),
        contactId: String(r.contact_id),
        planId: (r.plan_id as string) ?? null,
        installmentId: (r.installment_id as string) ?? null,
        paidAt: String(r.paid_at),
        amount: n(r.amount),
        currency: String(r.currency ?? 'INR'),
        method: r.method as PaymentMethod,
        reference: (r.reference as string) ?? null,
        note: (r.note as string) ?? null,
        status: r.status as PaymentStatus,
        loggedBy: String(r.logged_by),
        loggedByName:
          (logged as { full_name?: string } | null)?.full_name ?? null,
        verifiedBy: (r.verified_by as string) ?? null,
        verifiedByName: null,
        verifiedAt: (r.verified_at as string) ?? null,
        decisionNote: (r.decision_note as string) ?? null,
        receipts: (
          (r.receipts ?? []) as unknown as Record<string, unknown>[]
        ).map((x) => ({
          id: String(x.id),
          storagePath: String(x.storage_path),
          mimeType: (x.mime_type as string) ?? null,
          createdAt: String(x.created_at),
        })),
      };
    }
  );

  return { plan, installments, payments };
}

/**
 * Materialize a template onto a student via the `apply_fee_template` RPC.
 * Amounts are snapshotted into the plan by the function, so a later template
 * edit never rewrites what this student agreed to.
 */
export async function applyFeeTemplate(
  supabase: SupabaseClient,
  contactId: string,
  templateId: string,
  startDate?: string
): Promise<string> {
  const { data, error } = await supabase.rpc('apply_fee_template', {
    p_contact_id: contactId,
    p_template_id: templateId,
    ...(startDate ? { p_start_date: startDate } : {}),
  });

  if (error) throw new Error(`Could not apply the fee plan: ${error.message}`);
  return String(data);
}

/**
 * Record a payment. It always lands as `reported`: the RLS INSERT policy
 * rejects any other status, so an agent cannot file money as already checked.
 */
export async function recordPayment(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  payment: NewPayment
): Promise<string> {
  const { data, error } = await supabase
    .from('payments')
    .insert({
      account_id: accountId,
      contact_id: payment.contactId,
      plan_id: payment.planId ?? null,
      installment_id: payment.installmentId ?? null,
      paid_at: payment.paidAt ?? new Date().toISOString(),
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      reference: payment.reference?.trim() || null,
      note: payment.note?.trim() || null,
      logged_by: userId,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Could not record the payment: ${error.message}`);
  return String((data as unknown as { id: string }).id);
}

/**
 * Admin decision on a reported payment, via `verify_payment`. The function
 * refuses anything but reported -> verified|rejected, and refuses non-admins,
 * so the UI gate is a convenience rather than the control.
 */
export async function decidePayment(
  supabase: SupabaseClient,
  paymentId: string,
  status: 'verified' | 'rejected',
  note?: string
): Promise<void> {
  const { error } = await supabase.rpc('verify_payment', {
    p_payment_id: paymentId,
    p_status: status,
    p_note: note?.trim() || null,
  });

  if (error)
    throw new Error(
      `Could not ${status.slice(0, -1)} payment: ${error.message}`
    );
}

/** Attach an uploaded receipt to a payment. */
export async function attachReceipt(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  paymentId: string,
  storagePath: string,
  mimeType: string | null
): Promise<void> {
  const { error } = await supabase.from('payment_receipts').insert({
    account_id: accountId,
    payment_id: paymentId,
    storage_path: storagePath,
    mime_type: mimeType,
    uploaded_by: userId,
  });

  if (error) throw new Error(`Could not attach the receipt: ${error.message}`);
}

/**
 * Short-lived URL for a receipt. The bucket is private (financial PII), so
 * there is no public URL to fall back on.
 */
export async function receiptUrl(
  supabase: SupabaseClient,
  storagePath: string
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('payment-receipts')
    .createSignedUrl(storagePath, 60 * 10);

  return error ? null : (data?.signedUrl ?? null);
}
