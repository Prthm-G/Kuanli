-- 075_capi_app_started_and_fee_value.sql
-- KB-CAPI-R6-51
--
-- Two corrections to what the admissions funnel reports to Meta, both prompted
-- by the counsellor being asked to start working cards to Application Started
-- and Enrolled (until now the pipeline stopped at Counselor Active, so neither
-- of the two deepest stages had ever fired).
--
-- ============================================================================
-- 1. Application Started now reports InitiateCheckout
-- ============================================================================
--
-- 074 mapped only Qualified -> LeadSubmitted and Enrolled -> Purchase, leaving
-- Application Started -- a genuinely mid-funnel, selective signal -- reporting
-- nothing. InitiateCheckout is in Meta's business_messaging taxonomy (the same
-- taxonomy note 074 recorded: Purchase, LeadSubmitted, InitiateCheckout,
-- AddToCart, ViewContent, ...) and is the exact semantic fit: the student has
-- begun their application. It sits above the near-universal Qualified stage
-- (286 of 398 worked deals) and so carries real optimisation value.
--
-- ============================================================================
-- 2. Purchase value comes from the fee plan, never from deals.value
-- ============================================================================
--
-- 074 (inheriting 068) set the Purchase value to NEW.value off the deal row.
-- Every one of the 598 deal rows has value = 0.00; the deal card's value field
-- has never been used. So the first card dragged to Enrolled would have sent
-- Meta a Purchase worth INR 0 -- worse than sending nothing, because it teaches
-- the optimiser that an admission is worthless and poisons value-based bidding
-- for good.
--
-- The real figure already exists elsewhere: student_fee_plans.agreed_total,
-- snapshotted by apply_fee_template() from the fee template the counsellor
-- applies (total_fee + application_fee, in the plan's own currency). It is the
-- programme fee the student agreed to, is editable per student, and is exactly
-- the "student's total programme fee" chosen as the Purchase value.
--
-- GUARD: if the contact has no fee plan (or a non-positive agreed_total) when
-- the card reaches Enrolled, NO Purchase is queued at all. Failing silent-safe
-- (queue nothing) beats failing poison (queue INR 0). The operational contract
-- this creates -- apply the fee template BEFORE marking Enrolled -- is written
-- up in the counsellor runbook. A plan added AFTER a card is already Enrolled
-- will NOT retroactively queue the Purchase (this trigger only fires on a
-- forward stage change, not on a fee-plan insert); that gap is called out in
-- the runbook and is a candidate follow-up (a fee-plan-insert backfill).
--
-- LeadSubmitted and InitiateCheckout stay non-monetary (value NULL), unchanged.
--
-- ============================================================================
-- Compatibility with the delivery code
-- ============================================================================
--
-- event_id is still `conv_id::text || ':' || ev_name`, matching buildEventId()
-- in src/lib/meta/conversions.ts, so dedup (UNIQUE in 065) still holds for the
-- new event name. The delivery route casts event_name straight into the Meta
-- payload with no allowlist, so InitiateCheckout is sent as-is; the TS type
-- ConversionEventName is widened in the same change set for honesty (compile
-- time only -- the running container already sends whatever the DB queues).
--
-- No data migration: meta_conversion_events holds zero Purchase and zero
-- InitiateCheckout rows today (only Lead and LeadSubmitted), so there is
-- nothing to rewrite. This is a pure function-body replacement.
--
-- Rollback: 075_rollback.sql (re-applies 074's function body verbatim). Reverses
-- nothing else, because this migration writes no data.

-- One transaction. lock_timeout so a blocked CREATE OR REPLACE fails loudly
-- rather than stalling behind a long read on `deals`.
BEGIN;
SET LOCAL lock_timeout = '5s';

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

-- Trigger deliberately NOT dropped/recreated: unchanged shape, and
-- CREATE OR REPLACE FUNCTION preserves the OID so the existing trigger picks up
-- the new body on its next fire. Touching the trigger would take ACCESS
-- EXCLUSIVE on `deals` and open a window with no trigger at all. (Same
-- reasoning 074 recorded.)

COMMIT;
