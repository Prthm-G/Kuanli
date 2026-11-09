import type { AccountRole } from '@/lib/auth/roles';
import type { Conversation, ConversationStatus } from '@/types';

/**
 * "mine" = open and pending conversations the signed-in person holds (SP3b "My
 * leads"). The set comes from `my_assigned_conversation_ids` (migration 093):
 * chats they own plus leads assigned to them as a counsellor, minus contacts
 * whose latest deal is Lost or Not Interested. The owner column alone would
 * keep a closed lead in the list. Closed chats are archived, as in the default
 * "open" view.
 */
export type InboxFilter = ConversationStatus | 'all' | 'unread' | 'mine';

/**
 * Counsellors land on their own leads; admins and owners on the whole inbox.
 * Before the role is known it is "mine", which shows nothing rather than
 * flashing every chat at a counsellor.
 */
export function defaultInboxFilter(role: AccountRole | null): InboxFilter {
  return role === 'owner' || role === 'admin' ? 'open' : 'mine';
}

/**
 * The inbox's status filter, as a pure function. "mine" needs the signed-in
 * profile id; without one (profile still loading) it shows nothing rather
 * than everyone's chats.
 */
export function filterConversations(
  list: Conversation[],
  filter: InboxFilter,
  profileId: string | null | undefined,
  assignedIds?: ReadonlySet<string>
): Conversation[] {
  if (filter === 'all') return list;
  if (filter === 'unread') return list.filter((c) => c.unread_count > 0);
  if (filter === 'mine') {
    return profileId
      ? list.filter(
          (c) =>
            c.status !== 'closed' &&
            !!assignedIds?.has(c.id) &&
            // The set can be a little stale; an owner set since then wins.
            (!c.assigned_agent_id || c.assigned_agent_id === profileId)
        )
      : [];
  }
  return list.filter((c) => c.status === filter);
}

/** Chat id -> owner profile id, to notice when "My leads" must be re-asked. */
export function ownerMap(
  list: readonly Conversation[]
): Map<string, string | null> {
  return new Map(list.map((c) => [c.id, c.assigned_agent_id ?? null]));
}

/**
 * True when a chat arrived or its owner changed since `prev`. Either can move
 * a lead in or out of "My leads", and the set lives on the server, so the list
 * asks again. Messages and unread counts do not count: they change all day.
 */
export function ownersChanged(
  prev: ReadonlyMap<string, string | null>,
  list: readonly Conversation[]
): boolean {
  return list.some(
    (c) => !prev.has(c.id) || prev.get(c.id) !== (c.assigned_agent_id ?? null)
  );
}
