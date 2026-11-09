import type { ContactSource } from '@/types';

import type { QueueScore } from './score';

/** One workable lead, as returned by the `lead_queue` RPC (migration 041). */
export interface QueueLead {
  dealId: string;
  contactId: string;
  conversationId: string | null;
  name: string | null;
  phone: string | null;
  rollNumber: string | null;
  stageName: string;
  stagePosition: number;
  university: string | null;
  mode: string | null;
  course: string | null;
  specialization: string | null;
  adHeadline: string | null;
  adBody: string | null;
  /** Stored lead channel (migration 073). */
  source: ContactSource;
  customerMessages: number;
  lastCustomerAt: string | null;
  lastAgentAt: string | null;
  /** Newest logged follow-up's occurred_at (093); clears awaiting when later. */
  lastFollowUpAt: string | null;
  score: QueueScore;
}
