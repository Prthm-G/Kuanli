import type { SupabaseClient } from "@supabase/supabase-js";

import { loadOverdueCount } from "../followups/queries";
import { resolveRange, type EodPeriod } from "./period";
import {
  summarise,
  type EodReport,
  type EodRow,
  type FollowUpActivity,
} from "./types";

/**
 * Conversations started in the window, with the lead's inferred interest.
 *
 * The interest columns are the read model migration 038 added; n8n mirrors them
 * out of `bot_conversation_state` as the bot resolves them. Rows with nothing
 * resolved are returned deliberately — a lead who opened a chat and never got
 * as far as naming a university is exactly what an end-of-day review is for.
 *
 * RLS scopes `conversations` to the caller's account (migration 017), so no
 * account predicate is needed here; the explicit `account_id` filter is kept
 * anyway so the query is correct on its own terms and can use the
 * (account_id, created_at) index from migration 038.
 */
export async function loadEodReport(
  supabase: SupabaseClient,
  accountId: string,
  period: EodPeriod,
  now: Date = new Date(),
): Promise<EodReport> {
  const { start, end } = resolveRange(period, now);

  const { data, error } = await supabase
    .from("conversations")
    .select(
      "id, contact_id, status, created_at, phone_number_id, " +
        "interest_university, interest_mode, interest_course, " +
        "contact:contacts(name, phone, roll_number)",
    )
    .eq("account_id", accountId)
    .gte("created_at", start.toISOString())
    .lt("created_at", end.toISOString())
    .order("created_at", { ascending: false });

  if (error) throw new Error(`EOD report query failed: ${error.message}`);

  // PostgREST results are typed loosely by the client; the codebase's
  // convention (see lib/dashboard/queries.ts) is to assert the shape once.
  type Raw = {
    id: string;
    contact_id: string | null;
    status: string | null;
    created_at: string;
    phone_number_id: string | null;
    interest_university: string | null;
    interest_mode: string | null;
    interest_course: string | null;
    contact:
      | { name: string | null; phone: string | null; roll_number: string | null }
      | Array<{ name: string | null; phone: string | null; roll_number: string | null }>
      | null;
  };

  const rows: EodRow[] = ((data ?? []) as unknown as Raw[]).map((r) => {
    // PostgREST returns an embedded to-one relation as an object, but types it
    // loosely; normalise the array case rather than trusting the shape.
    const c = Array.isArray(r.contact) ? r.contact[0] : r.contact;
    return {
      conversationId: r.id,
      contactId: r.contact_id ?? null,
      name: c?.name ?? null,
      phone: c?.phone ?? null,
      university: r.interest_university ?? null,
      mode: r.interest_mode ?? null,
      course: r.interest_course ?? null,
      rollNumber: c?.roll_number ?? null,
      phoneNumberId: r.phone_number_id ?? null,
      status: r.status ?? null,
      createdAt: r.created_at,
    };
  });

  return {
    rows,
    summary: summarise(rows),
    followups: await loadFollowUpActivity(supabase, accountId, start, end),
  };
}

/**
 * Follow-up activity for the EOD report (migration 054).
 *
 * Two counts, deliberately asymmetric:
 *   logged  — entries filed inside the report window. Windowed, because "what
 *             did we do today" is the question the report answers.
 *   overdue — commitments past their date right now. NOT windowed: a promise
 *             broken last week is still broken today, and hiding it because
 *             the report is scoped to today would defeat the point.
 *
 * `overdue` goes through the `follow_up_overdue_count` RPC rather than a
 * `next_due_at < now()` filter here. Two reasons, both of which produce a
 * plausible-looking wrong number otherwise:
 *
 *   Only a contact's NEWEST entry is live — a later log line settles whatever
 *   an earlier one promised — and PostgREST cannot express "newest per
 *   contact". A flat filter would count every commitment ever made and climb
 *   forever.
 *
 *   This function runs on the cron path too (/api/reports/eod, service-role
 *   client, no user session), where `follow_up_worklist` would raise 42501.
 *   The RPC accepts service_role explicitly.
 *
 * Neither failure takes the report down: the conversation rows are the
 * report's reason to exist, so a broken count falls back to zero.
 */
async function loadFollowUpActivity(
  supabase: SupabaseClient,
  accountId: string,
  start: Date,
  end: Date,
): Promise<FollowUpActivity> {
  const [logged, overdue] = await Promise.all([
    supabase
      .from("follow_up_entries")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .gte("occurred_at", start.toISOString())
      .lt("occurred_at", end.toISOString()),
    loadOverdueCount(supabase, accountId).catch(() => 0),
  ]);

  return {
    logged: logged.error ? 0 : (logged.count ?? 0),
    overdue,
  };
}
