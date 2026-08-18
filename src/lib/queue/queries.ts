import type { SupabaseClient } from "@supabase/supabase-js";

import { scoreLead, compareByScore } from "./score";
import type { QueueLead } from "./types";

/**
 * Load the scored counsellor work queue via the `lead_queue` RPC
 * (migration 041). The RPC authorizes the caller against the account
 * (is_account_member) and returns one row per workable deal — every stage
 * except Enrolled and Lost — with per-contact message aggregates PostgREST
 * cannot express. Scoring and ordering happen here so the weights stay in
 * tested TypeScript.
 */
export async function loadLeadQueue(
  supabase: SupabaseClient,
  accountId: string,
  now: Date = new Date(),
): Promise<QueueLead[]> {
  const { data, error } = await supabase.rpc("lead_queue", {
    p_account_id: accountId,
  });

  if (error) throw new Error(`Lead queue query failed: ${error.message}`);

  // PostgREST results are typed loosely by the client; the codebase's
  // convention (see lib/dashboard/queries.ts) is to assert the shape once.
  type Raw = {
    deal_id: string;
    contact_id: string;
    conversation_id: string | null;
    name: string | null;
    phone: string | null;
    roll_number: string | null;
    stage_name: string;
    stage_position: number;
    interest_university: string | null;
    interest_mode: string | null;
    interest_course: string | null;
    interest_specialization: string | null;
    ad_headline: string | null;
    ad_body: string | null;
    customer_messages: number;
    last_customer_at: string | null;
    last_agent_at: string | null;
  };

  const leads: QueueLead[] = ((data ?? []) as unknown as Raw[]).map((r) => ({
    dealId: r.deal_id,
    contactId: r.contact_id,
    conversationId: r.conversation_id ?? null,
    name: r.name ?? null,
    phone: r.phone ?? null,
    rollNumber: r.roll_number ?? null,
    stageName: r.stage_name,
    stagePosition: r.stage_position,
    university: r.interest_university ?? null,
    mode: r.interest_mode ?? null,
    course: r.interest_course ?? null,
    specialization: r.interest_specialization ?? null,
    adHeadline: r.ad_headline ?? null,
    adBody: r.ad_body ?? null,
    customerMessages: Number(r.customer_messages ?? 0),
    lastCustomerAt: r.last_customer_at ?? null,
    lastAgentAt: r.last_agent_at ?? null,
    score: scoreLead(
      {
        customerMessages: Number(r.customer_messages ?? 0),
        hasUniversity: !!r.interest_university,
        hasCourse: !!r.interest_course,
        hasSpecialization: !!r.interest_specialization,
        lastCustomerAt: r.last_customer_at ? new Date(r.last_customer_at) : null,
        lastAgentAt: r.last_agent_at ? new Date(r.last_agent_at) : null,
      },
      now,
    ),
  }));

  leads.sort(compareByScore);
  return leads;
}
