-- 096_admissions_applications.sql  (KB-ADMISSIONS-R1)
-- Release 1 of the admissions pipeline. Safe to run twice. Rollback: 096_rollback.sql (added with the apply script).
--
-- Task 9: one application per student (keyed by contact, ruling R-1), its RLS, the registration-number mirror into
-- contacts.university_roll_number, and backfill_applications(account). The migration does NOT call the backfill: the
-- apply script does, in the same transaction as the rest of 096.
-- Later tasks append their sections below the marked line.

-- 1. applications ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.applications (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL UNIQUE REFERENCES public.contacts(id) ON DELETE CASCADE,
  university text,
  father_name text,
  program text,
  specialization text,
  details_punched_at timestamptz,
  details_punched_by uuid,
  provisional_app_id text,
  form_filled_by_kind text CHECK (form_filled_by_kind IN ('student', 'staff')),
  form_filled_by uuid,
  form_filled_at timestamptz,
  registration_number text,
  enrolled_at timestamptz,
  backfilled boolean NOT NULL DEFAULT false,
  retain_files boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS applications_account_provisional_app_id ON public.applications (account_id, provisional_app_id);

ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.applications FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.applications TO authenticated;
GRANT ALL ON public.applications TO service_role;

DROP POLICY IF EXISTS applications_select ON public.applications;
CREATE POLICY applications_select ON public.applications FOR SELECT
  USING (public.is_account_member(account_id, 'viewer'::public.account_role_enum));
DROP POLICY IF EXISTS applications_insert ON public.applications;
CREATE POLICY applications_insert ON public.applications FOR INSERT
  WITH CHECK (public.is_account_member(account_id, 'agent'::public.account_role_enum));
DROP POLICY IF EXISTS applications_update ON public.applications;
CREATE POLICY applications_update ON public.applications FOR UPDATE
  USING (public.is_account_member(account_id, 'agent'::public.account_role_enum))
  WITH CHECK (public.is_account_member(account_id, 'agent'::public.account_role_enum));

-- Same restrictive policy as 094 gives the other per-student tables: a counsellor-number-only contact's application
-- is visible only to whoever can see that contact (admin and owner).
DROP POLICY IF EXISTS hide_counsellor_number_contacts ON public.applications;
CREATE POLICY hide_counsellor_number_contacts ON public.applications AS RESTRICTIVE FOR ALL
  USING (contact_id IS NULL OR EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = applications.contact_id))
  WITH CHECK (contact_id IS NULL OR EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = applications.contact_id));

DROP TRIGGER IF EXISTS set_updated_at ON public.applications;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.applications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. registration number -> contacts.university_roll_number ---------------------------------------------------------------
-- SECURITY DEFINER: an agent saves the application; the contact write must not depend on that agent's contact policies.
CREATE OR REPLACE FUNCTION public.mirror_registration_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.contacts SET university_roll_number = NEW.registration_number
   WHERE id = NEW.contact_id AND NEW.registration_number IS NOT NULL
     AND university_roll_number IS DISTINCT FROM NEW.registration_number;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mirror_registration_number() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mirror_registration_number() TO service_role;

DROP TRIGGER IF EXISTS applications_mirror_registration ON public.applications;
CREATE TRIGGER applications_mirror_registration AFTER INSERT OR UPDATE OF registration_number ON public.applications
  FOR EACH ROW EXECUTE FUNCTION public.mirror_registration_number();

-- 3. backfill_applications ------------------------------------------------------------------------------------------------
-- One row per contact that has a deal at Application Started or later on an admissions board, Lost and Not Interested
-- excluded. Positions come from stage_position(), never a literal. Registration number from the roll number, university,
-- program and specialization from the fee plan (student_fee_plans.program / .specialization, same names). Writes no deal
-- or stage event; app.suppress_automation is on for the call only (set_config local). Returns the rows inserted.
-- Called by the apply script (service_role / postgres), not by the migration.
CREATE OR REPLACE FUNCTION public.backfill_applications(p_account_id uuid)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  PERFORM set_config('app.suppress_automation', 'on', true);
  INSERT INTO public.applications (account_id, contact_id, university, program, specialization, registration_number, backfilled)
  SELECT p_account_id, c.id, fp.university, fp.program, fp.specialization, c.university_roll_number, true
    FROM public.contacts c
    LEFT JOIN public.student_fee_plans fp ON fp.contact_id = c.id
   WHERE c.account_id = p_account_id
     AND EXISTS (
       SELECT 1 FROM public.deals d
         JOIN public.pipeline_stages s ON s.id = d.stage_id
        WHERE d.contact_id = c.id AND d.account_id = p_account_id
          AND s.name NOT IN ('Lost', 'Not Interested')
          AND public.stage_position(d.pipeline_id, 'Application Started') IS NOT NULL
          AND s.position >= public.stage_position(d.pipeline_id, 'Application Started'))
  ON CONFLICT (contact_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.suppress_automation', 'off', true);
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.backfill_applications(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_applications(uuid) TO service_role;

-- ===== end of Task 9. Tasks 10-17 append their sections below this line. =====
