-- 085_rollback.sql  (KB-CAPI-R7-01)
-- Undo 085: drop the course-pick and counsellor-reached triggers and their
-- functions, and put back 075's record_conversion_from_deal body verbatim
-- (Qualified -> LeadSubmitted again). Queued meta_conversion_events rows are
-- left alone: they are real events; the sweep delivers or expires them.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS counsellor_assignments_record_reached ON public.counsellor_assignments;

-- 075's body, verbatim.
CREATE OR REPLACE FUNCTION record_conversion_from_deal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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

  ev_name := CASE new_stage
               WHEN 'Qualified'          THEN 'LeadSubmitted'    -- 074
               WHEN 'Application Started' THEN 'InitiateCheckout' -- 075 (new)
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
$$;

-- messages last: DROP TRIGGER takes ACCESS EXCLUSIVE (blocks the inbox's reads
-- too) until COMMIT, so nothing may wait on a lock after it.
DROP TRIGGER IF EXISTS messages_record_course_pick ON public.messages;
DROP FUNCTION IF EXISTS public.record_conversion_from_course_pick();
DROP FUNCTION IF EXISTS public.record_conversion_from_counsellor_reached();
DROP FUNCTION IF EXISTS public.queue_ad_conversion(uuid, text, timestamptz);

COMMIT;
