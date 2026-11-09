-- 091_rollback.sql: undo 091_lead_handling.sql. The apply script saves deals and the queue to backups/ first.
-- Restored deals still in the stage the batch gave them go back to Lost, unless someone has worked them since: a logged
-- follow-up, a normal assignment or a stage a person set keeps them where they are.
UPDATE public.deals d SET stage_id = lost.id
  FROM public.lost_restore_queue q, public.pipeline_stages cur, public.pipeline_stages prior, public.pipeline_stages lost
 WHERE q.deal_id = d.id AND q.restored_at IS NOT NULL
   AND cur.id = d.stage_id AND prior.id = q.prior_stage_id AND cur.name = prior.name
   AND lost.pipeline_id = d.pipeline_id AND lost.name = 'Lost'
   AND NOT EXISTS (SELECT 1 FROM public.follow_up_entries f WHERE f.contact_id = q.contact_id AND f.occurred_at >= q.restored_at)
   AND NOT EXISTS (SELECT 1 FROM public.counsellor_assignments a WHERE a.contact_id = q.contact_id)
   AND NOT EXISTS (SELECT 1 FROM public.deal_stage_events e WHERE e.deal_id = d.id AND e.changed_by IS NOT NULL AND e.changed_at >= q.restored_at);

DROP FUNCTION IF EXISTS public.restore_lost_batch(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.queue_lost_restore(uuid, timestamptz, integer, integer);
DROP FUNCTION IF EXISTS public.counsellor_lead_list(uuid);
DROP FUNCTION IF EXISTS public.my_assigned_conversation_ids();
DROP FUNCTION IF EXISTS public.counsellor_current_leads(uuid);
DROP TABLE IF EXISTS public.lost_restore_queue;

-- The sweep exactly as it was before 091.
CREATE OR REPLACE FUNCTION public.lifecycle_sweep(p_account_id uuid, p_lost_after_days integer DEFAULT 14)
 RETURNS TABLE(deal_id uuid, contact_id uuid, from_stage text, to_stage text)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_intake_id uuid;
  v_app_started_pos integer;
BEGIN
  SELECT id INTO v_intake_id FROM pipelines
    WHERE account_id = p_account_id AND name = 'Student Admissions';
  IF v_intake_id IS NULL THEN
    RAISE EXCEPTION 'lifecycle_sweep: % has no "Student Admissions" intake pipeline — the first argument must be an ACCOUNT id (changed in migration 047)', p_account_id;
  END IF;

  SELECT position INTO v_app_started_pos FROM pipeline_stages
    WHERE pipeline_id = v_intake_id AND name = 'Application Started';
  IF v_app_started_pos IS NULL THEN
    RAISE EXCEPTION 'lifecycle_sweep: intake pipeline is missing "Application Started"';
  END IF;

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
  WHERE ct.account_id = p_account_id
  GROUP BY ct.id, ct.account_id, ct.user_id, ct.phone, ct.university;

  ALTER TABLE _lifecycle_signals
    ADD COLUMN target_pipeline_id uuid,
    ADD COLUMN floor_name text,
    ADD COLUMN floor_pos integer,
    ADD COLUMN stale boolean;

  -- Route target. A roll number pins the university (the enrollment code is
  -- part of the permanent id), so it outranks conversational interest, which
  -- can flap. Unresolved or unrecognised falls back to intake.
  UPDATE _lifecycle_signals s SET target_pipeline_id = COALESCE(
    (SELECT p.id FROM pipelines p
      WHERE p.account_id = p_account_id
        AND p.name = (
          SELECT CASE ct.university
            WHEN 'LPU' THEN 'LPU Admissions'
            WHEN 'AMI' THEN 'Amity Admissions'
            WHEN 'DBU' THEN 'DBU Admissions'
          END
          FROM contacts ct WHERE ct.id = s.cid AND s.roll_issued
        )),
    (SELECT p.id FROM pipelines p
      WHERE p.account_id = p_account_id
        AND p.name = (
          SELECT c.interest_university || ' Admissions' FROM conversations c
          WHERE c.contact_id = s.cid AND c.interest_updated_at IS NOT NULL
          ORDER BY c.interest_updated_at DESC LIMIT 1
        )),
    v_intake_id);

  UPDATE _lifecycle_signals s SET
    floor_name = CASE
      WHEN s.roll_issued THEN 'Application Started'
      WHEN s.agent_reply THEN 'Counselor Active'
      WHEN s.univ_resolved THEN 'Qualified'
      WHEN s.bot_reply THEN 'Engaged'
      ELSE 'New Lead'
    END,
    stale = COALESCE(s.last_customer_at, s.newest_conv_at)
              < now() - make_interval(days => p_lost_after_days);
  UPDATE _lifecycle_signals s SET floor_pos =
    (SELECT position FROM pipeline_stages
      WHERE pipeline_id = v_intake_id AND name = s.floor_name);

  -- Step 1: every contact with a conversation gets a deal, created directly
  -- in its target pipeline.
  RETURN QUERY
  WITH ins AS (
    INSERT INTO deals (account_id, user_id, pipeline_id, contact_id,
                       conversation_id, title, stage_id, currency, value, notes)
    SELECT s.account_id, s.user_id, s.target_pipeline_id, s.cid,
           (SELECT cv.id FROM conversations cv WHERE cv.contact_id = s.cid
             ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1),
           'Lead - ' || s.phone,
           (SELECT id FROM pipeline_stages
             WHERE pipeline_id = s.target_pipeline_id AND name = 'New Lead'),
           'INR', 0, 'Source: organic'
    FROM _lifecycle_signals s
    WHERE NOT EXISTS (SELECT 1 FROM deals d
                       WHERE d.contact_id = s.cid AND d.account_id = p_account_id)
    RETURNING deals.id, deals.contact_id
  )
  SELECT ins.id, ins.contact_id, NULL::text, 'New Lead'::text FROM ins;

  -- Step 2: route existing deals to the pipeline their university points at,
  -- keeping the stage by name. Lost never routes; Application Started+
  -- routes only on the roll number (interest flapping cannot move them).
  RETURN QUERY
  WITH upd AS (
    UPDATE deals d SET
      pipeline_id = s.target_pipeline_id,
      stage_id = tgt.id
    FROM _lifecycle_signals s, pipeline_stages cur, pipeline_stages tgt
    WHERE d.account_id = p_account_id
      AND d.contact_id = s.cid
      AND d.pipeline_id <> s.target_pipeline_id
      AND cur.id = d.stage_id
      AND (cur.position < v_app_started_pos OR s.roll_issued)
      AND cur.name <> 'Lost'
      AND tgt.pipeline_id = s.target_pipeline_id
      AND tgt.name = cur.name
    RETURNING d.id, d.contact_id, cur.name
  )
  SELECT upd.id, upd.contact_id, upd.name, upd.name FROM upd;

  -- Step 3: revive Lost deals whose contact messaged after the Lost
  -- transition and within the Lost window.
  RETURN QUERY
  WITH upd AS (
    UPDATE deals d SET stage_id = f.id
    FROM _lifecycle_signals s, pipeline_stages cur, pipeline_stages f
    WHERE d.account_id = p_account_id
      AND d.contact_id = s.cid
      AND cur.id = d.stage_id
      AND cur.name = 'Lost'
      AND f.pipeline_id = d.pipeline_id
      AND f.name = s.floor_name
      AND s.last_customer_at > d.updated_at
      AND s.last_customer_at >= now() - make_interval(days => p_lost_after_days)
    RETURNING d.id, d.contact_id, s.floor_name
  )
  SELECT upd.id, upd.contact_id, 'Lost'::text, upd.floor_name FROM upd;

  -- Step 4: mark stale deals Lost (below Application Started only).
  RETURN QUERY
  WITH upd AS (
    UPDATE deals d SET stage_id = lost.id
    FROM _lifecycle_signals s, pipeline_stages cur, pipeline_stages lost
    WHERE d.account_id = p_account_id
      AND d.contact_id = s.cid
      AND cur.id = d.stage_id
      AND cur.position < v_app_started_pos
      AND lost.pipeline_id = d.pipeline_id
      AND lost.name = 'Lost'
      AND s.stale
    RETURNING d.id, d.contact_id, cur.name
  )
  SELECT upd.id, upd.contact_id, upd.name, 'Lost'::text FROM upd;

  -- Step 5: forward-only advance to the signal floor within the deal's own
  -- pipeline. Position comparison excludes Lost and Enrolled as before.
  RETURN QUERY
  WITH upd AS (
    UPDATE deals d SET stage_id = f.id
    FROM _lifecycle_signals s, pipeline_stages cur, pipeline_stages f
    WHERE d.account_id = p_account_id
      AND d.contact_id = s.cid
      AND cur.id = d.stage_id
      AND f.pipeline_id = d.pipeline_id
      AND f.name = s.floor_name
      AND cur.position < s.floor_pos
    RETURNING d.id, d.contact_id, cur.name, s.floor_name
  )
  SELECT upd.id, upd.contact_id, upd.name, upd.floor_name FROM upd;

  DROP TABLE _lifecycle_signals;
END;
$function$;

ALTER TABLE public.deals DROP COLUMN IF EXISTS lost_snooze_until;
