-- 093_rollback.sql: undo 093_not_interested_and_lists.sql. The apply script saves deals, stages and assignments to
-- backups/ first. Deals in Not Interested go back to the stage they came from (by name, in the pipeline they are in now),
-- or to Lost when that is unknown. The stage trail of the Not Interested moves is removed with the stage.
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS follow_up_not_interested ON public.follow_up_entries;
DROP FUNCTION IF EXISTS public.follow_up_marks_not_interested();

-- Before any deal moves below: the pre-093 conversion trigger, so moving deals out of Not Interested reports nothing.
CREATE OR REPLACE FUNCTION public.record_conversion_from_deal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  new_stage   TEXT;
  old_stage   TEXT;
  new_pos     INT;
  old_pos     INT;
  ev_name     TEXT;
  conv_id     UUID;
  v_value     NUMERIC;
  v_currency  TEXT;
BEGIN
  SELECT name, position INTO new_stage, new_pos
    FROM pipeline_stages WHERE id = NEW.stage_id;
  IF new_stage IS NULL THEN RETURN NULL; END IF;

  IF TG_OP = 'UPDATE' AND OLD.stage_id IS NOT NULL THEN
    SELECT name, position INTO old_stage, old_pos
      FROM pipeline_stages WHERE id = OLD.stage_id;
  END IF;

  -- Forward-only. A card dragged back and forth must not re-report.
  IF old_pos IS NOT NULL AND new_pos <= old_pos THEN RETURN NULL; END IF;

  -- 'Qualified' no longer reports (085): the bot sets it on most first
  -- messages. LeadSubmitted now comes from the course pick, below.
  ev_name := CASE new_stage
               WHEN 'Application Started' THEN 'InitiateCheckout' -- 075
               WHEN 'Enrolled'           THEN 'Purchase'
               ELSE NULL
             END;
  IF ev_name IS NULL THEN RETURN NULL; END IF;

  -- A ctwa_clid lives on the CONVERSATION, so a deal with none is unreportable.
  -- Prefer the deal's own conversation; fall back to the contact's most recent,
  -- which is how Stage Counselor Active already resolves it.
  conv_id := NEW.conversation_id;
  IF conv_id IS NULL THEN
    SELECT id INTO conv_id FROM conversations
     WHERE contact_id = NEW.contact_id
     ORDER BY last_message_at DESC NULLS LAST LIMIT 1;
  END IF;
  IF conv_id IS NULL THEN RETURN NULL; END IF;

  -- Purchase value: the agreed programme fee from the student's fee plan, NOT
  -- deals.value (which is 0 on every row). One plan per contact
  -- (apply_fee_template deletes any prior), so the ORDER BY is belt-and-braces.
  -- No plan, or a non-positive total, means we cannot report a real value:
  -- queue NOTHING rather than a poisoning INR 0 Purchase.
  IF ev_name = 'Purchase' THEN
    SELECT agreed_total, currency INTO v_value, v_currency
      FROM student_fee_plans
     WHERE contact_id = NEW.contact_id
     ORDER BY created_at DESC
     LIMIT 1;
    IF v_value IS NULL OR v_value <= 0 THEN
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO meta_conversion_events (
    account_id, conversation_id, event_name, event_id, event_time,
    ctwa_clid, value, currency, status
  )
  SELECT NEW.account_id, conv_id, ev_name,
         conv_id::text || ':' || ev_name,   -- MUST match buildEventId()
         now(),
         c.ctwa_clid,
         CASE WHEN ev_name = 'Purchase' THEN v_value ELSE NULL END,
         CASE WHEN ev_name = 'Purchase' THEN COALESCE(v_currency, 'INR') ELSE NULL END,
         'pending'
  FROM conversations c WHERE c.id = conv_id
  ON CONFLICT (event_id) DO NOTHING;   -- already reported, or already queued

  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.restore_lost_batch(p_account_id uuid, p_limit integer DEFAULT 40, p_snooze_days integer DEFAULT 30)
 RETURNS TABLE(deal_id uuid, contact_id uuid, to_stage text, counsellor text)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  r record;
  v_n integer := 0;
  v_stage uuid;
  v_stage_name text;
  v_c uuid;
  v_c_name text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('restore_lost_batch:' || p_account_id::text));
  FOR r IN
    SELECT q.deal_id AS qdeal, q.contact_id AS qcontact, q.prior_stage_id, d.pipeline_id, d.stage_id AS cur_id, cur.name AS cur_name, prior.name AS prior_name
      FROM lost_restore_queue q
      JOIN deals d ON d.id = q.deal_id
      JOIN pipeline_stages cur ON cur.id = d.stage_id
      JOIN pipeline_stages prior ON prior.id = q.prior_stage_id
     WHERE q.account_id = p_account_id AND q.restored_at IS NULL AND q.skipped_reason IS NULL
     ORDER BY q.last_customer_at DESC, q.deal_id
     -- A deal the sweep or a person is changing right now waits for the next batch.
     FOR UPDATE OF d SKIP LOCKED
  LOOP
    EXIT WHEN v_n >= p_limit;
    IF r.cur_name <> 'Lost' THEN
      UPDATE lost_restore_queue q SET skipped_reason = 'not_lost' WHERE q.deal_id = r.qdeal;
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM counsellor_assignments a WHERE a.contact_id = r.qcontact) THEN
      UPDATE lost_restore_queue q SET skipped_reason = 'has_counsellor' WHERE q.deal_id = r.qdeal;
      CONTINUE;
    END IF;
    -- The deal may have changed pipeline since it went Lost: same stage by name, in the pipeline it is in now.
    SELECT s.id, s.name INTO v_stage, v_stage_name FROM pipeline_stages s
     WHERE s.pipeline_id = r.pipeline_id AND s.name = r.prior_name;
    IF v_stage IS NULL THEN
      UPDATE lost_restore_queue q SET skipped_reason = 'no_stage' WHERE q.deal_id = r.qdeal;
      CONTINUE;
    END IF;
    SELECT c.id, c.display_name INTO v_c, v_c_name
      FROM counsellors c
      LEFT JOIN LATERAL (SELECT count(*) AS n FROM lost_restore_queue q WHERE q.counsellor_id = c.id) l ON true
     WHERE c.account_id = p_account_id AND c.active
     ORDER BY l.n, c.created_at, c.id
     LIMIT 1;
    IF v_c IS NULL THEN RAISE EXCEPTION 'restore_lost_batch: no active counsellor'; END IF;

    UPDATE deals d SET stage_id = v_stage, lost_snooze_until = now() + make_interval(days => p_snooze_days)
     WHERE d.id = r.qdeal AND d.stage_id = r.cur_id;
    IF NOT FOUND THEN
      UPDATE lost_restore_queue q SET skipped_reason = 'not_lost' WHERE q.deal_id = r.qdeal;
      CONTINUE;
    END IF;
    UPDATE lost_restore_queue q SET restored_at = now(), counsellor_id = v_c WHERE q.deal_id = r.qdeal;
    v_n := v_n + 1;
    deal_id := r.qdeal; contact_id := r.qcontact; to_stage := v_stage_name; counsellor := v_c_name;
    RETURN NEXT;
  END LOOP;
END $function$;

WITH back AS (
  SELECT d.id AS deal_id,
         COALESCE((SELECT b.id FROM public.deal_stage_events e
                     JOIN public.pipeline_stages f ON f.id = e.from_stage_id
                     JOIN public.pipeline_stages b ON b.pipeline_id = d.pipeline_id AND b.name = f.name AND b.name <> 'Not Interested'
                    WHERE e.deal_id = d.id AND e.to_stage_id = d.stage_id
                    ORDER BY e.changed_at DESC LIMIT 1),
                  (SELECT b.id FROM public.pipeline_stages b WHERE b.pipeline_id = d.pipeline_id AND b.name = 'Lost')) AS stage_id
    FROM public.deals d
    JOIN public.pipeline_stages cur ON cur.id = d.stage_id AND cur.name = 'Not Interested'
)
UPDATE public.deals d SET stage_id = back.stage_id FROM back WHERE d.id = back.deal_id AND back.stage_id IS NOT NULL;

DELETE FROM public.deal_stage_events e
 USING public.pipeline_stages s
 WHERE s.name = 'Not Interested' AND (e.from_stage_id = s.id OR e.to_stage_id = s.id);
-- Fails, and so rolls the whole file back, if a deal is still in one (a pipeline with neither a prior stage nor Lost).
DELETE FROM public.pipeline_stages WHERE name = 'Not Interested';

-- The functions exactly as they were before 093.
CREATE OR REPLACE FUNCTION public.counsellor_current_leads(p_account_id uuid)
 RETURNS TABLE(counsellor_id uuid, conversation_id uuid, contact_id uuid, source text, assigned_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT x.counsellor_id, x.conversation_id, x.contact_id, x.source, x.assigned_at
    FROM (
      (SELECT DISTINCT ON (a.contact_id) a.counsellor_id, a.conversation_id, a.contact_id, 'assigned'::text AS source, a.assigned_at
         FROM counsellor_assignments a
        WHERE a.account_id = p_account_id
        ORDER BY a.contact_id, a.assigned_at DESC)
      UNION ALL
      SELECT q.counsellor_id, q.conversation_id, q.contact_id, 'restored', q.restored_at
        FROM lost_restore_queue q
       WHERE q.account_id = p_account_id AND q.restored_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM counsellor_assignments a WHERE a.contact_id = q.contact_id)
    ) x
    JOIN conversations cv ON cv.id = x.conversation_id
    JOIN counsellors c ON c.id = x.counsellor_id
   -- An owner set by hand wins: a reassigned lead leaves the old counsellor.
   WHERE cv.assigned_agent_id IS NULL OR cv.assigned_agent_id = c.profile_id
$function$;

CREATE OR REPLACE FUNCTION public.my_assigned_conversation_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT l.conversation_id
    FROM profiles p
    JOIN counsellors c ON c.profile_id = p.id
    CROSS JOIN LATERAL counsellor_current_leads(c.account_id) l
   WHERE p.user_id = auth.uid() AND l.counsellor_id = c.id
     -- Marked Lost: done with, so off the counsellor's working list.
     AND NOT EXISTS (SELECT 1 FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id
                      WHERE d.contact_id = l.contact_id AND s.name = 'Lost')
$function$;

CREATE OR REPLACE FUNCTION public.counsellor_lead_list(p_account_id uuid)
 RETURNS TABLE(counsellor_id uuid, display_name text, telegram_chat_id bigint, conversation_id uuid, contact_name text, phone text, stage text, source text, days_since_touch integer, next_due_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT c.id, c.display_name, c.telegram_chat_id, l.conversation_id, ct.name, ct.phone, s.name, l.source,
         floor(extract(epoch FROM now() - greatest(l.assigned_at, f.last_at)) / 86400)::integer,
         f.next_due
    FROM counsellor_current_leads(p_account_id) l
    JOIN counsellors c ON c.id = l.counsellor_id
    JOIN contacts ct ON ct.id = l.contact_id
    JOIN LATERAL (SELECT d.stage_id FROM deals d WHERE d.contact_id = l.contact_id ORDER BY d.created_at DESC LIMIT 1) d ON true
    JOIN pipeline_stages s ON s.id = d.stage_id AND s.name NOT IN ('Lost', 'Enrolled')
    LEFT JOIN LATERAL (SELECT max(e.occurred_at) AS last_at,
                              (SELECT e2.next_due_at FROM follow_up_entries e2 WHERE e2.contact_id = l.contact_id
                                ORDER BY e2.occurred_at DESC LIMIT 1) AS next_due
                         FROM follow_up_entries e WHERE e.contact_id = l.contact_id) f ON true
   WHERE c.active
$function$;

CREATE OR REPLACE FUNCTION public.funnel_analytics(p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sources jsonb;
  v_funnel jsonb;
  v_interest jsonb;
  v_trend jsonb;
  v_totals jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

  -- Per-deal facts shared by totals, sources, and interest.
  CREATE TEMP TABLE _fa_deals ON COMMIT DROP AS
  SELECT
    d.id,
    d.contact_id,
    cur.name AS current_stage,
    GREATEST(
      CASE WHEN cur.name <> 'Lost' THEN cur.position ELSE 0 END,
      COALESCE((
        SELECT max(ps2.position) FROM deal_stage_events e
        JOIN pipeline_stages ps2 ON ps2.id = e.to_stage_id
        WHERE e.deal_id = d.id AND ps2.name <> 'Lost'
      ), 0)
    ) AS reached_pos,
    (SELECT sm.position FROM pipeline_stages sm
      WHERE sm.pipeline_id = d.pipeline_id AND sm.name = 'Qualified') AS qualified_pos,
    (SELECT sm.position FROM pipeline_stages sm
      WHERE sm.pipeline_id = d.pipeline_id AND sm.name = 'Counselor Active') AS counselor_pos,
    (SELECT sm.position FROM pipeline_stages sm
      WHERE sm.pipeline_id = d.pipeline_id AND sm.name = 'Application Started') AS application_pos,
    COALESCE(
      NULLIF(ct.ad_headline, ''),
      NULLIF(left(ct.ad_body, 60), ''),
      'Organic'
    ) AS source,
    intr.interest_university
  FROM deals d
  JOIN pipeline_stages cur ON cur.id = d.stage_id
  JOIN contacts ct ON ct.id = d.contact_id
  LEFT JOIN LATERAL (
    SELECT c.interest_university FROM conversations c
    WHERE c.contact_id = ct.id AND c.interest_updated_at IS NOT NULL
    ORDER BY c.interest_updated_at DESC LIMIT 1
  ) intr ON true
  WHERE d.account_id = p_account_id;

  SELECT jsonb_build_object(
    'leads', count(*),
    'enrolled', count(*) FILTER (WHERE current_stage = 'Enrolled'),
    'lost', count(*) FILTER (WHERE current_stage = 'Lost'),
    'reached_application', count(*) FILTER (WHERE reached_pos >= application_pos)
  ) INTO v_totals FROM _fa_deals;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'leads')::int DESC), '[]'::jsonb)
  INTO v_sources
  FROM (
    SELECT jsonb_build_object(
      'source', source,
      'leads', count(*),
      'qualified', count(*) FILTER (WHERE reached_pos >= qualified_pos),
      'counselor', count(*) FILTER (WHERE reached_pos >= counselor_pos),
      'application', count(*) FILTER (WHERE reached_pos >= application_pos),
      'enrolled', count(*) FILTER (WHERE current_stage = 'Enrolled'),
      'lost', count(*) FILTER (WHERE current_stage = 'Lost')
    ) AS row
    FROM _fa_deals GROUP BY source
  ) s;

  -- Current + ever-reached counts per stage NAME. Migration 047 split deals
  -- across per-university pipelines whose ladders are clones, so the account
  -- funnel groups by name (a per-pipeline row set would list every stage
  -- once per board). Lost keeps its current count only: it is an exit, not
  -- a rung on the ladder.
  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'position')::int), '[]'::jsonb)
  INTO v_funnel
  FROM (
    SELECT jsonb_build_object(
      'stage', ps.name,
      'position', ps.position,
      'current', (SELECT count(*) FROM _fa_deals f WHERE f.current_stage = ps.name),
      'reached', CASE WHEN ps.name = 'Lost' THEN NULL
                      ELSE (SELECT count(*) FROM _fa_deals f WHERE f.reached_pos >= ps.position) END
    ) AS row
    FROM (
      SELECT DISTINCT s.name, s.position FROM pipeline_stages s
      WHERE s.pipeline_id IN (
        SELECT DISTINCT d.pipeline_id FROM deals d WHERE d.account_id = p_account_id
      )
    ) ps
  ) f;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'leads')::int DESC), '[]'::jsonb)
  INTO v_interest
  FROM (
    SELECT jsonb_build_object(
      'university', COALESCE(interest_university, 'Unresolved'),
      'leads', count(*),
      'application', count(*) FILTER (WHERE reached_pos >= application_pos),
      'enrolled', count(*) FILTER (WHERE current_stage = 'Enrolled'),
      'lost', count(*) FILTER (WHERE current_stage = 'Lost')
    ) AS row
    FROM _fa_deals GROUP BY interest_university
  ) i;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'day')), '[]'::jsonb)
  INTO v_trend
  FROM (
    SELECT jsonb_build_object(
      'day', day::text,
      'median_minutes', round(med::numeric, 1),
      'responses', n
    ) AS row
    FROM (
      SELECT (resp_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_minutes) AS med,
             count(*) AS n
      FROM (
        SELECT m.created_at AS resp_at,
               EXTRACT(EPOCH FROM (m.created_at - lag(m.created_at) OVER w)) / 60 AS gap_minutes,
               m.sender_type,
               lag(m.sender_type) OVER w AS prev_type
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.account_id = p_account_id
          AND m.created_at >= now() - INTERVAL '14 days'
        WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.created_at)
      ) pairs
      WHERE sender_type = 'agent' AND prev_type = 'customer'
      GROUP BY 1
    ) days
  ) t;

  DROP TABLE _fa_deals;

  RETURN jsonb_build_object(
    'totals', v_totals,
    'sources', v_sources,
    'funnel', v_funnel,
    'interest', v_interest,
    'response_trend', v_trend
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.pipeline_funnel(p_account_id uuid, p_pipeline_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pipelines p
    WHERE p.id = p_pipeline_id AND p.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'Pipeline not found in this account' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'position')::int), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'stage', ps.name,
      'position', ps.position,
      'color', ps.color,
      'current', (
        SELECT count(*) FROM deals d WHERE d.stage_id = ps.id
      ),
      'reached', CASE WHEN ps.name = 'Lost' THEN NULL ELSE (
        SELECT count(DISTINCT x.deal_id) FROM (
          SELECT d.id AS deal_id FROM deals d
          JOIN pipeline_stages cur ON cur.id = d.stage_id
          WHERE d.pipeline_id = p_pipeline_id
            AND cur.name <> 'Lost'
            AND cur.position >= ps.position
          UNION
          SELECT e.deal_id FROM deal_stage_events e
          JOIN pipeline_stages es ON es.id = e.to_stage_id
          WHERE es.pipeline_id = p_pipeline_id
            AND es.name <> 'Lost'
            AND es.position >= ps.position
        ) x
      ) END,
      'median_hours', (
        SELECT round(percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (sp.left_at - sp.entered_at)) / 3600
               )::numeric, 1)
        FROM (
          SELECT e.changed_at AS entered_at,
                 lead(e.changed_at) OVER (PARTITION BY e.deal_id ORDER BY e.changed_at) AS left_at,
                 e.to_stage_id
          FROM deal_stage_events e
          WHERE e.account_id = p_account_id
        ) sp
        WHERE sp.to_stage_id = ps.id AND sp.left_at IS NOT NULL
      )
    ) AS row
    FROM pipeline_stages ps
    WHERE ps.pipeline_id = p_pipeline_id
  ) f;

  RETURN v_result;
END;
$function$;

-- 093 added a column to lead_queue, so the old return type needs a drop first; grants go back as they were.
DROP FUNCTION IF EXISTS public.lead_queue(uuid);
CREATE FUNCTION public.lead_queue(p_account_id uuid)
 RETURNS TABLE(deal_id uuid, contact_id uuid, conversation_id uuid, name text, phone text, roll_number text, stage_name text, stage_position integer, interest_university text, interest_mode text, interest_course text, interest_specialization text, ad_headline text, ad_body text, source text, customer_messages bigint, last_customer_at timestamp with time zone, last_agent_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

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
      -- 091: silence on the bot number says nothing once a person has the lead, because counsellors reply from
      -- their own phones. Only a human marks those Lost.
      AND (d.lost_snooze_until IS NULL OR d.lost_snooze_until <= now())
      AND NOT EXISTS (SELECT 1 FROM counsellor_assignments a WHERE a.contact_id = d.contact_id)
      AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = d.contact_id AND c.assigned_agent_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM follow_up_entries f WHERE f.contact_id = d.contact_id
                        AND f.occurred_at >= now() - make_interval(days => p_lost_after_days))
      AND NOT EXISTS (SELECT 1 FROM deal_stage_events e WHERE e.deal_id = d.id AND e.changed_by IS NOT NULL
                        AND e.changed_at >= now() - make_interval(days => p_lost_after_days))
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

REVOKE ALL ON FUNCTION public.lead_queue(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lead_queue(uuid) TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.counsellor_held_leads(uuid);
DROP INDEX IF EXISTS public.deals_contact_created;

-- follow_up_entries leaves the realtime publication again.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication_tables
              WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'follow_up_entries') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.follow_up_entries;
  END IF;
END $$;
