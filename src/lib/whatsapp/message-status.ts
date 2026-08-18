import type { MessageStatus } from '@/types';

/**
 * Reconcile the delivery status Meta sends with what `messages.status` accepts.
 *
 * The CHECK constraint from migration 001 allows only the ladder below plus
 * 'failed'. Anything else is a write error, not a no-op, so this module is what
 * stands between the webhook and a constraint violation.
 */

/**
 * Ordered low to high. Deliberately NOT the broadcast_recipients ladder in the
 * webhook route: that one starts at 'pending' and ends at 'replied'. The two
 * tables track different things and are free to drift.
 */
export const MESSAGE_STATUS_LADDER: MessageStatus[] = [
  'sending',
  'sent',
  'delivered',
  'read',
];

/**
 * Map Meta's status onto a value the column accepts.
 *
 * Meta sends `played` for voice notes. It used to be written straight through
 * and rejected with 23514 on every single voice message, which lost the receipt
 * and logged an error each time. Playing a voice note implies reading it, so it
 * folds into 'read' rather than being dropped.
 *
 * Returns null for anything unrecognised (e.g. 'deleted') so the caller can
 * ignore it instead of raising a constraint violation.
 */
export function normalizeMessageStatus(incoming: string): MessageStatus | null {
  if (incoming === 'played') return 'read';
  if (incoming === 'failed') return 'failed';
  return (MESSAGE_STATUS_LADDER as string[]).includes(incoming)
    ? (incoming as MessageStatus)
    : null;
}

/**
 * Which current statuses `next` is allowed to overwrite.
 *
 * Meta does not guarantee webhook ordering, so a late 'delivered' must not drag
 * a message back from 'read'. Callers apply this as a predicate on the UPDATE
 * so the check stays one statement; a read-then-write would race with
 * concurrent deliveries for the same wamid.
 *
 * 'failed' appears in no returned list, which makes it terminal. An empty list
 * means the update cannot apply to any row and should be skipped.
 */
export function statusesOverwritableBy(next: MessageStatus): MessageStatus[] {
  if (next === 'failed') return ['sending', 'sent'];
  return MESSAGE_STATUS_LADDER.slice(0, MESSAGE_STATUS_LADDER.indexOf(next));
}
