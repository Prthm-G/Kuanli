import type { Conversation, ConversationStatus } from '@/types';

/**
 * "mine" = open and pending conversations assigned to the signed-in profile
 * (SP3b "My leads"). Closed chats are archived, as in the default "open" view.
 */
export type InboxFilter = ConversationStatus | 'all' | 'unread' | 'mine';

/**
 * The inbox's status filter, as a pure function. "mine" needs the signed-in
 * profile id; without one (profile still loading) it shows nothing rather
 * than everyone's chats.
 */
export function filterConversations(
  list: Conversation[],
  filter: InboxFilter,
  profileId: string | null | undefined
): Conversation[] {
  if (filter === 'all') return list;
  if (filter === 'unread') return list.filter((c) => c.unread_count > 0);
  if (filter === 'mine') {
    return profileId
      ? list.filter(
          (c) => c.assigned_agent_id === profileId && c.status !== 'closed'
        )
      : [];
  }
  return list.filter((c) => c.status === filter);
}
