-- 095_admissions_stages.sql  (KB-ADMISSIONS-R0)
-- Admissions Release 0. Idempotent: every statement is safe to run twice.
-- Task 1: three new stages on every admissions board, and a position lookup by stage name.

-- Callers compare stage positions through this helper, never against a literal number.
CREATE OR REPLACE FUNCTION public.stage_position(p_pipeline_id uuid, p_name text)
RETURNS int LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT position FROM public.pipeline_stages WHERE pipeline_id = p_pipeline_id AND name = p_name LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.stage_position(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stage_position(uuid, text) TO authenticated, service_role;

-- Provisional ID, Form & Documents and Fee Submitted go between Application Started and Enrolled on every board that
-- has an Application Started stage. Deals keep their stage rows (they point at stage ids); only positions shift.
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT pipeline_id, position AS app_pos FROM public.pipeline_stages WHERE name = 'Application Started' LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.pipeline_stages WHERE pipeline_id = p.pipeline_id AND name = 'Provisional ID');
    UPDATE public.pipeline_stages SET position = position + 3 WHERE pipeline_id = p.pipeline_id AND position > p.app_pos;
    INSERT INTO public.pipeline_stages (pipeline_id, name, position, color) VALUES
      (p.pipeline_id, 'Provisional ID',   p.app_pos + 1, '#0ea5e9'),
      (p.pipeline_id, 'Form & Documents', p.app_pos + 2, '#6366f1'),
      (p.pipeline_id, 'Fee Submitted',    p.app_pos + 3, '#14b8a6');
  END LOOP;
  IF (SELECT count(DISTINCT m) FROM (SELECT string_agg(name||':'||position, ',' ORDER BY position) m
        FROM public.pipeline_stages WHERE pipeline_id IN (SELECT pipeline_id FROM public.pipeline_stages WHERE name = 'Application Started')
        GROUP BY pipeline_id) x) > 1 THEN
    RAISE EXCEPTION '095: admissions pipelines disagree on stage positions';
  END IF;
END $$;

-- Task 2: automation moves are logged with a NULL changed_by (advance_application sets app.automation = 'on').
-- Body copied from 042_deal_stage_events.sql; only the changed_by expression differs. No later migration redefines it.
CREATE OR REPLACE FUNCTION log_deal_stage_event() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO deal_stage_events (deal_id, account_id, from_stage_id, to_stage_id, changed_by)
    VALUES (NEW.id, NEW.account_id, NULL, NEW.stage_id,
            CASE WHEN current_setting('app.automation', true) = 'on' THEN NULL ELSE auth.uid() END);
  ELSIF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO deal_stage_events (deal_id, account_id, from_stage_id, to_stage_id, changed_by)
    VALUES (NEW.id, NEW.account_id, OLD.stage_id, NEW.stage_id,
            CASE WHEN current_setting('app.automation', true) = 'on' THEN NULL ELSE auth.uid() END);
  END IF;
  RETURN NEW;
END;
$$;

-- Task 2: Meta conversions fire when a deal CROSSES Application Started / Enrolled, not only when it lands on them.
-- Body copied from 093_not_interested_and_lists.sql; changed: the forward-only guard and the landing-by-name decision
-- become the crossing rule. Kept exactly: ctwa_clid lives on the conversation, the Purchase value and 0-total skip, and the
-- once-per-conversation-and-event guard (event_id conflict).
--   * a win-back out of Lost / Not Interested counts from the start (before every rung)
--   * moving into an exit (Lost / Not Interested) reports nothing
--   * a jump that crosses both rungs reports both, InitiateCheckout first
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
  v_from      INT;
  v_app       INT;
  v_enr       INT;
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

  -- A card dragged back and forth must not re-report, and a move into an exit reports nothing.
  IF new_stage IN ('Lost', 'Not Interested') THEN RETURN NULL; END IF;
  v_app := public.stage_position(NEW.pipeline_id, 'Application Started');
  v_enr := public.stage_position(NEW.pipeline_id, 'Enrolled');
  -- A new deal, or a win-back out of an exit, counts from before every rung. The event_id conflict below still stops a
  -- second report of the same event for the same conversation.
  v_from := CASE WHEN old_pos IS NULL OR old_stage IN ('Lost', 'Not Interested') THEN -1 ELSE old_pos END;

  -- 'Qualified' no longer reports (085): the bot sets it on most first
  -- messages. LeadSubmitted now comes from the course pick, not from a stage.
  -- A board without these stages (v_app / v_enr NULL) reports nothing.
  IF NOT ((v_app IS NOT NULL AND v_from < v_app AND new_pos >= v_app)
       OR (v_enr IS NOT NULL AND v_from < v_enr AND new_pos >= v_enr)) THEN
    RETURN NULL;
  END IF;

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

  FOREACH ev_name IN ARRAY ARRAY['InitiateCheckout', 'Purchase'] LOOP  -- 075: Application Started reports InitiateCheckout
    CONTINUE WHEN ev_name = 'InitiateCheckout' AND NOT (v_app IS NOT NULL AND v_from < v_app AND new_pos >= v_app);
    CONTINUE WHEN ev_name = 'Purchase' AND NOT (v_enr IS NOT NULL AND v_from < v_enr AND new_pos >= v_enr);

    -- Purchase value: the agreed programme fee from the student's fee plan, NOT
    -- deals.value (which is 0 on every row). One plan per contact
    -- (apply_fee_template deletes any prior), so the ORDER BY is belt-and-braces.
    -- No plan, or a non-positive total, means we cannot report a real value:
    -- queue NOTHING rather than a poisoning INR 0 Purchase.
    v_value := NULL; v_currency := NULL;
    IF ev_name = 'Purchase' THEN
      SELECT agreed_total, currency INTO v_value, v_currency
        FROM student_fee_plans
       WHERE contact_id = NEW.contact_id
       ORDER BY created_at DESC
       LIMIT 1;
      CONTINUE WHEN v_value IS NULL OR v_value <= 0;
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
  END LOOP;

  RETURN NULL;
END;
$function$;
