/**
 * Fee plan and payment types (migration 056).
 */

/** Mirrors `fee_payment_option_enum`. */
export const PAYMENT_OPTIONS = ['per_semester', 'annual', 'lump_sum'] as const;
export type PaymentOption = (typeof PAYMENT_OPTIONS)[number];

/** Mirrors `payment_method_enum`. */
export const PAYMENT_METHODS = [
  'upi',
  'bank_transfer',
  'cash',
  'card',
  'cheque',
  'other',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Mirrors `payment_status_enum`. */
export type PaymentStatus = 'reported' | 'verified' | 'rejected';

/** Mirrors `fee_head_enum`. */
export type FeeHead =
  | 'application'
  | 'registration'
  | 'semester'
  | 'exam'
  | 'study_material'
  | 'other';

export const OPTION_LABEL: Record<PaymentOption, string> = {
  per_semester: 'Per semester',
  annual: 'Annual',
  lump_sum: 'Lump sum',
};

/**
 * What one "term" means for each option. The same degree is priced three ways
 * and the term is not always a semester, which is the distinction that makes
 * the totals differ.
 */
export const TERM_NOUN: Record<PaymentOption, string> = {
  per_semester: 'semester',
  annual: 'year',
  lump_sum: 'one-off',
};

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  card: 'Card',
  cheque: 'Cheque',
  other: 'Other',
};

export const STATUS_LABEL: Record<PaymentStatus, string> = {
  reported: 'Awaiting check',
  verified: 'Verified',
  rejected: 'Rejected',
};

export const HEAD_LABEL: Record<FeeHead, string> = {
  application: 'Application',
  registration: 'Registration',
  semester: 'Tuition',
  exam: 'Examination',
  study_material: 'Study material',
  other: 'Other',
};

export interface FeeTemplate {
  id: string;
  university: string;
  mode: 'online' | 'distance';
  program: string;
  specialization: string;
  paymentOption: PaymentOption;
  termCount: number | null;
  programmeFee: number | null;
  examFee: number | null;
  totalFee: number | null;
  applicationFee: number | null;
  studyMaterialFee: number | null;
  listDiscountPct: number | null;
  currency: string;
  variant: string;
  source: string | null;
  effectiveFrom: string;
  active: boolean;
}

export interface FeePlan {
  id: string;
  contactId: string;
  university: string | null;
  mode: string | null;
  program: string | null;
  specialization: string;
  paymentOption: PaymentOption | null;
  currency: string;
  agreedTotal: number;
  note: string | null;
}

export interface FeeInstallment {
  id: string;
  planId: string;
  head: FeeHead;
  termIndex: number | null;
  label: string;
  amount: number;
  dueDate: string | null;
  position: number;
}

export interface Payment {
  id: string;
  contactId: string;
  planId: string | null;
  installmentId: string | null;
  paidAt: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  reference: string | null;
  note: string | null;
  status: PaymentStatus;
  loggedBy: string;
  loggedByName: string | null;
  verifiedBy: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  decisionNote: string | null;
  receipts: PaymentReceipt[];
}

export interface PaymentReceipt {
  id: string;
  storagePath: string;
  mimeType: string | null;
  createdAt: string;
}

/** One row of `payment_ledger`. */
export interface LedgerRow {
  contactId: string;
  name: string | null;
  phone: string | null;
  rollNumber: string | null;
  university: string | null;
  program: string | null;
  paymentOption: PaymentOption | null;
  currency: string;
  planId: string | null;
  agreedTotal: number;
  /** Verified money only. */
  received: number;
  /** Reported but not yet checked. Deliberately not counted as received. */
  reported: number;
  outstanding: number;
  nextDueLabel: string | null;
  nextDueDate: string | null;
  nextDueAmount: number | null;
  lastPaymentAt: string | null;
}

export interface NewPayment {
  contactId: string;
  planId?: string | null;
  installmentId?: string | null;
  paidAt?: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  reference?: string | null;
  note?: string | null;
}
