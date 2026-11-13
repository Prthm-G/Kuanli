-- 096_admissions_applications.sql  (KB-ADMISSIONS-R1)
-- Release 1 of the admissions pipeline. Safe to run twice. Rollback: 096_rollback.sql, run by devtools/apply-kuanli-096.mjs --rollback-db.
--
-- Task 9: one application per student (keyed by contact, ruling R-1), its RLS, the registration-number mirror into
-- contacts.university_roll_number, and backfill_applications(account). The migration does NOT call the backfill: the
-- apply script does, in the same transaction as the rest of 096.
-- Later tasks append their sections below the marked line.

-- 0. locks, up front ------------------------------------------------------------------------------------------------------
-- Every existing table this file alters, indexes, adds triggers to or references is locked once, here, in one statement and one
-- order: waiting (up to 5 s, then the apply script retries) happens before anything is held, and no lock is upgraded halfway
-- (the contacts / auth.users foreign keys below would otherwise take SHARE ROW EXCLUSIVE first and ACCESS EXCLUSIVE later).
-- applications, payment_events and document_access_log are only locked when a re-run finds them. A bare statement would fail
-- on a first run, so the list is built first. Same pattern as 098.
SET LOCAL lock_timeout = '5s';
DO $k096lock$
DECLARE v text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO v FROM (
    SELECT unnest(ARRAY['public.contacts', 'public.payments', 'public.student_portal_credentials', 'public.application_documents',
                        'public.student_fee_plans', 'auth.users']) AS t
    UNION
    SELECT t FROM unnest(ARRAY['public.applications', 'public.payment_events', 'public.document_access_log']) AS t
     WHERE to_regclass(t) IS NOT NULL) x;
  EXECUTE 'LOCK TABLE ' || v || ' IN ACCESS EXCLUSIVE MODE';
END $k096lock$;

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
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
-- or stage event; app.suppress_automation is on during the call and restored to the caller's value after it. Returns the rows inserted.
-- Called by the apply script (service_role / postgres), not by the migration.
CREATE OR REPLACE FUNCTION public.backfill_applications(p_account_id uuid)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_n integer; v_prev text;
BEGIN
  -- Put back whatever the caller had (an import may already hold the flag on); set_config cannot unset, so unset becomes ''.
  v_prev := coalesce(current_setting('app.suppress_automation', true), '');
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
  PERFORM set_config('app.suppress_automation', v_prev, true);
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- A logged-in caller below admin may only name themselves (or leave it empty). Owner and admin may name a member of
  -- this account. No auth.uid() (service role, imports): unchecked. SECURITY DEFINER so the profiles read is not
  -- filtered by the caller's RLS.
  IF auth.uid() IS NOT NULL AND NEW.collected_by IS NOT NULL AND NEW.collected_by IS DISTINCT FROM auth.uid() THEN
    IF NOT public.is_account_member(NEW.account_id, 'admin') THEN
      RAISE EXCEPTION 'collected_by must be you unless you are an owner or admin' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = NEW.collected_by AND account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'collected_by must be a member of this account' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.collected_by IS NULL THEN NEW.collected_by := NEW.logged_by; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.default_payment_collected_by() FROM PUBLIC, anon, authenticated, service_role;
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
  -- Lock the row and read the status again: a concurrent reversal that committed first is seen here, so two reversals
  -- cannot both succeed or overwrite each other's note.
  SELECT status::text INTO v_status FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'verified' THEN
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

-- ===== Task 11: login kinds, document upload marks, referrer link =====

-- Kinds of student portal login. The rows that exist today are registration logins (the column default says so).
ALTER TABLE public.student_portal_credentials
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'registration'
  CONSTRAINT student_portal_credentials_kind_check CHECK (kind IN ('provisional', 'registration', 'other'));
-- A student with two logins from before the kinds existed (production has none; this happens when 096 is re-applied after a
-- rollback that dropped the kinds): the oldest stays the registration login, the others become "other", so the index can be built.
-- Nothing to do once the index exists: it already allows one registration login per student.
UPDATE public.student_portal_credentials c SET kind = 'other'
 WHERE c.kind = 'registration'
   AND EXISTS (SELECT 1 FROM public.student_portal_credentials o
                WHERE o.contact_id = c.contact_id AND o.kind = 'registration' AND (o.created_at, o.id) < (c.created_at, c.id));
-- One provisional and one registration login per student; any number of "other".
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_credentials_contact_kind
  ON public.student_portal_credentials (contact_id, kind) WHERE kind <> 'other';

-- Saving a provisional login fills applications.provisional_app_id with its username when that is still empty (R-4).
-- SECURITY DEFINER so it does not depend on the saving role's rights on applications; never creates an application.
CREATE OR REPLACE FUNCTION public.fill_provisional_app_id() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.kind = 'provisional' AND btrim(coalesce(NEW.username, '')) <> '' THEN
    UPDATE public.applications SET provisional_app_id = btrim(NEW.username)
     WHERE contact_id = NEW.contact_id AND account_id = NEW.account_id AND btrim(coalesce(provisional_app_id, '')) = '';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.fill_provisional_app_id() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS portal_credentials_fill_provisional ON public.student_portal_credentials;
CREATE TRIGGER portal_credentials_fill_provisional AFTER INSERT ON public.student_portal_credentials
  FOR EACH ROW EXECUTE FUNCTION public.fill_provisional_app_id();

-- Document upload marks (the counsellor uploaded the file to the university portal) and a deletion stamp for the file.
ALTER TABLE public.application_documents
  ADD COLUMN IF NOT EXISTS uploaded_to_portal_at timestamptz,
  ADD COLUMN IF NOT EXISTS uploaded_to_portal_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS file_deleted_at timestamptz;

-- Marks every still-unmarked document of the contact as uploaded now, by the caller. Agent and above. Runs as the caller,
-- so RLS applies (a counsellor-number chat stays out of reach of agents). Returns how many rows it marked.
CREATE OR REPLACE FUNCTION public.mark_documents_uploaded(p_contact_id uuid) RETURNS int
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_account uuid; v_n int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT account_id INTO v_account FROM public.contacts WHERE id = p_contact_id;
  IF v_account IS NULL THEN RAISE EXCEPTION 'Contact not found' USING ERRCODE = '42704'; END IF;
  IF NOT public.is_account_member(v_account, 'agent'::public.account_role_enum) THEN
    RAISE EXCEPTION 'Marking documents requires agent in this account' USING ERRCODE = '42501';
  END IF;
  UPDATE public.application_documents SET uploaded_to_portal_at = now(), uploaded_to_portal_by = auth.uid()
   WHERE contact_id = p_contact_id AND uploaded_to_portal_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.mark_documents_uploaded(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_documents_uploaded(uuid) TO authenticated;

-- Who referred this student (another contact). Deleting the referrer keeps the student; a contact cannot refer itself.
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS referred_by_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL
  CONSTRAINT contacts_referred_by_not_self CHECK (referred_by_contact_id IS NULL OR referred_by_contact_id <> id);
CREATE INDEX IF NOT EXISTS idx_contacts_referred_by ON public.contacts (referred_by_contact_id) WHERE referred_by_contact_id IS NOT NULL;

-- ===== end of Task 11. Tasks 12-17 append their sections below this line. =====

-- ===== Task 12: cards move forward from the application checklist =====

-- Hardening carried from Tasks 9-11 is edited in place above: backfill_applications restores app.suppress_automation,
-- reverse_payment raises when the row is gone, fill_provisional_app_id matches the account.

-- R-4 when the login came first: a new application with no provisional ID takes it from the contact's provisional login
-- (same account). SECURITY DEFINER because an agent saving an application may not read the credentials table.
CREATE OR REPLACE FUNCTION public.fill_provisional_on_application() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v text;
BEGIN
  IF btrim(coalesce(NEW.provisional_app_id, '')) = '' THEN
    SELECT btrim(c.username) INTO v FROM public.student_portal_credentials c
     WHERE c.contact_id = NEW.contact_id AND c.account_id = NEW.account_id AND c.kind = 'provisional'
       AND btrim(coalesce(c.username, '')) <> ''
     ORDER BY c.created_at LIMIT 1;
    IF v IS NOT NULL THEN NEW.provisional_app_id := v; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fill_provisional_on_application() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS applications_fill_provisional ON public.applications;
CREATE TRIGGER applications_fill_provisional BEFORE INSERT ON public.applications
  FOR EACH ROW EXECUTE FUNCTION public.fill_provisional_on_application();

-- A referrer must belong to the same account. SECURITY DEFINER so row security cannot hide a contact of another account
-- from the check (the foreign key itself ignores row security). A missing referrer is left to the foreign key (23503).
CREATE OR REPLACE FUNCTION public.check_referrer_same_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.contacts r WHERE r.id = NEW.referred_by_contact_id AND r.account_id IS DISTINCT FROM NEW.account_id) THEN
    RAISE EXCEPTION 'A referrer must be a contact of the same account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.check_referrer_same_account() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS contacts_referrer_same_account ON public.contacts;
CREATE TRIGGER contacts_referrer_same_account BEFORE INSERT OR UPDATE OF referred_by_contact_id, account_id ON public.contacts
  FOR EACH ROW WHEN (NEW.referred_by_contact_id IS NOT NULL) EXECUTE FUNCTION public.check_referrer_same_account();

-- application_checklist: the one place that reads an application's checklist. advance_application decides the stage from it
-- and application_card_status (the board chips) returns it, so a chip can never disagree with what the auto-move would do.
--   * SECURITY INVOKER: advance_application (definer) sees everything, a board member sees what row security lets them see
--   * every input must belong to the application's own account: row security on those tables only checks the row's own
--     account_id, so a member of another account could file a row naming this contact
--   * a blank provisional ID or registration number counts as absent
--   * app fee = reported or verified; course fee = any non-application head, verified; plan counts once agreed_total > 0
--     (apply_fee_template inserts it at 0 and sets the total afterwards; Enrolled before that would lose the Purchase value)
--   * documents are matched on the application's university (the contact's, then 'LPU', as application_tracker does)
--   * 'reversed' is compared as text: the enum value is added in this same migration
CREATE OR REPLACE FUNCTION public.application_checklist(p_account_id uuid, p_contact_id uuid DEFAULT NULL)
RETURNS TABLE (contact_id uuid, details boolean, app_fee boolean, provisional boolean, form boolean, docs_uploaded int, docs_required int,
               course_fee boolean, registration boolean, has_plan boolean, reversed boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT a.contact_id,
         a.details_punched_at IS NOT NULL,
         EXISTS (SELECT 1 FROM public.payments py WHERE py.contact_id = a.contact_id AND py.account_id = a.account_id
                  AND py.head = 'application' AND py.status::text IN ('reported', 'verified')),
         nullif(btrim(a.provisional_app_id), '') IS NOT NULL,
         a.form_filled_at IS NOT NULL,
         (SELECT count(*)::int FROM public.university_required_docs r
           WHERE r.account_id = a.account_id AND r.university = u.univ
             AND EXISTS (SELECT 1 FROM public.application_documents x WHERE x.contact_id = a.contact_id AND x.account_id = a.account_id
                          AND x.doc_type = r.doc_type AND x.uploaded_to_portal_at IS NOT NULL)),
         (SELECT count(*)::int FROM public.university_required_docs r WHERE r.account_id = a.account_id AND r.university = u.univ),
         EXISTS (SELECT 1 FROM public.payments py WHERE py.contact_id = a.contact_id AND py.account_id = a.account_id
                  AND py.head <> 'application' AND py.status::text = 'verified'),
         nullif(btrim(a.registration_number), '') IS NOT NULL,
         EXISTS (SELECT 1 FROM public.student_fee_plans sp WHERE sp.contact_id = a.contact_id AND sp.account_id = a.account_id AND sp.agreed_total > 0),
         EXISTS (SELECT 1 FROM public.payments py WHERE py.contact_id = a.contact_id AND py.account_id = a.account_id AND py.status::text = 'reversed')
    FROM public.applications a
   CROSS JOIN LATERAL (SELECT coalesce(a.university, (SELECT ct.university FROM public.contacts ct WHERE ct.id = a.contact_id), 'LPU') AS univ) u
   WHERE a.account_id = p_account_id AND (p_contact_id IS NULL OR a.contact_id = p_contact_id)
$$;
REVOKE ALL ON FUNCTION public.application_checklist(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.application_checklist(uuid, uuid) TO authenticated, service_role;

-- advance_application: moves every live admissions card of the contact forward to the stage its checklist has earned.
--   * never backward, never out of Enrolled / Lost / Not Interested; a fee may jump ahead of documents
--   * positions come from the cards' own board (stage_position / pipeline_stages), never a literal
--   * moves are logged with a NULL changed_by (app.automation = 'on' while it moves, as 095's stage-log trigger expects)
--   * does nothing while app.suppress_automation = 'on' (backfills, imports)
--   * locks the application row, then the contact's deals on admissions boards in the application's account first (not its other deals: a fee plan or
--     a Sales card of the same contact must not wait, and fewer locks means less deadlock exposure against lifecycle_sweep),
--     then reads the checklist and the stages in LATER statements, so a Lost move that committed while it waited
--     (lifecycle_sweep, a person) is seen and respected
CREATE OR REPLACE FUNCTION public.advance_application(p_contact_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_acct uuid; c record; v_target text; v_moved int; v_prev_auto text;
BEGIN
  IF current_setting('app.suppress_automation', true) = 'on' THEN RETURN; END IF;
  -- The application row first, then the deals: a save of the application locks its row and then (through its trigger) the deals,
  -- so taking them in the other order here could deadlock with it (40P01).
  SELECT account_id INTO v_acct FROM public.applications WHERE contact_id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  -- Lock first, read after: a second input committing at the same time waits here and then reads the first one's rows
  -- (every later statement takes a new snapshot), so two inputs together are never seen as half each.
  PERFORM 1 FROM public.deals dl
    WHERE dl.contact_id = p_contact_id AND dl.account_id = v_acct AND public.stage_position(dl.pipeline_id, 'Application Started') IS NOT NULL
    ORDER BY dl.id FOR UPDATE;
  SELECT * INTO c FROM public.application_checklist(v_acct, p_contact_id);
  IF NOT FOUND THEN RETURN; END IF;
  v_target := CASE
    WHEN c.registration AND c.has_plan THEN 'Enrolled'
    WHEN c.provisional AND c.course_fee THEN 'Fee Submitted'
    WHEN c.provisional AND c.form AND c.docs_uploaded = c.docs_required THEN 'Form & Documents'
    WHEN c.provisional THEN 'Provisional ID'
    WHEN c.details AND c.app_fee THEN 'Application Started'
  END;
  IF v_target IS NULL THEN RETURN; END IF;

  v_prev_auto := coalesce(current_setting('app.automation', true), '');
  PERFORM set_config('app.automation', 'on', true);
  WITH moved AS (
    UPDATE public.deals dl SET stage_id = t.id, updated_at = now()
      FROM public.pipeline_stages cur, public.pipeline_stages t
     WHERE dl.contact_id = p_contact_id AND dl.account_id = v_acct
       AND cur.id = dl.stage_id AND cur.name NOT IN ('Enrolled', 'Lost', 'Not Interested')
       AND public.stage_position(dl.pipeline_id, 'Application Started') IS NOT NULL
       AND t.pipeline_id = dl.pipeline_id AND t.name = v_target AND t.position > cur.position
    RETURNING dl.id)
  SELECT count(*) INTO v_moved FROM moved;
  PERFORM set_config('app.automation', v_prev_auto, true);

  IF v_moved > 0 AND v_target = 'Enrolled' THEN
    UPDATE public.applications SET enrolled_at = now() WHERE contact_id = p_contact_id AND enrolled_at IS NULL;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.advance_application(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_application(uuid) TO service_role;

-- Every input that can earn a stage calls it through this one trigger function (SECURITY DEFINER: the saving user may not
-- be allowed to write deals, and advance_application is closed to API roles).
CREATE OR REPLACE FUNCTION public.advance_application_on_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.contact_id IS NOT NULL THEN PERFORM public.advance_application(NEW.contact_id); END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.advance_application_on_change() FROM PUBLIC, anon, authenticated, service_role;

-- pg_trigger_depth() is 0 for a statement run by a user or an API call and 1 or more when a row is written from inside
-- another trigger. Only the first fires this trigger, so advance_application's own write of enrolled_at, and the provisional
-- fill from a login, do not loop back in. (The WHEN clause runs before the trigger function enters, hence 0 and not 1.)
DROP TRIGGER IF EXISTS applications_advance ON public.applications;
CREATE TRIGGER applications_advance AFTER INSERT OR UPDATE ON public.applications
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION public.advance_application_on_change();
DROP TRIGGER IF EXISTS payments_advance ON public.payments;
CREATE TRIGGER payments_advance AFTER INSERT OR UPDATE OF status ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.advance_application_on_change();
-- Trigger names run alphabetically: this one must run after portal_credentials_fill_provisional so the ID is already filled.
DROP TRIGGER IF EXISTS portal_credentials_then_advance ON public.student_portal_credentials;
CREATE TRIGGER portal_credentials_then_advance AFTER INSERT ON public.student_portal_credentials
  FOR EACH ROW EXECUTE FUNCTION public.advance_application_on_change();
DROP TRIGGER IF EXISTS application_documents_advance ON public.application_documents;
CREATE TRIGGER application_documents_advance AFTER UPDATE OF uploaded_to_portal_at ON public.application_documents
  FOR EACH ROW WHEN (OLD.uploaded_to_portal_at IS DISTINCT FROM NEW.uploaded_to_portal_at) EXECUTE FUNCTION public.advance_application_on_change();

-- A fee plan is an input too (no depth guard: advance_application never writes plans, and apply_fee_template deletes then
-- inserts, then sets the total with an update).
DROP TRIGGER IF EXISTS student_fee_plans_advance ON public.student_fee_plans;
CREATE TRIGGER student_fee_plans_advance AFTER INSERT OR UPDATE ON public.student_fee_plans
  FOR EACH ROW EXECUTE FUNCTION public.advance_application_on_change();

-- ===== end of Task 12. =====

-- Board chips: one row per application of the account (contacts without an application have no row). A thin wrapper over
-- application_checklist, so what the card shows is what advance_application would decide from.
CREATE OR REPLACE FUNCTION public.application_card_status(p_account_id uuid)
RETURNS TABLE (contact_id uuid, details boolean, app_fee boolean, provisional boolean, form boolean, docs_uploaded int, docs_required int,
               course_fee boolean, registration boolean, has_plan boolean, reversed boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT * FROM public.application_checklist(p_account_id, NULL)
$$;
REVOKE ALL ON FUNCTION public.application_card_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.application_card_status(uuid) TO authenticated, service_role;

-- ===== end of Task 13. Tasks 14-17 append their sections below this line. =====

-- Who opened which stored document, and when. Written by the signed-URL route with the caller's own session, so a member can
-- only log themselves; read by admins. No FK on document_id / user_id: the log must outlive a deleted file or a removed member.
CREATE TABLE IF NOT EXISTS public.document_access_log (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  user_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_access_log_account_document ON public.document_access_log (account_id, document_id, at DESC);

ALTER TABLE public.document_access_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_access_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.document_access_log TO authenticated;
GRANT ALL ON public.document_access_log TO service_role;

DROP POLICY IF EXISTS document_access_log_insert ON public.document_access_log;
CREATE POLICY document_access_log_insert ON public.document_access_log FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND public.is_account_member(account_id, 'viewer'::public.account_role_enum)
    AND EXISTS (SELECT 1 FROM public.application_documents d WHERE d.id = document_id AND d.account_id = document_access_log.account_id)
  );
DROP POLICY IF EXISTS document_access_log_select ON public.document_access_log;
CREATE POLICY document_access_log_select ON public.document_access_log FOR SELECT
  USING (public.is_account_member(account_id, 'admin'::public.account_role_enum));

-- "Keep files" is an owner / admin decision; applications_insert / _update are agent+, so the column is gated here. Calls with no
-- auth.uid() (service role, backfill, triggers) pass.
CREATE OR REPLACE FUNCTION public.guard_retain_files() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND ((TG_OP = 'INSERT' AND NEW.retain_files IS TRUE)
          OR (TG_OP = 'UPDATE' AND NEW.retain_files IS DISTINCT FROM OLD.retain_files))
     AND NOT public.is_account_member(NEW.account_id, 'admin'::public.account_role_enum) THEN
    RAISE EXCEPTION 'Only an owner or admin can change Keep files' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_retain_files() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS applications_guard_retain_files ON public.applications;
CREATE TRIGGER applications_guard_retain_files BEFORE INSERT OR UPDATE ON public.applications
  FOR EACH ROW EXECUTE FUNCTION public.guard_retain_files();

-- ===== end of Task 14 (SQL). Tasks 15-17 append their sections below this line. =====

-- ===== Task 16 fix 1: payment_ledger "in hand" ignores reversed payments =====
-- The live 094 body, unchanged except the hop join, which now skips rejected and reversed payments so a reversed payment's
-- settled hops leave the account-wide In hand figure. Task 17's rollback must restore the 094 body (MD5 guard).
CREATE OR REPLACE FUNCTION public.payment_ledger(p_account_id uuid)
 RETURNS TABLE(contact_id uuid, name text, phone text, roll_number text, university text, program text, payment_option text, currency text, plan_id uuid, agreed_total numeric, received numeric, reported numeric, discounts numeric, pending_discounts numeric, outstanding numeric, in_hand numeric, next_due_label text, next_due_date date, next_due_amount numeric, last_payment_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_all_contacts boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

  -- 094: contacts that arrived through a counsellor number, unless the caller is an admin or the owner.
  v_all_contacts := can_see_counsellor_chats(p_account_id);

  RETURN QUERY
  SELECT
    ct.id,
    ct.name,
    ct.phone,
    ct.roll_number,
    COALESCE(pl.university, ct.university),
    pl.program,
    pl.payment_option::text,
    COALESCE(pl.currency, acc.default_currency, 'INR'),
    pl.id,
    COALESCE(pl.agreed_total, 0),
    COALESCE(pay.verified_sum, 0),
    COALESCE(pay.reported_sum, 0),
    COALESCE(disc.live_sum, 0),
    COALESCE(disc.pending_sum, 0),
    GREATEST(
      COALESCE(pl.agreed_total, 0)
        - COALESCE(pay.verified_sum, 0)
        - COALESCE(disc.live_sum, 0),
      0),
    -- Money that reached us and has not gone out again. Derived on every read
    -- so a corrected hop cannot leave a stale figure behind.
    COALESCE(hop.inbound, 0) - COALESCE(hop.outbound, 0),
    nxt.label,
    nxt.due_date,
    nxt.amount,
    pay.last_at
  FROM contacts ct
  JOIN accounts acc ON acc.id = ct.account_id
  LEFT JOIN student_fee_plans pl ON pl.contact_id = ct.id
  LEFT JOIN LATERAL (
    SELECT
      sum(p.amount) FILTER (WHERE p.status = 'verified') AS verified_sum,
      sum(p.amount) FILTER (WHERE p.status = 'reported') AS reported_sum,
      max(p.paid_at) AS last_at
    FROM payments p WHERE p.contact_id = ct.id
  ) pay ON true
  LEFT JOIN LATERAL (
    SELECT
      -- Not-rejected, so a pending discount already counts. That is the
      -- immediate-effect behaviour the operator chose.
      sum(fd.amount) FILTER (WHERE fd.status <> 'rejected') AS live_sum,
      sum(fd.amount) FILTER (WHERE fd.status = 'pending') AS pending_sum
    FROM fee_discounts fd WHERE fd.contact_id = ct.id
  ) disc ON true
  LEFT JOIN LATERAL (
    SELECT
      sum(h.amount) FILTER (WHERE h.status = 'settled' AND h.to_party = 'skeure')
        AS inbound,
      sum(h.amount) FILTER (WHERE h.status = 'settled' AND h.from_party = 'skeure')
        AS outbound
    FROM payment_hops h
    JOIN payments p2 ON p2.id = h.payment_id
    WHERE p2.contact_id = ct.id
      AND p2.status::text NOT IN ('rejected', 'reversed')
  ) hop ON true
  LEFT JOIN LATERAL (
    SELECT fi.label, fi.due_date, fi.amount
    FROM student_fee_installments fi
    WHERE fi.plan_id = pl.id
      AND NOT EXISTS (
        SELECT 1 FROM payments p2
        WHERE p2.installment_id = fi.id AND p2.status = 'verified')
    ORDER BY fi.due_date NULLS LAST, fi.position
    LIMIT 1
  ) nxt ON true
  WHERE ct.account_id = p_account_id
    AND (v_all_contacts OR NOT ct.counsellor_number_only)
    AND (pl.id IS NOT NULL OR pay.last_at IS NOT NULL OR disc.live_sum IS NOT NULL)
  ORDER BY
    GREATEST(
      COALESCE(pl.agreed_total, 0)
        - COALESCE(pay.verified_sum, 0)
        - COALESCE(disc.live_sum, 0),
      0) DESC,
    ct.name;
END;
$function$;

-- ===== Task 17: queue_lost_restore treats the three new stages like Application Started (ruling R-2) =====
-- The live 091 body, unchanged except the prior-stage join. 091 left a Lost deal alone when its prior stage was named
-- Application Started, Enrolled or Lost; since 095 the stages from Provisional ID to Fee Submitted sit between those two, so the
-- test is now by position on the deal's own board: a prior stage from Application Started through Enrolled is excluded.
-- Everything else is as 091: the 091 name test (Application Started, Enrolled, Lost) is kept, so this is a strict superset of 091
-- (a board with Enrolled but no Application Started still excludes Enrolled); an exit above Enrolled (Not Interested) is still not
-- excluded, and a board without those stages (stage_position is NULL) excludes nothing by position. CREATE OR REPLACE keeps the owner and
-- the grants 091 set (closed to the app roles). 096_rollback.sql restores the 091 body; apply-kuanli-096.mjs guards its md5.
CREATE OR REPLACE FUNCTION public.queue_lost_restore(p_account_id uuid, p_as_of timestamp with time zone, p_window_days integer DEFAULT 60, p_min_replies integer DEFAULT 3)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM lost_restore_queue q WHERE q.account_id = p_account_id) THEN RETURN 0; END IF;
  WITH inbound AS (
    SELECT cv.contact_id, max(m.created_at) AS last_at, count(*) AS n
      FROM conversations cv JOIN messages m ON m.conversation_id = cv.id
     WHERE cv.account_id = p_account_id AND m.sender_type = 'customer'
     GROUP BY cv.contact_id
  ), ins AS (
    INSERT INTO lost_restore_queue (deal_id, account_id, contact_id, conversation_id, prior_stage_id, last_customer_at)
    SELECT d.id, d.account_id, d.contact_id,
           coalesce(d.conversation_id, (SELECT cv.id FROM conversations cv WHERE cv.contact_id = d.contact_id ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1)),
           ev.from_stage_id, i.last_at
      FROM deals d
      JOIN pipeline_stages s ON s.id = d.stage_id AND s.name = 'Lost'
      JOIN inbound i ON i.contact_id = d.contact_id
      JOIN LATERAL (SELECT e.from_stage_id, e.changed_by, e.changed_at FROM deal_stage_events e
                     WHERE e.deal_id = d.id AND e.to_stage_id = d.stage_id AND e.from_stage_id IS NOT NULL
                     ORDER BY e.changed_at DESC LIMIT 1) ev ON true
      JOIN pipeline_stages prior ON prior.id = ev.from_stage_id AND prior.name NOT IN ('Application Started', 'Enrolled', 'Lost')
           AND NOT coalesce(prior.position BETWEEN public.stage_position(prior.pipeline_id, 'Application Started')
                                               AND public.stage_position(prior.pipeline_id, 'Enrolled'), false)
     WHERE d.account_id = p_account_id
       AND i.n >= p_min_replies
       AND i.last_at > p_as_of - make_interval(days => p_window_days)
       AND ev.changed_by IS NULL
       AND ev.changed_at >= i.last_at + interval '13 days'
       AND NOT EXISTS (SELECT 1 FROM conversations cv JOIN messages m ON m.conversation_id = cv.id
                        WHERE cv.contact_id = d.contact_id AND m.sender_type = 'customer'
                          AND m.content_text ~* '(\mstop\M|unsubscribe|not interested|don.?t (message|contact|call|text)|do not (message|contact|call|text)|remove me|no need|wrong number|nahi chahiye|nhi chahiye|mat (bhejo|karo|bhej)|band karo|interested nahi|interested nhi|already (admitted|enrolled|done|taken)|not required|\mspam\M)')
    ON CONFLICT (deal_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM ins;
  RETURN v_n;
END $function$;
