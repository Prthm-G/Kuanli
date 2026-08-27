-- 068_conversion_events_from_deals.sql
-- KB-CAPI-R5-49
--
-- Detect the conversions worth reporting to Meta, and record them for delivery.
--
-- 065 built the client and the audit trail. This is what actually notices that
-- a conversion happened. Without it the whole Conversions API path is dead code
-- and Meta's optimiser stays blind to which ads produce admissions.
--
-- ============================================================================
-- WHY DETECTION AND DELIVERY ARE SEPARATED
-- ============================================================================
--
-- The tempting shape is "advance the stage, then POST to Meta". It is wrong
-- here for three reasons:
--
--   1. The stage advance happens inside an n8n Postgres node, mid-conversation.
--      A slow or failing Graph call would sit in the path of answering a
--      student.
--   2. Meta rejects an ENTIRE request if any event in it is over 7 days old, so
--      delivery needs to be able to retry selectively and to give up
--      deliberately. That is a sweep's job, not a trigger's.
--   3. n8n cannot compute HMAC and holds no Meta CAPI credential. The token
--      lives encrypted in whatsapp_config and is decrypted by wacrm.
--
-- So: this trigger only NOTICES, writing a 'pending' row. Delivery is
-- devtools/sweep-meta-conversions.mjs calling reportConversion(), which is
-- where the token, the 7-day guard and the WABA resolution already live.
--
-- ============================================================================
-- WHICH STAGES COUNT, AND WHY NOT THE ONES YOU WOULD EXPECT
-- ============================================================================
--
-- Measured on the live pipeline today: 28 deals at New Lead, 5 Engaged, 128
-- Qualified, 141 Counselor Active, and ZERO at Application Started, Enrolled or
-- Lost. So a Purchase-on-enrolment event - the obvious "report admissions back"
-- design - would fire exactly zero times, because nobody is moving cards that
-- far. It is built here anyway, and stays dormant until the pipeline is
-- actually worked that far, at which point it starts reporting with no further
-- change.
--
-- The signal that exists in volume TODAY is Qualified: 28 of the 29
-- ad-attributed conversations reached it. That maps to Meta's `Lead`.
--
-- Only FORWARD transitions fire. Auto-Stage Pipeline is forward-only except
-- that Lost may override anything, and a card dragged backwards then forwards
-- again in the CRM must not report a second conversion. The UNIQUE constraint
-- on event_id in 065 is the real backstop - this is just not generating noise
-- for it to swallow.
--
-- Organic leads are deliberately recorded too, as 'pending'. reportConversion
-- resolves them to 'skipped'/'organic' rather than this trigger deciding: the
-- rule for "is this reportable" then lives in exactly one place, which is the
-- whole reason the other bugs in this project kept recurring.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS deals_record_conversion ON deals;
--   DROP FUNCTION IF EXISTS record_conversion_from_deal();

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
               WHEN 'Qualified' THEN 'Lead'
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

DROP TRIGGER IF EXISTS deals_record_conversion ON deals;
CREATE TRIGGER deals_record_conversion
  AFTER INSERT OR UPDATE OF stage_id ON deals
  FOR EACH ROW
  EXECUTE FUNCTION record_conversion_from_deal();

-- Backfill the conversions that already happened and are still inside Meta's
-- 7-day window. 28 ad-attributed deals are sitting at Qualified right now,
-- reported to nobody. event_time is the deal's own updated_at, not now(), so a
-- stale one is refused by the sweep's window check rather than misreported as
-- having converted today.
INSERT INTO meta_conversion_events (
  account_id, conversation_id, event_name, event_id, event_time,
  ctwa_clid, status
)
SELECT d.account_id, c.id, 'Lead', c.id::text || ':Lead', d.updated_at,
       c.ctwa_clid, 'pending'
FROM deals d
JOIN pipeline_stages ps ON ps.id = d.stage_id AND ps.name = 'Qualified'
JOIN conversations c
  ON c.id = COALESCE(d.conversation_id,
       (SELECT id FROM conversations WHERE contact_id = d.contact_id
         ORDER BY last_message_at DESC NULLS LAST LIMIT 1))
WHERE c.ctwa_clid IS NOT NULL
ON CONFLICT (event_id) DO NOTHING;
