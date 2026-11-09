-- 091_lead_handling.sql  (KB-LEAD-HANDLING-20261107)
-- From the 7 Nov Kuanli audit. Approved by the owner 2026-11-07.
--
-- 1. lifecycle_sweep: the 14-day Lost rule stays for leads nobody holds, and stops for leads a person holds. Counsellors
--    reply from their own phones, so silence on the bot number proved nothing: the 44 leads assigned since 29 Oct would have
--    started going Lost on 12 Nov. Only Step 4 changes. Also protected: a snoozed deal, a follow-up logged in the window, and
--    a stage a human set in the window (otherwise a lead dragged out of Lost returned there within 30 minutes).
-- 2. counsellor_current_leads + my_assigned_conversation_ids: "My leads" reads the assignment, not only the owner. The
--    silent and unanswered routes leave conversations.assigned_agent_id empty on purpose, because the owner also drives bot
--    behaviour, so a counsellor saw only a few of their own leads.
-- 3. counsellor_lead_list: the daily Telegram list and the 21-day flag.
-- 4. lost_restore_queue, queue_lost_restore, restore_lost_batch: restores warm Lost leads gradually. A restored lead is held
--    in the queue, not in counsellor_assignments, so handover alerts, the morning summary, the silent-lead finders and the
--    rotation see nothing new. Sends no message and no ad conversion (record_conversion_from_deal is forward-only).
-- Rollback: 091_rollback.sql.

-- deals is written on every inbound message. Better to fail and retry than to queue behind a long transaction and block them.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS lost_snooze_until timestamptz;

CREATE TABLE IF NOT EXISTS public.lost_restore_queue (
  deal_id          uuid PRIMARY KEY REFERENCES public.deals(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  prior_stage_id   uuid NOT NULL REFERENCES public.pipeline_stages(id) ON DELETE CASCADE,
  last_customer_at timestamptz NOT NULL,
  queued_at        timestamptz NOT NULL DEFAULT now(),
  restored_at      timestamptz,
  counsellor_id    uuid REFERENCES public.counsellors(id) ON DELETE SET NULL,
  skipped_reason   text
);
ALTER TABLE public.lost_restore_queue ENABLE ROW LEVEL SECURITY;
-- Explicit: Supabase default privileges would otherwise give anon and authenticated full DML on a new table.
REVOKE ALL ON public.lost_restore_queue FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS lost_restore_queue_next ON public.lost_restore_queue (account_id, last_customer_at DESC) WHERE restored_at IS NULL AND skipped_reason IS NULL;
CREATE INDEX IF NOT EXISTS lost_restore_queue_contact ON public.lost_restore_queue (contact_id);

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

-- Who holds which conversation now. A restored lead counts until the normal route assigns that contact.
CREATE OR REPLACE FUNCTION public.counsellor_current_leads(p_account_id uuid)
RETURNS TABLE (counsellor_id uuid, conversation_id uuid, contact_id uuid, source text, assigned_at timestamptz)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
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
$$;

-- For the signed-in counsellor. SECURITY DEFINER because counsellors is admin-only under RLS; returns only their own ids.
CREATE OR REPLACE FUNCTION public.my_assigned_conversation_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.conversation_id
    FROM profiles p
    JOIN counsellors c ON c.profile_id = p.id
    CROSS JOIN LATERAL counsellor_current_leads(c.account_id) l
   WHERE p.user_id = auth.uid() AND l.counsellor_id = c.id
     -- Marked Lost: done with, so off the counsellor's working list.
     AND NOT EXISTS (SELECT 1 FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id
                      WHERE d.contact_id = l.contact_id AND s.name = 'Lost')
$$;

-- Daily Telegram list and the stale flag. Leads marked Lost or Enrolled drop off.
CREATE OR REPLACE FUNCTION public.counsellor_lead_list(p_account_id uuid)
RETURNS TABLE (counsellor_id uuid, display_name text, telegram_chat_id bigint, conversation_id uuid, contact_name text, phone text,
               stage text, source text, days_since_touch integer, next_due_at timestamptz)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
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
$$;

-- One-time seed. p_as_of is fixed by the caller, so the set does not drift as the 60-day window moves. A second call adds nothing.
-- Takes only leads the sweep lost: never one a person marked Lost, one that went Lost soon after writing (the bot's opt-out guard
-- does that, with no user to record), one above the sweep's reach, or one whose messages read as asking us to stop. The wording
-- check is deliberately broad: wrongly leaving a warm lead out costs little, messaging someone who said stop costs more.
CREATE OR REPLACE FUNCTION public.queue_lost_restore(p_account_id uuid, p_as_of timestamptz, p_window_days integer DEFAULT 60, p_min_replies integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM lost_restore_queue q WHERE q.account_id = p_account_id) THEN RETURN 0; END IF;
  WITH inbound AS (
    SELECT cv.contact_id, max(m.created_at) AS last_at, count(*) AS n
      FROM conversations cv JOIN messages m ON m.conversation_id = cv.id
     WHERE cv.account_id = p_account_id AND m.sender_type = 'customer'
     GROUP BY cv.contact_id
  ), ins AS (
    INSERT INTO lost_restore_queue (deal_id, account_id, contact_id, conversation_id, prior_stage_id, last_customer_at)
    SELECT d.id, d.account_id, d.contact_id,
           coalesce(d.conversation_id, (SELECT cv.id FROM conversations cv WHERE cv.contact_id = d.contact_id ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1)),
           ev.from_stage_id, i.last_at
      FROM deals d
      JOIN pipeline_stages s ON s.id = d.stage_id AND s.name = 'Lost'
      JOIN inbound i ON i.contact_id = d.contact_id
      JOIN LATERAL (SELECT e.from_stage_id, e.changed_by, e.changed_at FROM deal_stage_events e
                     WHERE e.deal_id = d.id AND e.to_stage_id = d.stage_id AND e.from_stage_id IS NOT NULL
                     ORDER BY e.changed_at DESC LIMIT 1) ev ON true
      JOIN pipeline_stages prior ON prior.id = ev.from_stage_id AND prior.name NOT IN ('Application Started', 'Enrolled', 'Lost')
     WHERE d.account_id = p_account_id
       AND i.n >= p_min_replies
       AND i.last_at > p_as_of - make_interval(days => p_window_days)
       AND ev.changed_by IS NULL
       AND ev.changed_at >= i.last_at + interval '13 days'
       AND NOT EXISTS (SELECT 1 FROM conversations cv JOIN messages m ON m.conversation_id = cv.id
                        WHERE cv.contact_id = d.contact_id AND m.sender_type = 'customer'
                          AND m.content_text ~* '(\mstop\M|unsubscribe|not interested|don.?t (message|contact|call|text)|do not (message|contact|call|text)|remove me|no need|wrong number|nahi chahiye|nhi chahiye|mat (bhejo|karo|bhej)|band karo|interested nahi|interested nhi|already (admitted|enrolled|done|taken)|not required|\mspam\M)')
    ON CONFLICT (deal_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM ins;
  RETURN v_n;
END $$;

-- Next batch, newest reply first, split evenly across active counsellors. Each deal returns to its stage before Lost and gets
-- p_snooze_days before the sweep can take it again.
CREATE OR REPLACE FUNCTION public.restore_lost_batch(p_account_id uuid, p_limit integer DEFAULT 40, p_snooze_days integer DEFAULT 30)
RETURNS TABLE (deal_id uuid, contact_id uuid, to_stage text, counsellor text)
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
END $$;

REVOKE ALL ON FUNCTION public.counsellor_current_leads(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.counsellor_lead_list(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.queue_lost_restore(uuid, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_lost_batch(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.my_assigned_conversation_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_assigned_conversation_ids() TO authenticated;
