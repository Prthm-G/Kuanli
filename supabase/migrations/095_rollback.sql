-- 095_rollback.sql  (KB-ADMISSIONS-R0-4)
-- Undoes 095_admissions_stages.sql. Run in ONE transaction (apply-kuanli-095.mjs --rollback-db --yes-move-new-stage-deals).
-- Safe to run twice: a second run finds no new stage in place and changes nothing but re-asserts the four function bodies.
--
--   1. Per admissions board: every deal on Provisional ID / Form & Documents / Fee Submitted moves to Application Started,
--      app.automation off, so deal_stage_events records each move.
--   2. A new stage that no deal_stage_events row references is deleted. One that history references stays (events point at it
--      by foreign key) at position 100 + its old position, which hides it at the end of the board.
--   3. Positions above Application Started shift down by the number of new stages found in place (3).
--   4. The four functions 095 replaced go back to their pre-095 bodies, copied from 042 (log_deal_stage_event), 093
--      (record_conversion_from_deal) and 094 (application_tracker, capture_application_document).
--   5. stage_position is dropped LAST, after no restored body can call it.
-- Re-applying 095 after this leaves any kept (position 100+) stage hidden: 095 skips a board that still has a stage named
-- Provisional ID. Rename or delete the kept stages before a second go.

DO $$
DECLARE
  p record;
  s record;
  v_app uuid;
  v_found int;
BEGIN
  PERFORM set_config('app.automation', 'off', true);
  FOR p IN SELECT id, pipeline_id, position AS app_pos FROM public.pipeline_stages WHERE name = 'Application Started' LOOP
    v_app := p.id;
    SELECT count(*) INTO v_found FROM public.pipeline_stages
     WHERE pipeline_id = p.pipeline_id AND name IN ('Provisional ID', 'Form & Documents', 'Fee Submitted') AND position < 100;
    CONTINUE WHEN v_found = 0;

    UPDATE public.deals SET stage_id = v_app
     WHERE stage_id IN (SELECT id FROM public.pipeline_stages
                         WHERE pipeline_id = p.pipeline_id AND name IN ('Provisional ID', 'Form & Documents', 'Fee Submitted'));

    FOR s IN SELECT id, position FROM public.pipeline_stages
              WHERE pipeline_id = p.pipeline_id AND name IN ('Provisional ID', 'Form & Documents', 'Fee Submitted') AND position < 100 LOOP
      IF EXISTS (SELECT 1 FROM public.deal_stage_events WHERE from_stage_id = s.id OR to_stage_id = s.id) THEN
        UPDATE public.pipeline_stages SET position = 100 + s.position WHERE id = s.id;
      ELSE
        DELETE FROM public.pipeline_stages WHERE id = s.id;
      END IF;
    END LOOP;

    UPDATE public.pipeline_stages SET position = position - v_found
     WHERE pipeline_id = p.pipeline_id AND position > p.app_pos AND position < 100;
  END LOOP;
END $$;

-- 042_deal_stage_events.sql, as before 095.
CREATE OR REPLACE FUNCTION log_deal_stage_event() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO deal_stage_events (deal_id, account_id, from_stage_id, to_stage_id, changed_by)
    VALUES (NEW.id, NEW.account_id, NULL, NEW.stage_id, auth.uid());
  ELSIF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO deal_stage_events (deal_id, account_id, from_stage_id, to_stage_id, changed_by)
    VALUES (NEW.id, NEW.account_id, OLD.stage_id, NEW.stage_id, auth.uid());
  END IF;
  RETURN NEW;
END;
$$;

-- 093_not_interested_and_lists.sql, as before 095.
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
  -- 093: leaving an exit (Lost, Not Interested: both after Enrolled by position) counts as forward, so a win-back
  -- reports. The event_id conflict below still stops a second report of the same event for the same conversation.
  IF old_pos IS NOT NULL AND new_pos <= old_pos AND old_stage NOT IN ('Lost', 'Not Interested') THEN RETURN NULL; END IF;

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

-- 094_counsellor_number_privacy.sql, as before 095.
CREATE OR REPLACE FUNCTION public.application_tracker(p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_hidden text[];
  v_all_contacts boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

  -- 094: counsellor numbers, and contacts that arrived through one, unless the caller is an admin or the owner.
  v_hidden := CASE WHEN can_see_counsellor_chats(p_account_id) THEN '{}'::text[]
                   ELSE counsellor_phone_number_ids() END;
  v_all_contacts := can_see_counsellor_chats(p_account_id);

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'stage', row->>'name'), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'contact_id', ct.id,
      'name', ct.name,
      'phone', ct.phone,
      'roll_number', ct.roll_number,
      'university', ct.university,
      'stage', ps.name,
      'conversation_id', conv.id,
      'required', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'doc_type', r.doc_type,
          'label', r.label,
          'status', COALESCE((
            SELECT ad.status FROM application_documents ad
            WHERE ad.contact_id = ct.id AND ad.doc_type = r.doc_type
            ORDER BY ad.created_at DESC LIMIT 1
          ), 'missing'),
          'document_id', (
            SELECT ad.id FROM application_documents ad
            WHERE ad.contact_id = ct.id AND ad.doc_type = r.doc_type
            ORDER BY ad.created_at DESC LIMIT 1
          )
        ) ORDER BY r.position)
        FROM university_required_docs r
        WHERE r.account_id = p_account_id
          AND r.university = COALESCE(ct.university, 'LPU')
      ), '[]'::jsonb),
      'unsorted', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'document_id', ad.id,
          'created_at', ad.created_at,
          'media_url', m.media_url,
          'content_text', m.content_text,
          'content_type', m.content_type
        ) ORDER BY ad.created_at DESC)
        FROM application_documents ad
        LEFT JOIN messages m ON m.id = ad.message_id
        WHERE ad.contact_id = ct.id AND ad.doc_type IS NULL
          AND ad.status <> 'rejected'
      ), '[]'::jsonb)
    ) AS row
    FROM deals d
    JOIN pipeline_stages ps ON ps.id = d.stage_id
      AND ps.name IN ('Application Started', 'Enrolled')
    JOIN contacts ct ON ct.id = d.contact_id
    LEFT JOIN LATERAL (
      SELECT c.id FROM conversations c
      WHERE c.contact_id = ct.id
        AND NOT coalesce(c.phone_number_id = ANY (v_hidden), false)
      ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1
    ) conv ON true
    WHERE d.account_id = p_account_id
      AND (v_all_contacts OR NOT ct.counsellor_number_only)
  ) rows;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.capture_application_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contact_id uuid;
  v_account_id uuid;
  v_phone_number_id text;
BEGIN
  IF NEW.sender_type <> 'customer'
     OR NEW.content_type NOT IN ('image', 'document') THEN
    RETURN NEW;
  END IF;

  SELECT c.contact_id, c.account_id, c.phone_number_id INTO v_contact_id, v_account_id, v_phone_number_id
  FROM conversations c WHERE c.id = NEW.conversation_id;

  IF v_contact_id IS NULL THEN RETURN NEW; END IF;
  -- 094
  IF coalesce(v_phone_number_id = ANY (counsellor_phone_number_ids()), false) THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM deals d
    JOIN pipeline_stages ps ON ps.id = d.stage_id
    WHERE d.contact_id = v_contact_id
      AND ps.name IN ('Application Started', 'Enrolled')
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO application_documents (account_id, contact_id, message_id, status)
  VALUES (v_account_id, v_contact_id, NEW.id, 'received');

  RETURN NEW;
END;
$function$;

-- Last: nothing above calls it any more.
DROP FUNCTION IF EXISTS public.stage_position(uuid, text);
