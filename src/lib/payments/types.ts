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
  /** Every discount that is not rejected, so a pending one already counts. */
  discounts: number;
  /** The reversible part of `discounts`. */
  pendingDiscounts: number;
  outstanding: number;
  /** Settled money in minus settled money out: the float plus commission. */
  inHand: number;
  nextDueLabel: string | null;
  nextDueDate: string | null;
  nextDueAmount: number | null;
  lastPaymentAt: string | null;
}

/** Mirrors `payment_party_enum`. */
export const ROUTE_PARTIES = [
  'student',
  'skeure',
  'university',
  'bank',
] as const;
export type RouteParty = (typeof ROUTE_PARTIES)[number];

/** Mirrors `hop_status_enum`. */
export const HOP_STATUSES = ['pending', 'sent', 'settled', 'failed'] as const;
export type HopStatus = (typeof HOP_STATUSES)[number];

export const PARTY_LABEL: Record<RouteParty, string> = {
  student: 'Student',
  skeure: 'Skeure',
  university: 'University',
  bank: 'Bank',
};

export const HOP_STATUS_LABEL: Record<HopStatus, string> = {
  pending: 'Pending',
  sent: 'Sent',
  settled: 'Settled',
  failed: 'Failed',
};

/** One leg of a payment's journey (migration 057). */
export interface PaymentHop {
  id: string;
  paymentId: string;
  hopOrder: number;
  fromParty: RouteParty;
  toParty: RouteParty;
  movedAt: string | null;
  amount: number;
  method: PaymentMethod | null;
  reference: string | null;
  status: HopStatus;
  note: string | null;
}

/** Mirrors `discount_status_enum`. */
export type DiscountStatus = 'pending' | 'approved' | 'rejected';

export const DISCOUNT_STATUS_LABEL: Record<DiscountStatus, string> = {
  pending: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

export interface FeeDiscount {
  id: string;
  contactId: string;
  planId: string | null;
  installmentId: string | null;
  amount: number;
  reason: string;
  status: DiscountStatus;
  proposedBy: string;
  proposedByName: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
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
