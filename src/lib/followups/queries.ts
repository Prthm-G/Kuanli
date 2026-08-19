import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  FollowUpMethod,
  FollowUpOutcome,
  NewFollowUp,
  TimelineItem,
  WorklistRow,
} from './types';

/**
 * Open commitments across the account, via the `follow_up_worklist` RPC
 * (migration 054). The RPC authorizes the caller (is_account_member) and
 * returns one row per contact whose newest entry promised a next step.
 * Bucketing into Overdue / Today / … happens in `due.ts`, in the viewer's
 * timezone.
 */
export async function loadWorklist(
  supabase: SupabaseClient,
  accountId: string
): Promise<WorklistRow[]> {
  const { data, error } = await supabase.rpc('follow_up_worklist', {
    p_account_id: accountId,
  });

  if (error)
    throw new Error(`Follow-up worklist query failed: ${error.message}`);

  // PostgREST results are typed loosely by the client; the codebase's
  // convention (see lib/queue/queries.ts) is to assert the shape once.
  type Raw = {
    contact_id: string;
    entry_id: string;
    conversation_id: string | null;
    name: string | null;
    phone: string | null;
    roll_number: string | null;
    university: string | null;
    stage_name: string | null;
    occurred_at: string;
    method: FollowUpMethod;
    outcome: FollowUpOutcome | null;
    summary: string;
    next_due_at: string;
    next_method: FollowUpMethod | null;
    logged_by: string;
    logged_by_name: string | null;
  };

  return ((data ?? []) as unknown as Raw[]).map((r) => ({
    contactId: r.contact_id,
    entryId: r.entry_id,
    conversationId: r.conversation_id ?? null,
    name: r.name ?? null,
    phone: r.phone ?? null,
    rollNumber: r.roll_number ?? null,
    university: r.university ?? null,
    stageName: r.stage_name ?? null,
    occurredAt: r.occurred_at,
    method: r.method,
    outcome: r.outcome ?? null,
    summary: r.summary,
    nextDueAt: r.next_due_at,
    nextMethod: r.next_method ?? null,
    loggedBy: r.logged_by,
    loggedByName: r.logged_by_name ?? null,
  }));
}

/**
 * One contact's history: manual entries merged with the automated ladder's
 * sends (migration 044), newest first. `source` tells them apart.
 */
export async function loadTimeline(
  supabase: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<TimelineItem[]> {
  const { data, error } = await supabase.rpc('follow_up_timeline', {
    p_account_id: accountId,
    p_contact_id: contactId,
  });

  if (error)
    throw new Error(`Follow-up timeline query failed: ${error.message}`);

  type Raw = {
    source: 'manual' | 'auto';
    entry_id: string;
    occurred_at: string;
    method: FollowUpMethod | null;
    outcome: FollowUpOutcome | null;
    summary: string;
    next_due_at: string | null;
    next_method: FollowUpMethod | null;
    actor_name: string | null;
  };

  return ((data ?? []) as unknown as Raw[]).map((r) => ({
    source: r.source,
    entryId: r.entry_id,
    occurredAt: r.occurred_at,
    method: r.method ?? null,
    outcome: r.outcome ?? null,
    summary: r.summary,
    nextDueAt: r.next_due_at ?? null,
    nextMethod: r.next_method ?? null,
    actorName: r.actor_name ?? null,
  }));
}

/**
 * File a follow-up entry. `logged_by` is set from the session rather than
 * passed in: the RLS INSERT policy requires `logged_by = auth.uid()`, so a
 * caller cannot file under someone else's name even if it tried.
 */
export async function logFollowUp(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  entry: NewFollowUp
): Promise<void> {
  const { error } = await supabase.from('follow_up_entries').insert({
    account_id: accountId,
    contact_id: entry.contactId,
    conversation_id: entry.conversationId ?? null,
    occurred_at: entry.occurredAt ?? new Date().toISOString(),
    method: entry.method,
    outcome: entry.outcome ?? null,
    summary: entry.summary.trim(),
    next_due_at: entry.nextDueAt ?? null,
    // The DB rejects a next_method without a next_due_at; drop it here so a
    // half-filled form fails as a validation message, not a 23514.
    next_method: entry.nextDueAt ? (entry.nextMethod ?? null) : null,
    logged_by: userId,
  });

  if (error) throw new Error(`Could not log follow-up: ${error.message}`);
}

/** Delete an entry. RLS allows this for the author and for admins. */
export async function deleteFollowUp(
  supabase: SupabaseClient,
  entryId: string
): Promise<void> {
  const { error } = await supabase
    .from('follow_up_entries')
    .delete()
    .eq('id', entryId);

  if (error) throw new Error(`Could not delete follow-up: ${error.message}`);
}

/**
 * Overdue commitment count via the `follow_up_overdue_count` RPC.
 *
 * Separate from `loadWorklist` because the EOD report needs this number on the
 * cron path, where there is no user session and the worklist RPC refuses.
 * See the migration 054 header for the two-branch authorization.
 */
export async function loadOverdueCount(
  supabase: SupabaseClient,
  accountId: string
): Promise<number> {
  const { data, error } = await supabase.rpc('follow_up_overdue_count', {
    p_account_id: accountId,
  });

  if (error) throw new Error(`Overdue count query failed: ${error.message}`);

  return Number(data ?? 0);
}
