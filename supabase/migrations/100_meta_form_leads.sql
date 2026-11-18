-- 100_meta_form_leads.sql  (KB-FORMLEADS)
-- Meta instant-form leads into Kuanli. Owner decisions 2026-11-18: an n8n workflow polls the Page's form leads every
-- 2 minutes; every form lead goes to one named counsellor ("always", even when another counsellor had the student) and
-- is alerted on ntfy. This migration is the database half; the workflow calls only these functions.
--
-- 1. meta_form_leads: one row per Meta lead id (the dedupe key), with the answers, the contact and deal it landed on,
--    the counsellor it went to and when, the owner it took over from, and the alert it produced. Deleting the contact
--    scrubs the row's personal data (the lead id stays, so the lead is never ingested again).
-- 2. meta_form_lead_sync: per-Page poll state (last good poll, consecutive failures, last error, last ops alert sent).
-- 3. ingest_form_lead(account, counsellor, intake pipeline, floor, lead): atomic, idempotent per lead id, never raises
--    (an error comes back as {status: 'error', message}). New id: find the contact by phone (91XXXXXXXXXX, else the
--    digits) or create it (source 'ads'; a WhatsApp webhook creating the same phone at the same moment is joined, not
--    fought). Unless the student is in an active admission (newest deal won, or open at Application Started or
--    later: that stays with its counsellor, and the alert says who and where), the counsellor takes over like an admin
--    reassignment: owner, the ordinary-number chats, the newest deal (a lost one is reopened on its board's first
--    stage) or a new deal on the intake board's New Lead. The deal is snoozed 30 days from the Lost sweep (counsellors
--    reply from their own phones, so bot-number silence says nothing). One note with the answers. Known id: 'duplicate'.
-- 4. Alerts: form_lead_pending_alerts is the outbox (unalerted rows of the last 7 days, one 5-minute lease per send,
--    so overlapping polls never alert twice); form_lead_alerted marks a sent one. Poll bookkeeping:
--    form_lead_poll_window (re-reads 24 hours, or from an hour before the last good poll after an outage, never
--    before the floor), _ok, _failed (an ops alert is due from the 3rd failure in a row until form_lead_ops_alerted
--    acknowledges it, then every 2 hours), errors stored with access tokens redacted.
-- 5. pick_counsellor (097): the sticky step also counts form-lead hand-offs; the latest hand-off wins.
-- 6. contact_owner_from_assignment (098): a WhatsApp assignment to the counsellor who already got the student through
--    the form does not re-own the lead, so an admin's reassignment in between stands (as for a repeat assignment).
-- Service role only: RLS on with no policies, nothing granted to anon or authenticated. No ids or names here: the
-- workflow passes them (this repo is public). Run with psql -1. Rollback: 100_rollback.sql.

SET LOCAL lock_timeout = '5s';

-- 1. ledger -----------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meta_form_leads (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  leadgen_id                text NOT NULL UNIQUE CHECK (leadgen_id ~ '^[0-9]{5,25}$'),
  page_id                   text,
  form_id                   text,
  form_name                 text,
  ad_id                     text,
  ad_name                   text,
  adset_name                text,
  campaign_id               text,
  campaign_name             text,
  is_organic                boolean,
  platform                  text,
  lead_created_at           timestamptz NOT NULL,
  field_data                jsonb NOT NULL DEFAULT '[]'::jsonb,
  name                      text,
  phone                     text NOT NULL DEFAULT '',
  email                     text,
  contact_id                uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  deal_id                   uuid REFERENCES public.deals(id) ON DELETE SET NULL,
  counsellor_id             uuid REFERENCES public.counsellors(id) ON DELETE SET NULL,   -- NULL: not handed over (admission)
  assigned_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  contact_was_new           boolean NOT NULL,
  previous_owner_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  alert                     jsonb NOT NULL,
  alert_claimed_at          timestamptz,
  alerted_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meta_form_leads_contact ON public.meta_form_leads (contact_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS meta_form_leads_unalerted ON public.meta_form_leads (account_id, created_at) WHERE alerted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.meta_form_lead_sync (
  page_id       text PRIMARY KEY CHECK (page_id ~ '^[0-9]{5,25}$'),
  last_ok_at    timestamptz,
  failures      integer NOT NULL DEFAULT 0,
  last_error    text,
  last_error_at timestamptz,
  last_alert_at timestamptz
);

ALTER TABLE public.meta_form_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_form_lead_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_form_leads, public.meta_form_lead_sync FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.meta_form_leads, public.meta_form_lead_sync TO service_role;

-- The contact went (a delete, or a merge into another contact): its personal data leaves the ledger too.
CREATE OR REPLACE FUNCTION public.meta_form_leads_scrub()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.contact_id IS NOT NULL AND NEW.contact_id IS NULL THEN
    NEW.field_data := '[]'::jsonb; NEW.name := NULL; NEW.phone := ''; NEW.email := NULL; NEW.alert := '{}'::jsonb;
    NEW.alerted_at := coalesce(NEW.alerted_at, now());
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.meta_form_leads_scrub() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS meta_form_leads_scrub ON public.meta_form_leads;
CREATE TRIGGER meta_form_leads_scrub BEFORE UPDATE OF contact_id ON public.meta_form_leads
  FOR EACH ROW EXECUTE FUNCTION public.meta_form_leads_scrub();

-- 2. helpers ----------------------------------------------------------------------------------------------------------
-- normalizeIndianPhone (wacrm/src/lib/admissions/normalize.ts), else the bare digits (8+), else ''.
CREATE OR REPLACE FUNCTION public.form_lead_phone(p_raw text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN d ~ '^[6-9][0-9]{9}$' THEN '91' || d
    WHEN d ~ '^91[6-9][0-9]{9}$' THEN d
    WHEN d ~ '^0[6-9][0-9]{9}$' THEN '91' || substr(d, 2)
    WHEN length(d) BETWEEN 8 AND 15 THEN d
    ELSE '' END
  FROM (SELECT regexp_replace(coalesce(p_raw, ''), '\D', '', 'g') AS d) x
$$;

-- Access tokens never reach the ledger, the ops alert or a terminal.
CREATE OR REPLACE FUNCTION public.form_lead_redact(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT regexp_replace(regexp_replace(coalesce(p_text, ''),
           '(access_token=|Bearer\s+|access token\s+)[^\s&"'']+', '\1[redacted]', 'gi'),
           'EAA[A-Za-z0-9]{10,}', 'EAA[redacted]', 'g')
$$;

-- 3. ingest -----------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_form_lead(p_account uuid, p_counsellor uuid, p_pipeline uuid, p_floor timestamptz,
                                                   p_lead jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '10s' AS $$
DECLARE
  v_id        text := p_lead->>'id';
  v_created   timestamptz;
  v_c         public.counsellors%ROWTYPE;
  f           jsonb;
  v_vals      jsonb;
  v_key       text;
  v_val       text;
  v_full      text;
  v_first     text;
  v_last      text;
  v_name      text;
  v_raw_phone text;
  v_phone     text;
  v_email     text;
  v_answers   jsonb := '[]'::jsonb;
  v_contact   public.contacts%ROWTYPE;
  v_new       boolean := false;
  v_prev      uuid;
  v_prev_name text;
  v_deal      public.deals%ROWTYPE;
  v_stage     text;
  v_stage_pos integer;
  v_app_pos   integer;
  v_protected boolean := false;
  v_first_st  uuid;
  v_reopened  boolean := false;
  v_conv      uuid;
  v_note      text;
  v_alert     jsonb;
  v_lead_row  uuid := gen_random_uuid();
  v_state     text;
  v_msg       text;
BEGIN
  BEGIN
    IF v_id IS NULL OR v_id !~ '^[0-9]{5,25}$' THEN
      RAISE EXCEPTION 'lead id must be Meta''s numeric id' USING ERRCODE = '22023';
    END IF;
    IF p_floor IS NULL THEN RAISE EXCEPTION 'a floor time is required' USING ERRCODE = '22023'; END IF;
    SELECT * INTO v_c FROM public.counsellors WHERE id = p_counsellor AND account_id = p_account;
    IF NOT FOUND THEN RAISE EXCEPTION 'counsellor is not in this account' USING ERRCODE = '22023'; END IF;
    IF v_c.profile_id IS NULL THEN RAISE EXCEPTION 'counsellor has no Kuanli login, so the lead would have no owner' USING ERRCODE = '22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pipelines p JOIN public.pipeline_stages s ON s.pipeline_id = p.id
                    WHERE p.id = p_pipeline AND p.account_id = p_account AND s.name NOT IN ('Lost', 'Not Interested')) THEN
      RAISE EXCEPTION 'pipeline is not in this account or has no open stage' USING ERRCODE = '22023';
    END IF;
    -- Meta's time; a missing or unreadable one means "just now" (never a silent skip).
    BEGIN
      v_created := (p_lead->>'created_time')::timestamptz;
    EXCEPTION WHEN others THEN v_created := NULL;
    END;
    v_created := coalesce(v_created, now());
    IF v_created < p_floor THEN
      RETURN jsonb_build_object('status', 'skipped_floor', 'leadgen_id', v_id);
    END IF;

    -- Two overlapping polls must not both take the same lead.
    PERFORM pg_advisory_xact_lock(hashtextextended('meta_form_lead:' || v_id, 0));
    IF EXISTS (SELECT 1 FROM public.meta_form_leads WHERE leadgen_id = v_id) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'leadgen_id', v_id);
    END IF;

    -- Answers. Meta's standard keys feed the contact; everything else is a question, prettified.
    FOR f IN SELECT * FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_lead->'field_data') = 'array' THEN p_lead->'field_data' ELSE '[]'::jsonb END) LOOP
      CONTINUE WHEN jsonb_typeof(f) <> 'object' OR coalesce(btrim(f->>'name'), '') = '';
      v_vals := CASE jsonb_typeof(f->'values') WHEN 'array' THEN f->'values' WHEN 'string' THEN jsonb_build_array(f->'values') ELSE '[]'::jsonb END;
      SELECT left(btrim(string_agg(x, ', ')), 300) INTO v_val FROM jsonb_array_elements_text(v_vals) x;
      CONTINUE WHEN v_val IS NULL OR v_val = '';
      v_key := lower(f->>'name');
      CASE v_key
        WHEN 'full_name' THEN v_full := v_val;
        WHEN 'first_name' THEN v_first := v_val;
        WHEN 'last_name' THEN v_last := v_val;
        WHEN 'phone_number', 'phone' THEN v_raw_phone := v_val;
        WHEN 'email' THEN v_email := lower(v_val);
        ELSE
          v_key := btrim(regexp_replace(replace(f->>'name', '_', ' '), '\s+', ' ', 'g'));
          v_answers := v_answers || jsonb_build_array(jsonb_build_object(
            'q', left(upper(left(v_key, 1)) || substr(v_key, 2), 120), 'a', v_val));
      END CASE;
    END LOOP;
    v_name := left(coalesce(v_full, nullif(btrim(concat_ws(' ', v_first, v_last)), '')), 100);
    v_phone := public.form_lead_phone(v_raw_phone);

    -- Contact: the account's lead with this phone, else a new one. A WhatsApp webhook inserting the same phone at the
    -- same moment wins the unique index; then this joins its row.
    IF v_phone <> '' THEN
      SELECT * INTO v_contact FROM public.contacts
       WHERE account_id = p_account AND phone_normalized = v_phone FOR UPDATE;
    END IF;
    IF v_contact.id IS NULL THEN
      INSERT INTO public.contacts (account_id, user_id, phone, name, email, source, source_detail)
      SELECT p_account, a.owner_user_id, v_phone, coalesce(v_name, nullif(v_phone, ''), 'Form lead'), v_email, 'ads',
             left('FB lead form: ' || coalesce(p_lead->>'campaign_name', '?') || ' / ' || coalesce(p_lead->>'ad_name', '?'), 200)
        FROM public.accounts a WHERE a.id = p_account
      ON CONFLICT (account_id, phone_normalized) WHERE (phone_normalized <> '') DO NOTHING
      RETURNING * INTO v_contact;
      v_new := v_contact.id IS NOT NULL;
      IF NOT v_new THEN
        SELECT * INTO v_contact FROM public.contacts
         WHERE account_id = p_account AND phone_normalized = v_phone FOR UPDATE;
      END IF;
    END IF;
    IF NOT v_new THEN
      v_prev := v_contact.owner_profile_id;
      UPDATE public.contacts
         SET name = CASE WHEN v_name IS NOT NULL AND (name IS NULL OR btrim(name) = '' OR regexp_replace(name, '\D', '', 'g') = phone_normalized)
                         THEN v_name ELSE name END,
             email = coalesce(email, v_email)
       WHERE id = v_contact.id;
    END IF;

    -- The newest deal decides: an active admission stays with its counsellor.
    SELECT * INTO v_deal FROM public.deals WHERE contact_id = v_contact.id AND account_id = p_account
     ORDER BY created_at DESC NULLS LAST LIMIT 1 FOR UPDATE;
    IF v_deal.id IS NOT NULL THEN
      SELECT s.name, s.position INTO v_stage, v_stage_pos FROM public.pipeline_stages s WHERE s.id = v_deal.stage_id;
      v_app_pos := public.stage_position(v_deal.pipeline_id, 'Application Started');
      v_protected := v_deal.status = 'won'
        OR (coalesce(v_deal.status, 'open') <> 'lost' AND v_stage NOT IN ('Lost', 'Not Interested') AND v_app_pos IS NOT NULL AND v_stage_pos >= v_app_pos);
    END IF;

    IF v_protected THEN
      SELECT full_name INTO v_prev_name FROM public.profiles WHERE id = v_contact.owner_profile_id;
    ELSE
      -- Takeover, as an admin's reassignment in Kuanli does it (098 set_contact_owner): owner and ordinary-number chats.
      PERFORM public.set_owner_trusted(v_contact.id, v_c.profile_id, 'form_lead', false);
      UPDATE public.conversations cv SET assigned_agent_id = v_c.profile_id, updated_at = now()
       WHERE cv.contact_id = v_contact.id AND cv.assigned_agent_id IS DISTINCT FROM v_c.profile_id
         AND NOT coalesce(cv.phone_number_id = ANY (public.counsellor_phone_number_ids()), false);
      PERFORM public.set_lead_branch(v_contact.id, v_c.branch_id);
      IF v_prev IS NOT NULL AND v_prev IS DISTINCT FROM v_c.profile_id THEN
        SELECT full_name INTO v_prev_name FROM public.profiles WHERE id = v_prev;
      END IF;
      IF v_deal.id IS NULL THEN
        SELECT id INTO v_first_st FROM public.pipeline_stages WHERE pipeline_id = p_pipeline AND name NOT IN ('Lost', 'Not Interested')
         ORDER BY (name = 'New Lead') DESC, position LIMIT 1;
        -- 094: a chat on a counsellor number stays private; never point a deal at one.
        SELECT cv.id INTO v_conv FROM public.conversations cv
         WHERE cv.contact_id = v_contact.id AND NOT coalesce(cv.phone_number_id = ANY (public.counsellor_phone_number_ids()), false)
         ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1;
        INSERT INTO public.deals (account_id, user_id, pipeline_id, stage_id, contact_id, conversation_id, title, value, currency,
                                  notes, assigned_to, lost_snooze_until)
        SELECT p_account, a.owner_user_id, p_pipeline, v_first_st, v_contact.id, v_conv,
               'Lead - ' || coalesce(nullif(v_phone, ''), v_name, 'form'), 0, 'INR', 'Source: FB lead form', v_c.profile_id,
               now() + interval '30 days'
          FROM public.accounts a WHERE a.id = p_account
        RETURNING * INTO v_deal;
      ELSE
        IF v_deal.status = 'lost' OR v_stage IN ('Lost', 'Not Interested') THEN
          SELECT id INTO v_first_st FROM public.pipeline_stages
           WHERE pipeline_id = v_deal.pipeline_id AND name NOT IN ('Lost', 'Not Interested')
           ORDER BY (name = 'New Lead') DESC, position LIMIT 1;
          v_reopened := v_first_st IS NOT NULL;
        END IF;
        UPDATE public.deals
           SET assigned_to = v_c.profile_id,
               stage_id = CASE WHEN v_reopened AND v_stage IN ('Lost', 'Not Interested') THEN v_first_st ELSE stage_id END,
               status = CASE WHEN v_reopened THEN 'open' ELSE status END,
               lost_snooze_until = greatest(coalesce(lost_snooze_until, now()), now() + interval '30 days')
         WHERE id = v_deal.id;
      END IF;
    END IF;

    v_note := left('FB lead form (added automatically) - ' || coalesce(p_lead->>'form_name', 'form') || ', '
      || coalesce(p_lead->>'campaign_name', '?') || ' / ' || coalesce(p_lead->>'ad_name', '?')
      || ', submitted ' || to_char(v_created AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ' IST'
      || CASE WHEN v_protected THEN E'\nNot moved: in admission (' || coalesce(v_stage, '?') || ')' ELSE '' END
      || coalesce(E'\nName: ' || v_name, '') || coalesce(E'\nPhone: ' || nullif(v_raw_phone, ''), '') || coalesce(E'\nEmail: ' || v_email, '')
      || coalesce((SELECT string_agg(E'\n' || (x->>'q') || ': ' || (x->>'a'), '') FROM jsonb_array_elements(v_answers) x), ''), 2000);
    INSERT INTO public.contact_notes (contact_id, account_id, user_id, note_text)
    SELECT v_contact.id, p_account, a.owner_user_id, v_note FROM public.accounts a WHERE a.id = p_account;

    v_alert := jsonb_build_object(
      'status', 'new', 'lead_row_id', v_lead_row, 'leadgen_id', v_id, 'contact_id', v_contact.id, 'contact_was_new', v_new,
      'deal_id', v_deal.id, 'deal_reopened', v_reopened, 'protected', v_protected, 'stage', CASE WHEN v_protected THEN v_stage END,
      'current_owner', CASE WHEN v_protected THEN v_prev_name END, 'previous_owner', CASE WHEN NOT v_protected THEN v_prev_name END,
      'was_theirs', NOT v_new AND v_prev IS NOT DISTINCT FROM v_c.profile_id,
      'name', v_name, 'phone', v_phone, 'raw_phone', v_raw_phone, 'email', v_email, 'answers', v_answers, 'counsellor', v_c.display_name,
      'topic', 'leads-' || lower(regexp_replace(v_c.display_name, '[^A-Za-z0-9]', '', 'g')),
      'form_name', p_lead->>'form_name', 'campaign_name', p_lead->>'campaign_name', 'ad_name', p_lead->>'ad_name',
      'is_organic', CASE lower(p_lead->>'is_organic') WHEN 'true' THEN true WHEN 'false' THEN false END, 'lead_created_at', v_created);
    INSERT INTO public.meta_form_leads (id, account_id, leadgen_id, page_id, form_id, form_name, ad_id, ad_name, adset_name,
      campaign_id, campaign_name, is_organic, platform, lead_created_at, field_data, name, phone, email, contact_id, deal_id,
      counsellor_id, contact_was_new, previous_owner_profile_id, alert, alert_claimed_at)
    VALUES (v_lead_row, p_account, v_id, p_lead->>'page_id', p_lead->>'form_id', p_lead->>'form_name', p_lead->>'ad_id',
      p_lead->>'ad_name', p_lead->>'adset_name', p_lead->>'campaign_id', p_lead->>'campaign_name', (v_alert->>'is_organic')::boolean,
      p_lead->>'platform', v_created, CASE WHEN jsonb_typeof(p_lead->'field_data') = 'array' THEN p_lead->'field_data' ELSE '[]'::jsonb END,
      v_name, v_phone, v_email, v_contact.id, v_deal.id,
      CASE WHEN NOT v_protected THEN v_c.id END, v_new, CASE WHEN NOT v_protected AND v_prev IS DISTINCT FROM v_c.profile_id THEN v_prev END,
      v_alert, clock_timestamp());
    RETURN v_alert;
  EXCEPTION WHEN others THEN
    -- Everything above is undone; the workflow counts the poll as failed and retries the lead next time.
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    RETURN jsonb_build_object('status', 'error', 'leadgen_id', v_id, 'message', left(v_state || ' ' || public.form_lead_redact(v_msg), 300));
  END;
END $$;

-- 4. alerts and poll bookkeeping --------------------------------------------------------------------------------------
-- The outbox: alerts not yet sent (ntfy down, a crash between ingest and send), at most 50 per poll, each leased for
-- 5 minutes so an overlapping poll never sends the same one.
CREATE OR REPLACE FUNCTION public.form_lead_pending_alerts(p_account uuid)
RETURNS SETOF jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '10s' AS $$
  UPDATE public.meta_form_leads l SET alert_claimed_at = clock_timestamp()
   WHERE l.id IN (SELECT x.id FROM public.meta_form_leads x
                   WHERE x.account_id = p_account AND x.alerted_at IS NULL AND x.created_at > now() - interval '7 days'
                     AND (x.alert_claimed_at IS NULL OR x.alert_claimed_at < clock_timestamp() - interval '5 minutes')
                   ORDER BY x.created_at LIMIT 50 FOR UPDATE SKIP LOCKED)
  RETURNING l.alert || jsonb_build_object('status', 'retry_alert')
$$;

CREATE OR REPLACE FUNCTION public.form_lead_alerted(p_lead_row uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.meta_form_leads SET alerted_at = now() WHERE id = p_lead_row AND alerted_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.form_lead_poll_window(p_page text, p_floor timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_floor IS NULL THEN RAISE EXCEPTION 'a floor time is required' USING ERRCODE = '22023'; END IF;
  RETURN greatest(p_floor, least(now() - interval '24 hours',
           coalesce((SELECT last_ok_at FROM public.meta_form_lead_sync WHERE page_id = p_page) - interval '1 hour', '-infinity')));
END $$;

CREATE OR REPLACE FUNCTION public.form_lead_poll_ok(p_page text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_failures integer; v_alerted timestamptz;
BEGIN
  SELECT failures, last_alert_at INTO v_failures, v_alerted FROM public.meta_form_lead_sync WHERE page_id = p_page FOR UPDATE;
  INSERT INTO public.meta_form_lead_sync (page_id, last_ok_at, failures) VALUES (p_page, now(), 0)
  ON CONFLICT (page_id) DO UPDATE SET last_ok_at = now(), failures = 0, last_alert_at = NULL;
  -- "Recovered" only after an outage someone was told about.
  RETURN jsonb_build_object('recovered', coalesce(v_failures, 0) >= 3 AND v_alerted IS NOT NULL, 'failures', coalesce(v_failures, 0));
END $$;

-- An ops alert is due from the 3rd failure in a row until one is acknowledged (form_lead_ops_alerted), then again 2
-- hours after the last acknowledged one. Errors are stored with access tokens redacted.
CREATE OR REPLACE FUNCTION public.form_lead_poll_failed(p_page text, p_error text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.meta_form_lead_sync%ROWTYPE;
BEGIN
  INSERT INTO public.meta_form_lead_sync (page_id, failures, last_error, last_error_at)
  VALUES (p_page, 1, left(public.form_lead_redact(p_error), 500), now())
  ON CONFLICT (page_id) DO UPDATE SET failures = meta_form_lead_sync.failures + 1, last_error = EXCLUDED.last_error, last_error_at = now()
  RETURNING * INTO s;
  RETURN jsonb_build_object('alert', s.failures >= 3 AND (s.last_alert_at IS NULL OR s.last_alert_at <= now() - interval '2 hours'),
                            'failures', s.failures, 'error', s.last_error, 'last_ok_at', s.last_ok_at);
END $$;

CREATE OR REPLACE FUNCTION public.form_lead_ops_alerted(p_page text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.meta_form_lead_sync SET last_alert_at = now() WHERE page_id = p_page
$$;

REVOKE ALL ON FUNCTION public.form_lead_phone(text), public.form_lead_redact(text),
  public.ingest_form_lead(uuid, uuid, uuid, timestamptz, jsonb), public.form_lead_pending_alerts(uuid),
  public.form_lead_poll_window(text, timestamptz), public.form_lead_poll_ok(text), public.form_lead_poll_failed(text, text),
  public.form_lead_ops_alerted(text), public.form_lead_alerted(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.form_lead_phone(text), public.form_lead_redact(text),
  public.ingest_form_lead(uuid, uuid, uuid, timestamptz, jsonb), public.form_lead_pending_alerts(uuid),
  public.form_lead_poll_window(text, timestamptz), public.form_lead_poll_ok(text), public.form_lead_poll_failed(text, text),
  public.form_lead_ops_alerted(text), public.form_lead_alerted(uuid) TO service_role;

-- 5. pick_counsellor (097) ------------------------------------------------------------------------------------------
-- As live (097) except the sticky step, which now also counts form-lead hand-offs: the latest hand-off wins, so a
-- student given to a counsellor through the form goes to the same counsellor when they ask for one on WhatsApp.
CREATE OR REPLACE FUNCTION public.pick_counsellor(p_account uuid, p_contact uuid, p_branch uuid)
RETURNS TABLE (counsellor_id uuid, is_new boolean, pool_branch_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_id     uuid;
  v_active boolean;
BEGIN
  SELECT x.id, x.active INTO v_id, v_active
    FROM (SELECT c.id, c.active, a.assigned_at AS at
            FROM public.counsellor_assignments a JOIN public.counsellors c ON c.id = a.counsellor_id
           WHERE a.contact_id = p_contact AND c.account_id = p_account
          UNION ALL
          SELECT c.id, c.active, f.assigned_at
            FROM public.meta_form_leads f JOIN public.counsellors c ON c.id = f.counsellor_id
           WHERE f.contact_id = p_contact AND c.account_id = p_account) x
   ORDER BY x.at DESC LIMIT 1;
  IF v_id IS NOT NULL AND v_active THEN
    RETURN QUERY SELECT v_id, false, p_branch;
    RETURN;
  END IF;

  IF p_branch IS NOT NULL THEN
    SELECT c.id INTO v_id
      FROM public.counsellors c
      LEFT JOIN LATERAL (SELECT max(a.assigned_at) AS last FROM public.counsellor_assignments a
                          WHERE a.counsellor_id = c.id AND a.pool_branch_id = p_branch) l ON true
     WHERE c.account_id = p_account AND c.active AND c.branch_id = p_branch
     ORDER BY l.last NULLS FIRST, c.created_at, c.id
     LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_id, true, p_branch;
      RETURN;
    END IF;
  END IF;

  SELECT c.id INTO v_id
    FROM public.counsellors c
    LEFT JOIN LATERAL (SELECT max(a.assigned_at) AS last FROM public.counsellor_assignments a
                        WHERE a.counsellor_id = c.id AND a.pool_branch_id IS NULL) l ON true
   WHERE c.account_id = p_account AND c.active
   ORDER BY l.last NULLS FIRST, c.created_at, c.id
   LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_id, true, NULL::uuid;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.pick_counsellor(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pick_counsellor(uuid, uuid, uuid) TO service_role;


-- 6. contact_owner_from_assignment (098) -----------------------------------------------------------------------------
-- As live (098) except the skip test: a counsellor who already got the student through the form (like one who already
-- had an assignment) does not re-own the lead, so an admin's reassignment made in between stands.
CREATE OR REPLACE FUNCTION public.contact_owner_from_assignment()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_profile uuid;
BEGIN
  SELECT c.profile_id INTO v_profile FROM public.counsellors c
    JOIN public.profiles p ON p.id = c.profile_id AND p.account_id = NEW.account_id   -- never abort the bot's handover
   WHERE c.id = NEW.counsellor_id;
  IF v_profile IS NULL OR EXISTS (SELECT 1 FROM public.counsellor_assignments a
                                   WHERE a.contact_id = NEW.contact_id AND a.counsellor_id = NEW.counsellor_id AND a.id <> NEW.id)
     OR EXISTS (SELECT 1 FROM public.meta_form_leads f WHERE f.contact_id = NEW.contact_id AND f.counsellor_id = NEW.counsellor_id) THEN
    RETURN NULL;
  END IF;
  PERFORM public.set_owner_trusted(NEW.contact_id, v_profile, 'assignment:' || NEW.assigned_via, false);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.contact_owner_from_assignment() FROM PUBLIC, anon, authenticated, service_role;
