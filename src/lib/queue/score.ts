/**
 * Lead priority score, 0–100. The `lead_queue` RPC gathers the facts; this
 * module owns the judgment, so the weights live in one tested place and tuning
 * them never needs a migration.
 *
 * Weights and what justifies them (re-measured 2026-08-18, post-purge):
 *
 * - Engagement depth is the strongest continuous predictor we have: in the
 *   pre-purge data (100 conversations with inbound), 14% of one-message leads
 *   ever named a university vs 53% of leads with 5+ messages — the ~4x
 *   gradient that motivated this queue, and the post-purge data shows the
 *   same direction. Capped at 10 messages: beyond that, more volume is not
 *   more intent.
 *
 * - Awaiting a human reply is the strongest *operational* signal: the lead
 *   spoke last and nobody has answered. At time of writing that was 36 of the
 *   65 workable leads. Weighted just below the engagement cap so an engaged
 *   answered lead can still outrank a cold unanswered one, but any engaged
 *   unanswered lead tops the queue.
 *
 * - Interest progress (university → course → specialization) marks how far
 *   down the funnel the bot already took them; the university signal alone
 *   is what moves a deal to Qualified in the lifecycle sweep (migration 039).
 *
 * - Recency: WhatsApp's 24h service window makes a same-day reply materially
 *   cheaper (no template needed), and the pre-purge survival data shows leads
 *   are either active within ~3 days or gone for weeks — hence the 24h/72h
 *   buckets.
 */

export interface QueueSignals {
  customerMessages: number;
  hasUniversity: boolean;
  hasCourse: boolean;
  hasSpecialization: boolean;
  /** Newest customer message across all the contact's conversations. */
  lastCustomerAt: Date | null;
  /** Newest human agent message across all the contact's conversations. */
  lastAgentAt: Date | null;
}

export interface QueueScore {
  total: number;
  engagement: number;
  interest: number;
  awaitingReply: number;
  recency: number;
  /** True when the lead spoke last and no human has replied since. */
  isAwaitingReply: boolean;
}

const ENGAGEMENT_PER_MESSAGE = 4;
const ENGAGEMENT_MESSAGE_CAP = 10;
const UNIVERSITY_POINTS = 10;
const COURSE_POINTS = 5;
const SPECIALIZATION_POINTS = 5;
const AWAITING_REPLY_POINTS = 25;
const RECENCY_24H_POINTS = 15;
const RECENCY_72H_POINTS = 8;

const HOUR_MS = 3_600_000;

export function scoreLead(signals: QueueSignals, now: Date = new Date()): QueueScore {
  const engagement =
    Math.min(Math.max(signals.customerMessages, 0), ENGAGEMENT_MESSAGE_CAP) *
    ENGAGEMENT_PER_MESSAGE;

  const interest =
    (signals.hasUniversity ? UNIVERSITY_POINTS : 0) +
    (signals.hasCourse ? COURSE_POINTS : 0) +
    (signals.hasSpecialization ? SPECIALIZATION_POINTS : 0);

  // A lead who never wrote (broadcast-only thread) is not "awaiting" anything.
  const isAwaitingReply =
    signals.lastCustomerAt !== null &&
    (signals.lastAgentAt === null || signals.lastCustomerAt > signals.lastAgentAt);
  const awaitingReply = isAwaitingReply ? AWAITING_REPLY_POINTS : 0;

  let recency = 0;
  if (signals.lastCustomerAt !== null) {
    const ageHours = (now.getTime() - signals.lastCustomerAt.getTime()) / HOUR_MS;
    if (ageHours < 24) recency = RECENCY_24H_POINTS;
    else if (ageHours < 72) recency = RECENCY_72H_POINTS;
  }

  return {
    total: engagement + interest + awaitingReply + recency,
    engagement,
    interest,
    awaitingReply,
    recency,
    isAwaitingReply,
  };
}

/**
 * Queue order: highest score first; ties broken by freshest customer message
 * (a null lastCustomerAt sorts last within its score band).
 */
export function compareByScore(
  a: { score: QueueScore; lastCustomerAt: string | null },
  b: { score: QueueScore; lastCustomerAt: string | null },
): number {
  if (b.score.total !== a.score.total) return b.score.total - a.score.total;
  if (a.lastCustomerAt === null) return b.lastCustomerAt === null ? 0 : 1;
  if (b.lastCustomerAt === null) return -1;
  return b.lastCustomerAt.localeCompare(a.lastCustomerAt);
}
