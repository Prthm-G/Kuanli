-- 041_lead_queue.sql
-- KB-QUEUE-R4-23
--
-- Read model for the counsellor work queue (roadmap item 3): one row per
-- workable deal with the raw signals the scoring function in
-- `wacrm/src/lib/queue/score.ts` combines. Scoring lives in TypeScript on
-- purpose — the weights are unit-tested and tunable without a migration; this
-- function only gathers facts.
--
-- Why an RPC instead of PostgREST joins: the queue needs per-contact message
-- aggregates (customer message count, last inbound, last human reply) across
-- every conversation the contact has (migration 037 allows one per business
-- number). That is a three-level aggregate PostgREST cannot express, and
-- pulling all messages to the client to count them would ship the whole
-- message history on every queue load.
--
-- Scope: deals in every stage except Enrolled (done) and Lost (dead — the
-- lifecycle sweep from migration 039 revives them on contact, at which point
-- they reappear here). Interest fields come from the conversation whose
-- interest_updated_at is newest; the deep-link conversation is the one with
-- the most recent message.
--
-- Security: SECURITY DEFINER with the same authorization convention as
-- update_contact_enrollment (migration 026) — auth.uid() required, membership
-- in the target account checked via is_account_member (migration 017).
-- Read-only, so 'viewer' is enough. EXECUTE for authenticated only.
--
-- Rollback: DROP FUNCTION IF EXISTS public.lead_queue(uuid);

CREATE OR REPLACE FUNCTION public.lead_queue(p_account_id uuid)
RETURNS TABLE (
  deal_id uuid,
  contact_id uuid,
  conversation_id uuid,
  name text,
  phone text,
  roll_number text,
  stage_name text,
  stage_position integer,
  interest_university text,
  interest_mode text,
  interest_course text,
  interest_specialization text,
  ad_headline text,
  ad_body text,
  customer_messages bigint,
  last_customer_at timestamptz,
  last_agent_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    d.id,
    ct.id,
    conv.id,
    ct.name,
    ct.phone,
    ct.roll_number,
    ps.name,
    ps.position,
    intr.interest_university,
    intr.interest_mode,
    intr.interest_course,
    intr.interest_specialization,
    ct.ad_headline,
    ct.ad_body,
    COALESCE(msg.customer_messages, 0),
    msg.last_customer_at,
    msg.last_agent_at
  FROM deals d
  JOIN pipeline_stages ps ON ps.id = d.stage_id
  JOIN contacts ct ON ct.id = d.contact_id
  LEFT JOIN LATERAL (
    SELECT c.id FROM conversations c
    WHERE c.contact_id = ct.id
    ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1
  ) conv ON true
  LEFT JOIN LATERAL (
    SELECT c.interest_university, c.interest_mode, c.interest_course,
           c.interest_specialization
    FROM conversations c
    WHERE c.contact_id = ct.id AND c.interest_updated_at IS NOT NULL
    ORDER BY c.interest_updated_at DESC LIMIT 1
  ) intr ON true
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE m.sender_type = 'customer') AS customer_messages,
      max(m.created_at) FILTER (WHERE m.sender_type = 'customer') AS last_customer_at,
      max(m.created_at) FILTER (WHERE m.sender_type = 'agent') AS last_agent_at
    FROM messages m
    JOIN conversations c2 ON c2.id = m.conversation_id
    WHERE c2.contact_id = ct.id
  ) msg ON true
  WHERE d.account_id = p_account_id
    AND ps.name NOT IN ('Enrolled', 'Lost');
END;
$$;

ALTER FUNCTION public.lead_queue(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lead_queue(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lead_queue(uuid) TO authenticated;
