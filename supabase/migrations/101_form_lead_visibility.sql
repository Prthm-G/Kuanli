-- 101_form_lead_visibility.sql  (KB-FORMLEADS-101)
-- Form leads visible in Kuanli. Owner decision 2026-11-19: every form lead is tagged "Form lead", shows in its owner's
-- "My leads" and in every counsellor's "All". That is an exception to 098 (counsellors see only their own new leads),
-- for form leads only: they are opened to the team. A student already in admission with a counsellor (100 does not
-- move them) is not opened: their payments and documents stay with that counsellor. Own-number chats stay hidden (094).
--
-- 1. form_lead_tag(account): the account's "Form lead" tag, created once (by the account owner, amber).
-- 2. form_lead_surface(account, contact, at, open): tags the contact, opens it to the team when asked (contacts.
--    open_to_team, as 098 did for every older lead; never closes one); when it has no chat on a non-counsellor number, opens
--    one on the account's primary connected number, owned by the contact's owner, previewing "Filled the Facebook
--    form" at the form's time. Same thread key as the webhook (account, contact, number), so when the student later
--    writes to that number the webhook reuses it. The bot setting is the default for a new chat, as the webhook's.
--    Opening it clears the contact's counsellor-number-only flag (assign_lead_number_on_other_chat): the lead becomes
--    visible to the account; the counsellor-number chats themselves stay hidden. No primary number: tag only.
-- 3. A trigger runs it for every new meta_form_leads row, inside ingest_form_lead: if it fails, that lead comes back
--    as an error with nothing written, and the next poll tries it again (and the poll reports it).
-- 4. Backfill: every form lead already in the ledger, once per contact, at its first form's time; opened unless every
--    form it sent came while it was in admission.
-- Internal: nothing is granted to anon, authenticated or service_role. No ids or names here (this repo is public).
-- Run with psql -1. Rollback: 101_rollback.sql (tags and chats it made stay).

SET LOCAL lock_timeout = '5s';

-- 1. The tag ----------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.form_lead_tag(p_account uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tag uuid;
BEGIN
  -- tags has no unique name per account: concurrent polls take turns here.
  PERFORM pg_advisory_xact_lock(hashtextextended('form_lead_tag:' || p_account::text, 0));
  SELECT t.id INTO v_tag FROM tags t WHERE t.account_id = p_account AND lower(t.name) = 'form lead' ORDER BY t.created_at, t.id LIMIT 1;
  IF v_tag IS NULL THEN
    INSERT INTO tags (account_id, user_id, name, color)
    SELECT a.id, a.owner_user_id, 'Form lead', '#f59e0b' FROM accounts a WHERE a.id = p_account
    RETURNING id INTO v_tag;
    IF v_tag IS NULL THEN RAISE EXCEPTION 'form_lead_tag: account % not found', p_account; END IF;
  END IF;
  RETURN v_tag;
END $$;

-- 2. Tag + a chat the inbox can show -----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.form_lead_surface(p_account uuid, p_contact uuid, p_at timestamptz, p_open boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tag uuid; v_tagged int; v_number text; v_user uuid; v_owner uuid; v_chat uuid;
BEGIN
  v_tag := form_lead_tag(p_account);
  INSERT INTO contact_tags (contact_id, tag_id) VALUES (p_contact, v_tag) ON CONFLICT (contact_id, tag_id) DO NOTHING;
  GET DIAGNOSTICS v_tagged = ROW_COUNT;
  IF p_open THEN
    UPDATE contacts SET open_to_team = true WHERE id = p_contact AND account_id = p_account AND NOT open_to_team;
  END IF;
  IF EXISTS (SELECT 1 FROM conversations cv WHERE cv.account_id = p_account AND cv.contact_id = p_contact
              AND NOT coalesce(cv.phone_number_id = ANY (counsellor_phone_number_ids()), false)) THEN
    RETURN jsonb_build_object('tagged', v_tagged > 0, 'chat', NULL);
  END IF;
  SELECT w.phone_number_id, w.user_id INTO v_number, v_user FROM whatsapp_config w
   WHERE w.account_id = p_account AND w.is_primary AND w.status = 'connected'
     AND NOT coalesce(w.phone_number_id = ANY (counsellor_phone_number_ids()), false)
   ORDER BY w.created_at, w.id LIMIT 1;
  IF v_number IS NULL THEN RETURN jsonb_build_object('tagged', v_tagged > 0, 'chat', NULL, 'no_primary_number', true); END IF;
  SELECT c.owner_profile_id INTO v_owner FROM contacts c WHERE c.id = p_contact AND c.account_id = p_account;
  INSERT INTO conversations (account_id, user_id, contact_id, phone_number_id, status, assigned_agent_id, last_message_text, last_message_at)
  VALUES (p_account, v_user, p_contact, v_number, 'open', v_owner, 'Filled the Facebook form', coalesce(p_at, now()))
  ON CONFLICT (account_id, contact_id, phone_number_id) DO NOTHING
  RETURNING id INTO v_chat;
  RETURN jsonb_build_object('tagged', v_tagged > 0, 'chat', v_chat);
END $$;

-- 3. Every new form lead -----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.meta_form_leads_surface()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.contact_id IS NOT NULL THEN
    PERFORM form_lead_surface(NEW.account_id, NEW.contact_id, coalesce(NEW.lead_created_at, NEW.created_at),
                              NOT coalesce((NEW.alert->>'protected')::boolean, false));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS meta_form_leads_surface ON public.meta_form_leads;
CREATE TRIGGER meta_form_leads_surface AFTER INSERT ON public.meta_form_leads
  FOR EACH ROW EXECUTE FUNCTION public.meta_form_leads_surface();

REVOKE ALL ON FUNCTION public.form_lead_tag(uuid), public.form_lead_surface(uuid, uuid, timestamptz, boolean),
  public.meta_form_leads_surface() FROM PUBLIC, anon, authenticated, service_role;

-- 4. Form leads from before 101 ----------------------------------------------------------------------------------------
SELECT count(public.form_lead_surface(f.account_id, f.contact_id, f.at, f.open))
  FROM (SELECT l.account_id, l.contact_id, min(coalesce(l.lead_created_at, l.created_at)) AS at,
               bool_or(NOT coalesce((l.alert->>'protected')::boolean, false)) AS open
          FROM public.meta_form_leads l WHERE l.contact_id IS NOT NULL
         GROUP BY l.account_id, l.contact_id) f;
