-- 074_lead_submitted_rename.sql
-- (renumbered from 071 on 2026-08-22: 071/072/073 were taken by other work
--  before this ever landed. No overlap: none of them touch
--  record_conversion_from_deal() or meta_conversion_events.)
-- KB-CAPI-R5-50
--
-- Meta rejects event_name 'Lead' under action_source 'business_messaging'
-- (verified live 2026-08-22, error subcode 2804066: "The event name parameter
-- value \"Lead\" ... is invalid. Provide a valid value ... such as \"Purchase\"
-- or \"LeadSubmitted\""). 'Lead' is a WEBSITE event name; the business_messaging
-- taxonomy is Purchase, LeadSubmitted, InitiateCheckout, AddToCart, ViewContent,
-- OrderCreated/Shipped/Delivered/Canceled/Returned, CartAbandoned, QualifiedLead,
-- RatingProvided, ReviewProvided.
--
-- The CRM 'Qualified' stage is near-universal (068's own measurement: 28 of 29
-- ad-attributed conversations reach it), so it carries no selectivity and maps
-- to LeadSubmitted, NOT QualifiedLead. QualifiedLead is reserved for a future
-- genuinely selective (counsellor-vetted) stage. Ruling recorded in
-- projects/skeure-education/skeure-growth/decisions/log.md (2026-08-21).
--
-- This supersedes 068's function body (that CASE mapped Qualified -> 'Lead').
--
-- Rollback:
--   Re-apply 068's function body verbatim, then reverse the data UPDATE below
--   (swap 'LeadSubmitted' back to 'Lead' for the same WHERE/status filter and
--   rewrite event_id in lockstep).

-- One transaction: if the data UPDATE below aborts, the function swap must
-- abort with it. Otherwise new deals report LeadSubmitted while the legacy
-- rows stay 'Lead' and are rejected by Meta every 15 minutes until they age
-- out. lock_timeout makes blocked DDL fail loudly instead of stalling `deals`.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION record_conversion_from_deal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_stage  TEXT;
  old_stage  TEXT;
  new_pos    INT;
  old_pos    INT;
  ev_name    TEXT;
  conv_id    UUID;
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
               WHEN 'Qualified' THEN 'LeadSubmitted'   -- was 'Lead' (068); invalid for business_messaging
               WHEN 'Enrolled'  THEN 'Purchase'
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

  INSERT INTO meta_conversion_events (
    account_id, conversation_id, event_name, event_id, event_time,
    ctwa_clid, value, currency, status
  )
  SELECT NEW.account_id, conv_id, ev_name,
         conv_id::text || ':' || ev_name,   -- MUST match buildEventId()
         now(),
         c.ctwa_clid,
         CASE WHEN ev_name = 'Purchase' THEN NEW.value ELSE NULL END,
         CASE WHEN ev_name = 'Purchase' THEN COALESCE(NEW.currency,'INR') ELSE NULL END,
         'pending'
  FROM conversations c WHERE c.id = conv_id
  ON CONFLICT (event_id) DO NOTHING;   -- already reported, or already queued

  RETURN NULL;
END;
$$;

-- Trigger is deliberately NOT dropped/recreated. Its shape (name, timing,
-- table, function) is unchanged from 068, and CREATE OR REPLACE FUNCTION
-- preserves the function OID, so the existing trigger picks up the new body
-- on its next fire. Touching the trigger would take ACCESS EXCLUSIVE on
-- `deals` (queuing every later read behind it, FIFO) and would open a window
-- with no trigger at all, in which a deal reaching Qualified/Enrolled is
-- silently never recorded. Neither risk buys anything here.

-- Data migration: rewrite the queued 'Lead' rows in lockstep with their
-- event_id (UNIQUE per 065; buildEventId() derives event_id from event_name, so
-- renaming one without the other would make the retry insert a NEW row and
-- orphan the old one at status='failed' forever). One atomic statement, so no
-- 15-minute sweep tick can read a half-rewritten row.
--
-- Only live queue states ('pending','failed') are touched. 'sent' and 'skipped'
-- are the audit record of what was actually transmitted and are left alone.
-- The NOT EXISTS guard covers the race where the new trigger already inserted a
-- correctly-named row for the same conversation: leave the stale 'Lead' row (it
-- just ages out; a valid 'LeadSubmitted' already exists to be sent).
UPDATE meta_conversion_events m
SET event_name = 'LeadSubmitted',
    event_id   = m.conversation_id::text || ':LeadSubmitted',
    updated_at = now()
WHERE m.event_name = 'Lead'
  AND m.status IN ('pending', 'failed')
  AND NOT EXISTS (
    SELECT 1 FROM meta_conversion_events dup
    WHERE dup.event_id = m.conversation_id::text || ':LeadSubmitted'
  );

COMMIT;
