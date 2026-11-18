-- 100_rollback.sql  (KB-FORMLEADS)
-- Undo 100: the form-lead functions and tables go. Contacts, deals and notes it created stay (they are leads now);
-- the apply script saves both tables to CSV first. Run with psql -1.

SET LOCAL lock_timeout = '5s';

-- pick_counsellor back to 097 exactly as it was live (the body between the dollar quotes is byte-for-byte the live one;
-- the apply script checks its md5). It goes first: until then it reads meta_form_leads.
CREATE OR REPLACE FUNCTION public.pick_counsellor(p_account uuid, p_contact uuid, p_branch uuid)
 RETURNS TABLE(counsellor_id uuid, is_new boolean, pool_branch_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_id     uuid;
  v_active boolean;
BEGIN
  SELECT c.id, c.active INTO v_id, v_active
    FROM public.counsellor_assignments a JOIN public.counsellors c ON c.id = a.counsellor_id
   WHERE a.contact_id = p_contact AND c.account_id = p_account
   ORDER BY a.assigned_at DESC LIMIT 1;
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
END $function$;
REVOKE ALL ON FUNCTION public.pick_counsellor(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pick_counsellor(uuid, uuid, uuid) TO service_role;

-- contact_owner_from_assignment back to 098 exactly as live (it reads meta_form_leads until then).
CREATE OR REPLACE FUNCTION public.contact_owner_from_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_profile uuid;
BEGIN
  SELECT c.profile_id INTO v_profile FROM public.counsellors c
    JOIN public.profiles p ON p.id = c.profile_id AND p.account_id = NEW.account_id   -- never abort the bot's handover
   WHERE c.id = NEW.counsellor_id;
  IF v_profile IS NULL OR EXISTS (SELECT 1 FROM public.counsellor_assignments a
                                   WHERE a.contact_id = NEW.contact_id AND a.counsellor_id = NEW.counsellor_id AND a.id <> NEW.id) THEN
    RETURN NULL;
  END IF;
  PERFORM public.set_owner_trusted(NEW.contact_id, v_profile, 'assignment:' || NEW.assigned_via, false);
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.contact_owner_from_assignment() FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.ingest_form_lead(uuid, uuid, uuid, timestamptz, jsonb);
DROP FUNCTION IF EXISTS public.form_lead_poll_window(text, timestamptz);
DROP FUNCTION IF EXISTS public.form_lead_poll_ok(text);
DROP FUNCTION IF EXISTS public.form_lead_poll_failed(text, text);
DROP FUNCTION IF EXISTS public.form_lead_alerted(uuid);
DROP FUNCTION IF EXISTS public.form_lead_pending_alerts(uuid);
DROP FUNCTION IF EXISTS public.form_lead_ops_alerted(text);
DROP FUNCTION IF EXISTS public.form_lead_redact(text);
DROP FUNCTION IF EXISTS public.form_lead_phone(text);
DROP TABLE IF EXISTS public.meta_form_lead_sync;
DROP TABLE IF EXISTS public.meta_form_leads;
DROP FUNCTION IF EXISTS public.meta_form_leads_scrub();
