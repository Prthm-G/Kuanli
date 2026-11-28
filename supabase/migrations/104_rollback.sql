-- 104_rollback.sql (KB-JOURNEY-R1A): undo 104. Run in one transaction (psql -1).
-- Refuses while any applications.university_app_number holds a value (dropping the column loses it), unless the session
-- first runs: SET k104.drop_values = 'yes';
DO $$
DECLARE v_n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'university_app_number') THEN
    EXECUTE 'SELECT count(*) FROM public.applications WHERE university_app_number IS NOT NULL' INTO v_n;
    IF v_n > 0 AND coalesce(current_setting('k104.drop_values', true), '') <> 'yes' THEN
      RAISE EXCEPTION '104 rollback: % application(s) hold a university_app_number; back them up, then SET k104.drop_values = ''yes''', v_n;
    END IF;
  END IF;
END $$;
DROP TRIGGER IF EXISTS applications_punched_gate ON public.applications;
DROP FUNCTION IF EXISTS public.applications_punched_gate();
DROP FUNCTION IF EXISTS public.search_students(uuid, text);
DROP FUNCTION IF EXISTS public.is_placeholder_email(text);
DROP INDEX IF EXISTS public.applications_account_university_app_number;
ALTER TABLE public.applications DROP COLUMN IF EXISTS university_app_number;
