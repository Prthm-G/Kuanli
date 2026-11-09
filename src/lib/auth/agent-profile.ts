import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * `conversations.assigned_agent_id` holds a `profiles.id`. The automation
 * builder's agent picker stores the member's auth user id, and older configs
 * may hold either, so the engines resolve whatever they were given to the
 * profile id of a member of the same account. Anything else gives null and
 * nothing is written.
 */
export async function resolveAgentProfileId(
  db: SupabaseClient,
  accountId: string,
  idOrUserId: string | null | undefined
): Promise<string | null> {
  if (!idOrUserId) return null;
  for (const column of ['user_id', 'id'] as const) {
    const { data } = await db
      .from('profiles')
      .select('id')
      .eq('account_id', accountId)
      .eq(column, idOrUserId)
      .maybeSingle();
    const id = (data as { id: string } | null)?.id;
    if (id) return id;
  }
  return null;
}
