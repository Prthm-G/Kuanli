-- 095_admissions_stages.sql  (KB-ADMISSIONS-R0)
-- Admissions Release 0. Idempotent: every statement is safe to run twice.
-- Task 1: three new stages on every admissions board, and a position lookup by stage name.

SET LOCAL lock_timeout = '5s';

-- Callers compare stage positions through this helper, never against a literal number.
CREATE OR REPLACE FUNCTION public.stage_position(p_pipeline_id uuid, p_name text)
RETURNS int LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT position FROM public.pipeline_stages WHERE pipeline_id = p_pipeline_id AND name = p_name LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.stage_position(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stage_position(uuid, text) TO authenticated, service_role;

-- Provisional ID, Form & Documents and Fee Submitted go between Application Started and Enrolled on every board that
-- has an Application Started stage. Deals keep their stage rows (they point at stage ids); only positions shift.
-- The lock keeps a concurrent stage edit or a new board from interleaving with the shift.
LOCK TABLE public.pipeline_stages IN SHARE ROW EXCLUSIVE MODE;
DO $$
-- A board that already has some or all of the three names (095_rollback.sql keeps a stage with history at position 100+)
-- gets those rows back in place, same ids; only missing names are inserted. A board already correct is left alone.
DECLARE p record; v_min int; v_n int;
BEGIN
  FOR p IN SELECT pipeline_id, position AS app_pos FROM public.pipeline_stages WHERE name = 'Application Started' LOOP
    SELECT count(*) INTO v_n FROM public.pipeline_stages
     WHERE pipeline_id = p.pipeline_id
       AND (name, position) IN (('Provisional ID', p.app_pos + 1), ('Form & Documents', p.app_pos + 2), ('Fee Submitted', p.app_pos + 3));
    CONTINUE WHEN v_n = 3;
    -- The other stages after Application Started start at app_pos + 4.
    SELECT min(position) INTO v_min FROM public.pipeline_stages
     WHERE pipeline_id = p.pipeline_id AND position > p.app_pos AND name NOT IN ('Provisional ID', 'Form & Documents', 'Fee Submitted');
    IF v_min IS NOT NULL AND v_min < p.app_pos + 4 THEN
      UPDATE public.pipeline_stages SET position = position + (p.app_pos + 4 - v_min)
       WHERE pipeline_id = p.pipeline_id AND position > p.app_pos AND name NOT IN ('Provisional ID', 'Form & Documents', 'Fee Submitted');
    END IF;
    UPDATE public.pipeline_stages SET position = p.app_pos + CASE name WHEN 'Provisional ID' THEN 1 WHEN 'Form & Documents' THEN 2 ELSE 3 END
     WHERE pipeline_id = p.pipeline_id AND name IN ('Provisional ID', 'Form & Documents', 'Fee Submitted');
    INSERT INTO public.pipeline_stages (pipeline_id, name, position, color)
    SELECT p.pipeline_id, n.name, p.app_pos + n.off, n.color
      FROM (VALUES ('Provisional ID', 1, '#0ea5e9'), ('Form & Documents', 2, '#6366f1'), ('Fee Submitted', 3, '#14b8a6')) n(name, off, color)
     WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_stages x WHERE x.pipeline_id = p.pipeline_id AND x.name = n.name);
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

-- Task 3: the application tracker lists every deal from Application Started through Enrolled (so the three new stages too).
-- Body copied from 094_counsellor_number_privacy.sql; the stage test differs (a position range, not a name list) and rows are
-- ordered by the stage's position, not its name (the app shows the server order; by name, Enrolled would sort before the new stages).
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

  SELECT COALESCE(jsonb_agg(row ORDER BY sort_pos, row->>'name'), '[]'::jsonb)
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
    ) AS row, ps.position AS sort_pos
    FROM deals d
    JOIN pipeline_stages ps ON ps.id = d.stage_id
      AND ps.position BETWEEN public.stage_position(ps.pipeline_id, 'Application Started')
                          AND public.stage_position(ps.pipeline_id, 'Enrolled')
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

-- Task 3: a student's image or document is captured on any stage from Application Started through Enrolled.
-- Body copied from 094; only the stage test differs. lifecycle_sweep, funnel_analytics and pipeline_funnel are left alone on
-- purpose (ruling R-2): 095_test.sql proves the 14-day Lost sweep and the funnel read the same on the new ladder.
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
      AND ps.position BETWEEN public.stage_position(ps.pipeline_id, 'Application Started')
                          AND public.stage_position(ps.pipeline_id, 'Enrolled')
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO application_documents (account_id, contact_id, message_id, status)
  VALUES (v_account_id, v_contact_id, NEW.id, 'received');

  RETURN NEW;
END;
$function$;
