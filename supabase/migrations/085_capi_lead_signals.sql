-- 085_capi_lead_signals.sql
-- KB-CAPI-R7-01
--
-- Make the Conversions API events a lead-QUALITY signal, so the click-to-WhatsApp
-- campaign can later optimise for "Maximize number of leads through messaging"
-- instead of raw conversations. Ruling: skeure-growth decisions/log.md, 2026-10-30.
--
-- ============================================================================
-- WHY: LeadSubmitted currently means "any conversation"
-- ============================================================================
--
-- 074 mapped the CRM 'Qualified' stage to LeadSubmitted. That stage is set by
-- the n8n "Deterministic Stage Guard" whenever a message names a university plus
-- a course word, which the ad's own prefilled text does. Measured 2026-10-30 on
-- 1,161 ad conversations (2026-08-17..09-30): 72% reached Qualified within 7 days
-- of the click. Meta was being taught to find people who open a chat.
--
-- ============================================================================
-- WHAT 085 REPORTS
-- ============================================================================
--
--   LeadSubmitted  the lead tapped a specific course in the bot's course menu
--                  (messages.interactive_reply_id 'sel:course:...', not
--                  '...:__other'). 43% of ad conversations, a deliberate choice.
--   QualifiedLead  the lead messaged their assigned counsellor's own number
--                  (counsellor_assignments.reached_at set by
--                  mark_counsellor_reached, 081).
--   Qualified      reports NOTHING now. Application Started -> InitiateCheckout
--                  and Enrolled -> Purchase are unchanged from 075.
--
-- Delivery is untouched: these triggers only queue 'pending' rows, and
-- devtools/sweep-meta-conversions.mjs -> /api/bot/report-conversions ->
-- reportConversion() sends them, exactly as for the deal trigger (068).
--
-- ============================================================================
-- WHY THESE TRIGGERS FILTER, UNLIKE THE DEAL TRIGGER
-- ============================================================================
--
-- 068 queues organic deals too and lets reportConversion() mark them
-- 'skipped'/'organic', so the reportability rule lives in one place. That is
-- wrong for these two events. event_id is one per (conversation, event_name)
-- and UNIQUE (065), so a skipped row written for an organic tap would occupy
-- `<conv>:LeadSubmitted` forever: if that contact later arrives from an ad and
-- taps a course, the real lead could never be reported. So queue_ad_conversion()
-- writes a row ONLY when the conversation carries a ctwa_clid and the event lies
-- inside Meta's 7-day attribution window from the click. Anything else writes
-- nothing, leaving the slot free. reportConversion() still applies its own
-- checks (WABA, dataset, 7-day event age) at send time.
--
-- Click time is COALESCE(ad_referral_msg_at, ad_referral_at): Meta's message time
-- where recorded (070), else receipt time, the same rule as 078. The lower bound
-- (event no earlier than 5 minutes before the click) stops a replayed old
-- message (084 webhook inbox) being credited to a newer click; the 5 minutes
-- absorbs the gap between Meta's clock and ours.
--
-- ============================================================================
-- A FAILED QUEUE MUST NOT FAIL THE WRITE THAT TRIGGERED IT
-- ============================================================================
--
-- The messages trigger runs inside the inbound webhook's INSERT. If it raised,
-- the lead's message would be lost (Meta does not resend after a 200, and 084's
-- replay would hit the same error). Likewise mark_counsellor_reached. So each
-- trigger catches the error and raises a WARNING (postgres log) instead. A lost
-- conversion is recoverable from messages/counsellor_assignments; a lost
-- message is not.
--
-- Rollback: 085_rollback.sql (drops both triggers and the three functions,
-- re-applies 075's record_conversion_from_deal body verbatim). Queued rows stay:
-- they are real events and the sweep delivers or expires them as usual.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Deal trigger: 075's body minus the Qualified mapping.
-- ---------------------------------------------------------------------------
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
$$;

-- ---------------------------------------------------------------------------
-- 2. Queue one ad-attributable event. Returns true when a row was written.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.queue_ad_conversion(
  p_conversation_id uuid, p_event_name text, p_event_time timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO meta_conversion_events (
    account_id, conversation_id, event_name, event_id, event_time, ctwa_clid, status
  )
  SELECT c.account_id, c.id, p_event_name,
         c.id::text || ':' || p_event_name,   -- MUST match buildEventId()
         p_event_time, c.ctwa_clid, 'pending'
    FROM conversations c
   WHERE c.id = p_conversation_id
     AND c.ctwa_clid IS NOT NULL
     AND p_event_time >= COALESCE(c.ad_referral_msg_at, c.ad_referral_at) - interval '5 minutes'
     AND p_event_time <= COALESCE(c.ad_referral_msg_at, c.ad_referral_at) + interval '7 days'
  -- A 'skipped' row never reached Meta (organic or too old when the Qualified
  -- path wrote it: 189 organic LeadSubmitted rows exist today). Left alone it
  -- would hold this event_id forever, so a real ad event revives it. 'sent',
  -- 'pending' and 'failed' rows are kept: one event per conversation.
  ON CONFLICT (event_id) DO UPDATE
     SET event_time = EXCLUDED.event_time, ctwa_clid = EXCLUDED.ctwa_clid,
         status = 'pending', reason = NULL, waba_id = NULL, dataset_id = NULL,
         fbtrace_id = NULL, attempts = 0, updated_at = now()
   WHERE meta_conversion_events.status = 'skipped';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;
-- When 085 went live: devtools/apply-kuanli-capi-signals-085.mjs --verify only
-- counts course taps / counsellor reaches after this as misses.
DO $$ BEGIN
  EXECUTE format('COMMENT ON FUNCTION public.queue_ad_conversion(uuid, text, timestamptz) IS %L',
                 'KB-CAPI-R7-01 applied ' || now()::text);
END $$;
-- service_role too: only these triggers (running as the owner) should queue.
REVOKE ALL ON FUNCTION public.queue_ad_conversion(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. QualifiedLead: the lead reached their counsellor.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_conversion_from_counsellor_reached()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.reached_at IS NOT NULL THEN RETURN NULL; END IF;
  BEGIN
    PERFORM queue_ad_conversion(NEW.conversation_id, 'QualifiedLead', NEW.reached_at);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[capi] QualifiedLead not queued for conversation %: % (%)',
      NEW.conversation_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_conversion_from_counsellor_reached() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER counsellor_assignments_record_reached
  AFTER INSERT OR UPDATE OF reached_at ON public.counsellor_assignments
  FOR EACH ROW
  WHEN (NEW.reached_at IS NOT NULL)
  EXECUTE FUNCTION public.record_conversion_from_counsellor_reached();

-- ---------------------------------------------------------------------------
-- 4. LeadSubmitted: the lead tapped a specific course.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_conversion_from_course_pick()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.sender_type = 'customer' AND NEW.interactive_reply_id NOT LIKE '%:\_\_other' THEN
    BEGIN
      PERFORM queue_ad_conversion(NEW.conversation_id, 'LeadSubmitted', COALESCE(NEW.created_at, now()));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[capi] LeadSubmitted not queued for conversation %: % (%)',
        NEW.conversation_id, SQLERRM, SQLSTATE;
    END;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_conversion_from_course_pick() FROM PUBLIC, anon, authenticated;

-- Last statement before COMMIT on purpose: CREATE TRIGGER takes SHARE ROW
-- EXCLUSIVE on messages (blocks inbound inserts) until COMMIT, so nothing may
-- wait on a lock after it.
-- WHEN keeps every other message (the overwhelming majority) out of plpgsql.
CREATE OR REPLACE TRIGGER messages_record_course_pick
  AFTER INSERT ON public.messages
  FOR EACH ROW
  WHEN (NEW.interactive_reply_id LIKE 'sel:course:%')
  EXECUTE FUNCTION public.record_conversion_from_course_pick();

COMMIT;
