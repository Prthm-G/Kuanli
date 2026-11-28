-- 106_rollback.sql (KB-JOURNEY-R1B): undo 106. Run in one transaction (psql -1).
-- Refuses while contact_links or contact_link_exclusions hold rows (dropping them loses counsellors' links), unless the
-- session first runs: SET k106.drop_values = 'yes';
DO $$
DECLARE v_links bigint := 0; v_excl bigint := 0;
BEGIN
  IF to_regclass('public.contact_links') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.contact_links' INTO v_links;
  END IF;
  IF to_regclass('public.contact_link_exclusions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.contact_link_exclusions' INTO v_excl;
  END IF;
  IF v_links + v_excl > 0 AND coalesce(current_setting('k106.drop_values', true), '') <> 'yes' THEN
    RAISE EXCEPTION '106 rollback: % link(s) and % exclusion(s) hold link rows; back them up, then SET k106.drop_values = ''yes''', v_links, v_excl;
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.student_timeline(uuid, uuid, timestamptz, integer);
DROP FUNCTION IF EXISTS public.student_contact_ids(uuid, uuid);
DROP FUNCTION IF EXISTS public.student_set(uuid, uuid);
DROP TABLE IF EXISTS public.contact_link_exclusions;
DROP TABLE IF EXISTS public.contact_links;
DROP FUNCTION IF EXISTS public.contact_link_exclusion_clears_link();
DROP FUNCTION IF EXISTS public.contact_link_refuses_excluded();
DROP INDEX IF EXISTS public.contacts_account_phone_last10;
DROP INDEX IF EXISTS public.contact_notes_contact_time;
-- Restore 104's punched gate exactly (106 replaced it with the FOR KEY SHARE version). Only when 104's trigger is present.
DO $restore$
BEGIN
  IF to_regprocedure('public.applications_punched_gate()') IS NOT NULL THEN
    EXECUTE $f$
CREATE OR REPLACE FUNCTION public.applications_punched_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_missing text[] := '{}'; v_email text;
BEGIN
  IF NEW.details_punched_at IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.details_punched_at IS NOT NULL THEN RETURN NEW; END IF;
  IF current_setting('role', true) NOT IN ('authenticated', 'anon')
     OR coalesce(auth.role(), '') = 'service_role'
     OR coalesce(current_setting('app.suppress_automation', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  SELECT email INTO v_email FROM public.contacts WHERE id = NEW.contact_id AND account_id = NEW.account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'contact not found in this account' USING ERRCODE = 'P0001'; END IF;
  -- PostgREST upserts (INSERT ... ON CONFLICT (contact_id) DO UPDATE) send only the changed columns, so the proposed row
  -- of this BEFORE INSERT call lacks the stored father_name/program/university. When a row already exists for the contact
  -- the INSERT leg steps aside; the UPDATE leg of the same upsert fires this trigger again with the merged row and checks it.
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM public.applications a
                                   WHERE a.contact_id = NEW.contact_id AND a.account_id = NEW.account_id) THEN
    RETURN NEW;
  END IF;
  IF nullif(btrim(NEW.father_name), '') IS NULL THEN v_missing := v_missing || 'father_name'::text; END IF;
  IF nullif(btrim(NEW.program), '') IS NULL THEN v_missing := v_missing || 'program'::text; END IF;
  IF nullif(btrim(NEW.university), '') IS NULL THEN v_missing := v_missing || 'university'::text; END IF;
  IF public.is_placeholder_email(v_email) THEN v_missing := v_missing || 'email'::text; END IF;
  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'missing: %', array_to_string(v_missing, ',') USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
$f$;
  END IF;
END $restore$;
