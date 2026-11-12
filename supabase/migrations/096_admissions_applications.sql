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

-- ===== Task 10: payment columns, frozen ledger, reversal, payment events =====
-- 'reversed' is added first. A new enum value cannot be used in the transaction that adds it, so the literal appears only
-- inside plpgsql bodies below (parsed when they run, not when they are created).
ALTER TYPE public.payment_status_enum ADD VALUE IF NOT EXISTS 'reversed';

-- Existing payments (the imported opening balances) count as course fees: head 'other' (ruling R-3). received_by stays
-- NULL on them: nobody recorded who held the money.
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS head public.fee_head_enum NOT NULL DEFAULT 'other';
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS received_by public.payment_party_enum;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS collected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.default_payment_collected_by() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.collected_by IS NULL THEN NEW.collected_by := NEW.logged_by; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payments_collected_by ON public.payments;
CREATE TRIGGER payments_collected_by BEFORE INSERT ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.default_payment_collected_by();

-- Frozen ledger: once a payment is verified or reversed its money fields never change (reverse it and log a new one), and
-- a reversed payment never goes back. Applies to every role, the service role included.
CREATE OR REPLACE FUNCTION public.freeze_acknowledged_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status::text IN ('verified', 'reversed')
     AND (NEW.amount, NEW.head, NEW.paid_at, NEW.contact_id, NEW.method, NEW.reference)
         IS DISTINCT FROM (OLD.amount, OLD.head, OLD.paid_at, OLD.contact_id, OLD.method, OLD.reference) THEN
    RAISE EXCEPTION 'payment % is acknowledged: reverse it and log a new one', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status::text = 'reversed' AND NEW.status::text <> 'reversed' THEN
    RAISE EXCEPTION 'payment % is reversed', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payments_freeze ON public.payments;
CREATE TRIGGER payments_freeze BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.freeze_acknowledged_payment();

-- One row per status change (and one for the first status of a new payment). Written only by the trigger below.
CREATE TABLE IF NOT EXISTS public.payment_events (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  old_status public.payment_status_enum,
  new_status public.payment_status_enum NOT NULL,
  actor uuid,
  note text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_events_payment ON public.payment_events (payment_id, at);
ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.payment_events TO authenticated, service_role;
REVOKE ALL ON SEQUENCE public.payment_events_id_seq FROM PUBLIC, anon, authenticated, service_role;
DROP POLICY IF EXISTS "Members read payment events" ON public.payment_events;
CREATE POLICY "Members read payment events" ON public.payment_events FOR SELECT
  USING (public.is_account_member(account_id));
-- Follows the payment's own visibility (counsellor-number chats stay hidden), like payment_receipts.
DROP POLICY IF EXISTS hide_counsellor_number_contacts ON public.payment_events;
CREATE POLICY hide_counsellor_number_contacts ON public.payment_events AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM public.payments p WHERE p.id = payment_events.payment_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.payments p WHERE p.id = payment_events.payment_id));

CREATE OR REPLACE FUNCTION public.log_payment_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NULL; END IF;
  INSERT INTO public.payment_events (account_id, payment_id, old_status, new_status, actor, note)
  VALUES (NEW.account_id, NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, auth.uid(), NEW.decision_note);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.log_payment_event() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS payments_log_event ON public.payments;
CREATE TRIGGER payments_log_event AFTER INSERT OR UPDATE OF status ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.log_payment_event();

-- Payments and their receipts are never deleted through the API (a cascade from a deleted contact still works).
REVOKE DELETE ON public.payments, public.payment_receipts FROM authenticated;

-- verified -> reversed, admin and above, note required. The only way a verified payment leaves the books.
CREATE OR REPLACE FUNCTION public.reverse_payment(p_payment_id uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_account uuid; v_status text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT account_id, status::text INTO v_account, v_status FROM public.payments WHERE id = p_payment_id;
  IF v_account IS NULL THEN RAISE EXCEPTION 'Payment not found' USING ERRCODE = '42704'; END IF;
  IF NOT public.is_account_member(v_account, 'admin'::public.account_role_enum) THEN
    RAISE EXCEPTION 'Reversing a payment requires admin in this account' USING ERRCODE = '42501';
  END IF;
  IF p_note IS NULL OR btrim(p_note) = '' THEN
    RAISE EXCEPTION 'A reason is required to reverse a payment' USING ERRCODE = '22023';
  END IF;
  IF v_status <> 'verified' THEN
    RAISE EXCEPTION 'Only a verified payment can be reversed (this one is %)', v_status USING ERRCODE = '22023';
  END IF;
  UPDATE public.payments SET status = 'reversed', decision_note = btrim(p_note) WHERE id = p_payment_id;
END $$;
REVOKE ALL ON FUNCTION public.reverse_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_payment(uuid, text) TO authenticated;

-- How many live payments in the account carry this reference (a possible double entry). Runs as the caller, so RLS
-- applies; rejected and reversed payments do not count; a blank reference never matches.
CREATE OR REPLACE FUNCTION public.duplicate_payment_reference(p_account_id uuid, p_reference text) RETURNS int
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_reference IS NULL OR btrim(p_reference) = '' THEN 0 ELSE
    (SELECT count(*)::int FROM public.payments p
      WHERE p.account_id = p_account_id AND p.status::text NOT IN ('rejected', 'reversed')
        AND lower(btrim(p.reference)) = lower(btrim(p_reference))) END $$;
REVOKE ALL ON FUNCTION public.duplicate_payment_reference(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.duplicate_payment_reference(uuid, text) TO authenticated;

-- ===== end of Task 10. Tasks 11-17 append their sections below this line. =====
