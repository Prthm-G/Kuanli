-- 039_lead_lifecycle_sweep.sql
-- KB-LIFECYCLE-R4-21
--
-- Signal-driven lead lifecycle: one idempotent sweep function that moves deals
-- through the pipeline off state that already exists, instead of the per-message
-- regex in `Deterministic Stage Guard`, which is why the board was flat (the
-- regex needs university + program keyword in a single text; university is
-- picked via buttons, so "Qualified" never fired, and agent replies from the
-- inbox never touched stages at all).
--
-- Signals, measured against the live DB on 2026-08-18 before writing this:
--   conversation exists, nothing else       -> New Lead            (2 contacts)
--   bot replied                             -> Engaged             (2)
--   interest_university resolved (mig 038)  -> Qualified           (20)
--   human agent message in any thread       -> Counselor Active    (40)
--   real roll number issued (mig 026)       -> Application Started (1)
--   no customer reply in 14 days            -> Lost
--
-- The Lost threshold is operator-chosen (14d) from pre-purge history: of 478
-- reply gaps over 8 weeks, only 2.1% of replies arrived after >7d of silence,
-- and the set of conversations silent >5d was identical to the set silent >14d
-- (50 of 100) — leads are active within ~3 days or gone for weeks.
--
-- Rules:
--   * Forward-only: the signal ladder never regresses a deal, so a manual drag
--     forward is respected. A manual drag backward will be re-advanced.
--   * Lost applies only below Application Started. A lead with a roll number
--     that goes quiet is a follow-up problem, not a dead lead; Enrolled is
--     never touched.
--   * Revive: a Lost deal whose contact sent a message AFTER the deal was last
--     touched (updated_at), and within the Lost window, returns to whatever
--     stage its signals justify. The updated_at guard stops the sweep from
--     un-Losting an explicit "stop contacting me" — that message predates the
--     regex guard's own Lost transition. It also means a revive can only
--     happen once per silence spell, so stale deals cannot flap.
--   * Step 1 also inserts a New Lead deal for any contact with a conversation
--     but no deal (47 of 65 at time of writing — broadcast-only threads never
--     pass through `Auto-Stage Pipeline`, which only runs on inbound). The
--     sweep is therefore self-healing; the initial backfill is just its first
--     run.
--
-- Caller: the scheduled n8n workflow "Kuanli Lifecycle Sweep" runs
--   SELECT * FROM lifecycle_sweep('1baab0e7-...', 14);
-- over the existing WACRM Database credential (supabase_admin). Not exposed as
-- a PostgREST RPC: EXECUTE is revoked from PUBLIC and never granted to
-- anon/authenticated.
--
-- Rollback: DROP FUNCTION IF EXISTS public.lifecycle_sweep(uuid, integer);

CREATE OR REPLACE FUNCTION public.lifecycle_sweep(
  p_pipeline_id uuid,
  p_lost_after_days integer DEFAULT 14
) RETURNS TABLE (deal_id uuid, contact_id uuid, from_stage text, to_stage text)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_new_lead_id uuid;
  v_app_started_pos integer;
  v_lost_id uuid;
  v_owner_user_id uuid;
BEGIN
  SELECT id INTO v_new_lead_id FROM pipeline_stages
    WHERE pipeline_id = p_pipeline_id AND name = 'New Lead';
  SELECT position INTO v_app_started_pos FROM pipeline_stages
    WHERE pipeline_id = p_pipeline_id AND name = 'Application Started';
  SELECT id INTO v_lost_id FROM pipeline_stages
    WHERE pipeline_id = p_pipeline_id AND name = 'Lost';
  SELECT user_id INTO v_owner_user_id FROM pipelines WHERE id = p_pipeline_id;

  IF v_new_lead_id IS NULL OR v_app_started_pos IS NULL OR v_lost_id IS NULL THEN
    RAISE EXCEPTION 'lifecycle_sweep: pipeline % is missing a required stage', p_pipeline_id;
  END IF;

  -- Per-contact signal snapshot, shared by every step below.
  CREATE TEMP TABLE _lifecycle_signals ON COMMIT DROP AS
  SELECT
    ct.id AS cid,
    ct.account_id,
    ct.user_id,
    ct.phone,
    bool_or(cv.interest_university IS NOT NULL) AS univ_resolved,
    ct.university IS NOT NULL AS roll_issued,
    max(cv.created_at) AS newest_conv_at,
    bool_or(msg.bot_reply) AS bot_reply,
    bool_or(msg.agent_reply) AS agent_reply,
    max(msg.last_customer_at) AS last_customer_at
  FROM contacts ct
  JOIN conversations cv ON cv.contact_id = ct.id
  LEFT JOIN LATERAL (
    SELECT
      bool_or(m.sender_type = 'bot') AS bot_reply,
      bool_or(m.sender_type = 'agent') AS agent_reply,
      max(m.created_at) FILTER (WHERE m.sender_type = 'customer') AS last_customer_at
    FROM messages m WHERE m.conversation_id = cv.id
  ) msg ON true
  WHERE ct.user_id = v_owner_user_id
  GROUP BY ct.id, ct.account_id, ct.user_id, ct.phone, ct.university;

  ALTER TABLE _lifecycle_signals
    ADD COLUMN floor_stage_id uuid,
    ADD COLUMN floor_stage_name text,
    ADD COLUMN floor_stage_pos integer,
    ADD COLUMN stale boolean;

  UPDATE _lifecycle_signals s SET
    floor_stage_name = f.name,
    floor_stage_id = f.id,
    floor_stage_pos = f.position,
    stale = COALESCE(s.last_customer_at, s.newest_conv_at)
              < now() - make_interval(days => p_lost_after_days)
  FROM pipeline_stages f
  WHERE f.pipeline_id = p_pipeline_id
    AND f.name = CASE
      WHEN s.roll_issued THEN 'Application Started'
      WHEN s.agent_reply THEN 'Counselor Active'
      WHEN s.univ_resolved THEN 'Qualified'
      WHEN s.bot_reply THEN 'Engaged'
      ELSE 'New Lead'
    END;

  -- Step 1: every contact with a conversation gets a deal. Same shape as the
  -- insert in the `Auto-Stage Pipeline` n8n node.
  RETURN QUERY
  WITH ins AS (
    INSERT INTO deals (account_id, user_id, pipeline_id, contact_id,
                       conversation_id, title, stage_id, currency, value, notes)
    SELECT s.account_id, s.user_id, p_pipeline_id, s.cid,
           (SELECT cv.id FROM conversations cv WHERE cv.contact_id = s.cid
             ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1),
           'Lead - ' || s.phone, v_new_lead_id, 'INR', 0, 'Source: organic'
    FROM _lifecycle_signals s
    WHERE NOT EXISTS (SELECT 1 FROM deals d
                       WHERE d.contact_id = s.cid AND d.pipeline_id = p_pipeline_id)
    RETURNING deals.id, deals.contact_id
  )
  SELECT ins.id, ins.contact_id, NULL::text, 'New Lead'::text FROM ins;

  -- Step 2: revive Lost deals whose contact messaged after the Lost transition
  -- and within the Lost window.
  RETURN QUERY
  WITH upd AS (
    UPDATE deals d SET stage_id = s.floor_stage_id
    FROM _lifecycle_signals s
    WHERE d.pipeline_id = p_pipeline_id
      AND d.contact_id = s.cid
      AND d.stage_id = v_lost_id
      AND s.last_customer_at > d.updated_at
      AND s.last_customer_at >= now() - make_interval(days => p_lost_after_days)
    RETURNING d.id, d.contact_id, s.floor_stage_name
  )
  SELECT upd.id, upd.contact_id, 'Lost'::text, upd.floor_stage_name FROM upd;

  -- Step 3: mark stale deals Lost. Only below Application Started.
  RETURN QUERY
  WITH upd AS (
    UPDATE deals d SET stage_id = v_lost_id
    FROM _lifecycle_signals s, pipeline_stages cur
    WHERE d.pipeline_id = p_pipeline_id
      AND d.contact_id = s.cid
      AND cur.id = d.stage_id
      AND cur.position < v_app_started_pos
      AND s.stale
    RETURNING d.id, d.contact_id, cur.name
  )
  SELECT upd.id, upd.contact_id, upd.name, 'Lost'::text FROM upd;

  -- Step 4: forward-only advance to the signal floor. Position comparison
  -- already excludes Lost and Enrolled (both sit above Application Started).
  RETURN QUERY
  WITH upd AS (
    UPDATE deals d SET stage_id = s.floor_stage_id
    FROM _lifecycle_signals s, pipeline_stages cur
    WHERE d.pipeline_id = p_pipeline_id
      AND d.contact_id = s.cid
      AND cur.id = d.stage_id
      AND cur.position < s.floor_stage_pos
    RETURNING d.id, d.contact_id, cur.name, s.floor_stage_name
  )
  SELECT upd.id, upd.contact_id, upd.name, upd.floor_stage_name FROM upd;

  DROP TABLE _lifecycle_signals;
END;
$$;

ALTER FUNCTION public.lifecycle_sweep(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lifecycle_sweep(uuid, integer) FROM PUBLIC;
