import type { MessageStatus } from '@/types';
import { normalizeMessageStatus } from './message-status';

/**
 * Meta's `history` webhook: the past chats of a WhatsApp Business app number
 * onboarded on coexistence, sent once after the partner asks for them
 * (POST /<phone_number_id>/smb_app_data, sync_type "history"). Checked against
 * developers.facebook.com, webhooks/reference/history, on 2026-11-09:
 *
 *  - value.history[]: one entry per chunk, with metadata.phase (0: day 0-1,
 *    1: day 1-90, 2: day 90-180), metadata.chunk_order (chunks can arrive out
 *    of order) and metadata.progress (100 = done), and threads[]: one per
 *    contact, `id` / `context.wa_id` the contact's number (left out when only
 *    a username is known), messages[] in the usual per-type shape plus
 *    history_context.status.
 *  - A message from the contact has from_user_id and `from` = their number; a
 *    message from the business has `from` = the business number.
 *  - `timestamp` is when the recipient's device got it: the original time.
 *  - type "media_placeholder": the content follows in a separate history
 *    webhook (value.messages[] for media the contact sent, value.message_echoes[]
 *    for media the business sent), same message id, only for the last 14 days.
 *  - Declined sharing: value.history[].errors[] with code 2593109.
 *  - Group chats are never included.
 *
 * This module only plans: what to store, with which sender and time. The
 * webhook route writes it, once per message id.
 */

export const HISTORY_DECLINED_CODE = 2593109;

/** Stored for a media_placeholder; the media webhook that follows replaces it. */
export const HISTORY_MEDIA_PLACEHOLDER = '[Media from chat history]';

export interface HistoryMessage {
  from?: string;
  from_user_id?: string;
  to?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  history_context?: { status?: string };
  [key: string]: unknown;
}

interface HistoryThread {
  id?: string;
  context?: { wa_id?: string; user_id?: string; username?: string };
  messages?: HistoryMessage[];
}

interface HistoryEntry {
  metadata?: { phase?: number; chunk_order?: number; progress?: number };
  threads?: HistoryThread[];
  errors?: {
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }[];
}

export interface HistoryValue {
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  history?: HistoryEntry[];
  messages?: HistoryMessage[];
  message_echoes?: HistoryMessage[];
}

export interface PlannedHistoryMessage {
  message: HistoryMessage & { id: string; timestamp: string; type: string };
  senderType: 'customer' | 'agent';
  /** The original time, ISO. */
  createdAt: string;
  status: MessageStatus;
  placeholder: boolean;
}

export interface PlannedThread {
  customerPhone: string;
  messages: PlannedHistoryMessage[];
}

export type HistoryPart =
  | { kind: 'error'; code: number | null; details: string }
  | {
      kind: 'chunk';
      phase: number | null;
      chunkOrder: number | null;
      progress: number | null;
      threads: PlannedThread[];
      /** Messages left out: no id, no readable time, a reaction, or no phone number for the thread. */
      skipped: number;
    };

export interface PlannedMedia {
  customerPhone: string;
  message: PlannedHistoryMessage;
}

const digits = (s: string | undefined) => (s ?? '').replace(/\D/g, '');
const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** The contact wrote it when Meta says so (from_user_id) or `from` is their number; otherwise the business did. */
export function historySender(
  m: Pick<HistoryMessage, 'from' | 'from_user_id'>,
  customerPhone: string
): 'customer' | 'agent' {
  if (m.from_user_id) return 'customer';
  const from = digits(m.from);
  return from !== '' && from === digits(customerPhone) ? 'customer' : 'agent';
}

// Meta sends these upper or lower case: delivered, error, pending, played, read, sent.
function agentStatus(raw: string | undefined): MessageStatus {
  const s = (raw ?? '').toLowerCase();
  if (s === 'error') return 'failed';
  if (s === 'pending') return 'sent';
  return normalizeMessageStatus(s) ?? 'sent';
}

function planMessage(
  m: HistoryMessage,
  senderType: 'customer' | 'agent'
): PlannedHistoryMessage | null {
  if (!m.id || !m.type || m.type === 'reaction') return null;
  const ts = Number.parseInt(m.timestamp ?? '', 10);
  if (!Number.isFinite(ts) || String(ts) !== String(m.timestamp).trim())
    return null;
  return {
    message: m as PlannedHistoryMessage['message'],
    senderType,
    createdAt: new Date(ts * 1000).toISOString(),
    status:
      senderType === 'customer'
        ? 'delivered'
        : agentStatus(m.history_context?.status),
    placeholder: m.type === 'media_placeholder',
  };
}

export function planHistory(value: HistoryValue): {
  parts: HistoryPart[];
  media: PlannedMedia[];
} {
  const parts: HistoryPart[] = [];
  for (const entry of value.history ?? []) {
    const err = entry.errors?.[0];
    if (err) {
      parts.push({
        kind: 'error',
        code: num(err.code),
        details: err.error_data?.details ?? err.message ?? err.title ?? '',
      });
      continue;
    }
    let skipped = 0;
    const threads: PlannedThread[] = [];
    for (const t of entry.threads ?? []) {
      const msgs = t.messages ?? [];
      const customerPhone = digits(t.id ?? t.context?.wa_id);
      if (!customerPhone) {
        skipped += msgs.length;
        continue;
      }
      const planned: PlannedHistoryMessage[] = [];
      for (const m of msgs) {
        const p = planMessage(m, historySender(m, customerPhone));
        if (p) planned.push(p);
        else skipped += 1;
      }
      if (planned.length > 0)
        threads.push({ customerPhone, messages: planned });
    }
    parts.push({
      kind: 'chunk',
      phase: num(entry.metadata?.phase),
      chunkOrder: num(entry.metadata?.chunk_order),
      progress: num(entry.metadata?.progress),
      threads,
      skipped,
    });
  }

  const media: PlannedMedia[] = [];
  for (const m of value.messages ?? []) {
    const phone = digits(m.from);
    const p = phone ? planMessage(m, 'customer') : null;
    if (p) media.push({ customerPhone: phone, message: p });
  }
  for (const m of value.message_echoes ?? []) {
    const phone = digits(m.to);
    const p = phone ? planMessage(m, 'agent') : null;
    if (p) media.push({ customerPhone: phone, message: p });
  }
  return { parts, media };
}

/** For the log line: what came in, without any message content. */
export function summarizeHistoryParts(parts: HistoryPart[]) {
  return {
    declined: parts
      .filter(
        (p): p is Extract<HistoryPart, { kind: 'error' }> =>
          p.kind === 'error' && p.code === HISTORY_DECLINED_CODE
      )
      .map((p) => ({ code: p.code, details: p.details })),
    chunks: parts
      .filter(
        (p): p is Extract<HistoryPart, { kind: 'chunk' }> => p.kind === 'chunk'
      )
      .map((p) => ({
        phase: p.phase,
        chunkOrder: p.chunkOrder,
        progress: p.progress,
        threads: p.threads.length,
        messages: p.threads.reduce((n, t) => n + t.messages.length, 0),
        skipped: p.skipped,
      })),
  };
}

/**
 * How much of a number's history to keep (094, whatsapp_config.history_scope):
 * 'all' every 1:1 chat Meta sends, the default and the owner's choice of
 * 9 Nov; 'known_contacts' only chats with someone already in Contacts.
 */
export type HistoryScope = 'all' | 'known_contacts';

export function historyScopeOf(value: unknown): HistoryScope {
  return value === 'known_contacts' ? 'known_contacts' : 'all';
}
