-- ============================================================
-- 026_contact_enrollment_tracking.sql — DCId / enrollment fields
--
-- Backfills into source control what had only ever been applied
-- directly to the live database (via an untracked patch-db.sql
-- run by hand). Covers:
--   - roll_number / university / intake_year / intake_session
--     columns on contacts, plus the two id-generation triggers.
--   - update_contact_enrollment(), the RPC the enrollment UI in
--     the inbox contact sidebar calls to save these fields.
--
-- Security fix folded in
--
--   The live version of update_contact_enrollment had EXECUTE
--   granted to PUBLIC and did not check that the caller has any
--   relationship to the contact's account at all — any caller
--   (including unauthenticated `anon`, via PostgREST) who knew or
--   guessed a contact id could overwrite that contact's enrollment
--   fields for any account. This version adds the same
--   is_account_member(...) authorization check the RLS policies on
--   `contacts` already use (migration 017), requiring at least the
--   'agent' role in the contact's own account, and restricts
--   EXECUTE to `authenticated` — matching the convention in
--   migrations 018/019/025.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS roll_number TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS university TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS intake_year TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS intake_session TEXT;

CREATE SEQUENCE IF NOT EXISTS student_roll_seq START 1;
CREATE SEQUENCE IF NOT EXISTS temp_lead_seq START 1;

-- Assigns a placeholder "LD-YYMM-####" id to every new lead on insert,
-- so contacts always have a roll_number even before enrollment.
CREATE OR REPLACE FUNCTION generate_temp_lead_id() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.roll_number IS NULL THEN
        NEW.roll_number := 'LD-' || TO_CHAR(NOW(), 'YYMM') || '-' || LPAD(nextval('temp_lead_seq')::text, 4, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_generate_temp_lead ON contacts;
CREATE TRIGGER trigger_generate_temp_lead BEFORE INSERT ON contacts FOR EACH ROW EXECUTE FUNCTION generate_temp_lead_id();

-- Replaces the placeholder with a real "D<university><year><session>####"
-- roll number the first time a contact's university is set (enrollment).
CREATE OR REPLACE FUNCTION generate_roll_number() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.university IS NOT NULL AND OLD.university IS NULL THEN
        NEW.roll_number := 'D' || NEW.university || NEW.intake_year || NEW.intake_session || LPAD(nextval('student_roll_seq')::text, 4, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_generate_roll_number ON contacts;
CREATE TRIGGER trigger_generate_roll_number BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION generate_roll_number();

CREATE OR REPLACE FUNCTION public.update_contact_enrollment(
  p_contact_id UUID,
  p_university TEXT,
  p_intake_year TEXT,
  p_intake_session TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account_id FROM contacts WHERE id = p_contact_id;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Contact not found' USING ERRCODE = '22023';
  END IF;

  IF NOT is_account_member(v_account_id, 'agent'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires the agent role or higher in this contact''s account'
      USING ERRCODE = '42501';
  END IF;

  UPDATE contacts
  SET university = p_university,
      intake_year = p_intake_year,
      intake_session = p_intake_session
  WHERE id = p_contact_id;
END;
$$;

ALTER FUNCTION public.update_contact_enrollment(UUID, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_contact_enrollment(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_contact_enrollment(UUID, TEXT, TEXT, TEXT) TO authenticated;
