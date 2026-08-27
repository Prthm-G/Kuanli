/**
 * Manual follow-up log types (migration 054).
 *
 * Distinct from the automated ladder in the same directory: `merge.ts` renders
 * bodies the *bot* sends, this file describes what a *counsellor* did. The two
 * meet only in `TimelineItem`, which the `follow_up_timeline` RPC returns as a
 * merged stream.
 */

/** Mirrors `followup_method_enum`. Order is the display order in the form. */
export const FOLLOWUP_METHODS = [
  'call',
  'whatsapp',
  'email',
  'in_person',
] as const;

export type FollowUpMethod = (typeof FOLLOWUP_METHODS)[number];

/** Mirrors `followup_outcome_enum`. */
export const FOLLOWUP_OUTCOMES = [
  'connected',
  'no_answer',
  'callback_requested',
  'not_interested',
  'converted',
] as const;

export type FollowUpOutcome = (typeof FOLLOWUP_OUTCOMES)[number];

export const METHOD_LABEL: Record<FollowUpMethod, string> = {
  call: 'Call',
  whatsapp: 'WhatsApp',
  email: 'Email',
  in_person: 'In person',
};

export const OUTCOME_LABEL: Record<FollowUpOutcome, string> = {
  connected: 'Connected',
  no_answer: 'No answer',
  callback_requested: 'Callback requested',
  not_interested: 'Not interested',
  converted: 'Converted',
};

/**
 * Outcome tone for chips. Kept beside the labels so a new outcome cannot be
 * added without deciding how it reads.
 */
export const OUTCOME_TONE: Record<
  FollowUpOutcome,
  'positive' | 'neutral' | 'negative'
> = {
  connected: 'positive',
  converted: 'positive',
  callback_requested: 'neutral',
  no_answer: 'neutral',
  not_interested: 'negative',
};

/** One row of `follow_up_worklist`: a contact with an open commitment. */
export interface WorklistRow {
  contactId: string;
  entryId: string;
  conversationId: string | null;
  name: string | null;
  phone: string | null;
  rollNumber: string | null;
  university: string | null;
  stageName: string | null;
  occurredAt: string;
  method: FollowUpMethod;
  outcome: FollowUpOutcome | null;
  summary: string;
  /** Non-null by construction — the RPC only returns open commitments. */
  nextDueAt: string;
  nextMethod: FollowUpMethod | null;
  loggedBy: string;
  loggedByName: string | null;
}

/**
 * One row of `follow_up_timeline`. `source` separates a counsellor's entry
 * from an automated ladder send; automated rows never carry an outcome or a
 * next step, because the ladder makes no promises.
 */
export interface TimelineItem {
  source: 'manual' | 'auto';
  entryId: string;
  occurredAt: string;
  method: FollowUpMethod | null;
  outcome: FollowUpOutcome | null;
  summary: string;
  nextDueAt: string | null;
  nextMethod: FollowUpMethod | null;
  actorName: string | null;
}

/** Payload for logging a new entry. */
export interface NewFollowUp {
  contactId: string;
  conversationId?: string | null;
  occurredAt?: string;
  method: FollowUpMethod;
  outcome?: FollowUpOutcome | null;
  summary: string;
  nextDueAt?: string | null;
  nextMethod?: FollowUpMethod | null;
}
