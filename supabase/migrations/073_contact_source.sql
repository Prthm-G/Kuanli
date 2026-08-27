-- 073_contact_source.sql
-- KB-STUPROF-R7-57: lead source becomes STORED on contacts instead of derived.
--
-- Until now "where did this lead come from" was answered by deriving from
-- ad_headline/ad_body ("Ad" when either is set, else "Organic") in the queue
-- and pipelines pages. That derivation cannot express the two sources that
-- never touch WhatsApp attribution — a walk-in at the office, or a personal
-- reference — and it can never be corrected, because the first-touch ad
-- columns are deliberately never cleared.
--
-- `source` is the CHANNEL record (organic | ads | reference | walkin);
-- ad_headline/ad_body remain the AD-CREATIVE record, written only by the n8n
-- bot with first-touch COALESCE semantics (migration 040) — that contract is
-- untouched. `source_detail` carries the referrer's name when source is
-- 'reference' (free text; no CHECK tying it to reference — a note on a
-- walk-in is harmless and a constraint would fight counsellors).
--
-- The lead_queue RPC (migration 041) gains a `source` column. A return-type
-- change forbids CREATE OR REPLACE (42P13), so the function is dropped and
-- recreated; the body is 041's verbatim plus ct.source.
--
-- RLS: no change — contacts UPDATE already requires agent; the webhook
-- writes via service role.
-- Idempotent — safe to run multiple times.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'organic'
  CONSTRAINT contacts_source_check CHECK (source IN ('organic', 'ads', 'reference', 'walkin'));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_detail TEXT;

-- Backfill: rows that predate this column were stamped 'organic' by the
-- default; flip the ones the old derivation would have called an ad.
-- Idempotent: the predicate excludes rows already flipped or manually set.
UPDATE contacts SET source = 'ads'
WHERE source = 'organic'
  AND (NULLIF(ad_headline, '') IS NOT NULL OR NULLIF(ad_body, '') IS NOT NULL);

DROP FUNCTION IF EXISTS public.lead_queue(uuid);

CREATE FUNCTION public.lead_queue(p_account_id uuid)
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
  source text,
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
    ct.source,
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

-- Rollback:
--   DROP FUNCTION IF EXISTS public.lead_queue(uuid);
--   (then re-run 041_lead_queue.sql's CREATE to restore the old signature)
--   ALTER TABLE contacts DROP COLUMN IF EXISTS source_detail;
--   ALTER TABLE contacts DROP COLUMN IF EXISTS source;
