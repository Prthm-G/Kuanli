-- 075_rollback.sql
-- Reverts 075 by re-applying 074's function body verbatim.
--
-- Safe to run any time: 075 wrote no data (zero Purchase/InitiateCheckout rows
-- existed), so reverting the function is the entire rollback. After this runs,
-- Application Started stops reporting and Enrolled reverts to reading
-- deals.value (0.00) for the Purchase value.

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
  ON CONFLICT (event_id) DO NOTHING;

  RETURN NULL;
END;
$$;

COMMIT;
