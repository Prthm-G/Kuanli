import type { Conversation } from "@/types";

function activityTime(conversation: Conversation): number {
  const lastMessageTime = conversation.last_message_at
    ? Date.parse(conversation.last_message_at)
    : Number.NaN;

  if (Number.isFinite(lastMessageTime)) return lastMessageTime;

  const createdTime = Date.parse(conversation.created_at);
  return Number.isFinite(createdTime) ? createdTime : 0;
}

/**
 * Return a new list ordered by actual conversation activity.
 *
 * PostgreSQL sorts NULL values first for a descending order unless asked
 * otherwise. Falling back to created_at also keeps a just-created
 * conversation visible until its first message trigger updates the summary.
 */
export function sortConversationsByActivity(
  conversations: readonly Conversation[],
): Conversation[] {
  return [...conversations].sort((a, b) => {
    const timeDifference = activityTime(b) - activityTime(a);
    return timeDifference || a.id.localeCompare(b.id);
  });
}
