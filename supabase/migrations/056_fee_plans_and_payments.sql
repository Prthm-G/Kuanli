-- 056_fee_plans_and_payments.sql
-- KB-FEEPAY-R4-36
--
-- Money. Until now nothing in the schema knew what a student had agreed to
-- pay, what had actually arrived, or what was still outstanding. Deals carry a
-- `value`, but that is a sales forecast, not a ledger.
--
-- Five tables:
--
--   fee_templates            what a programme costs, per university, mode,
--                            programme, specialization and PAYMENT OPTION.
--   student_fee_plans        one student's agreed plan, snapshotted.
--   student_fee_installments the plan broken into dated, named amounts.
--   payments                 money actually received, reported then verified.
--   payment_receipts         the screenshot or bank PDF behind a payment.
--
-- Why payment_option is part of the template key
--
--   The same degree is priced three ways and the totals genuinely differ.
--   LPU Distance MBA, from its own brochure: 4 x 15,000 per semester = 66,000;
--   2 x 28,000 annually = 62,000; 52,000 as a lump sum. Paying earlier costs
--   less, deliberately. A template keyed on programme alone cannot express
--   that, and picking one silently would misquote two thirds of students.
--
--   term_count therefore counts TERMS OF THAT OPTION, not semesters: 4, 2 and
--   1 for the three rows above. Multiplying the lump sum by four semesters
--   would bill a student 208,000 for a 58,000 programme.
--
-- Why plans snapshot instead of referencing
--
--   student_fee_plans copies the amounts rather than pointing at the template
--   for its numbers. Fee structures are revised every intake (the sources here
--   are all stamped "July 2026"), and a student who enrolled under the old one
--   owes the old one. Editing a template must never silently rewrite what an
--   existing student agreed to. template_id is kept for provenance only, and
--   is nullable because a plan can be built by hand.
--
-- Access
--
--   Counsellors (agent) record payments as `reported`. Only owner/admin can
--   move a payment to `verified` or `rejected`, and only through
--   verify_payment(). RLS is row-level and cannot restrict an UPDATE to one
--   column, so `payments` grants UPDATE to admin+ only and the status
--   transition goes through a SECURITY DEFINER function, the same shape as
--   update_contact_enrollment (026).
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.payment_ledger(uuid);
--   DROP FUNCTION IF EXISTS public.apply_fee_template(uuid, uuid, date);
--   DROP FUNCTION IF EXISTS public.verify_payment(uuid, text, text);
--   DROP TABLE IF EXISTS payment_receipts, payments,
--                        student_fee_installments, student_fee_plans,
--                        fee_templates;
--   DROP TYPE IF EXISTS payment_status_enum, payment_method_enum,
--                       fee_head_enum, fee_payment_option_enum;
--   DELETE FROM storage.buckets WHERE id = 'payment-receipts';

DO $$ BEGIN
  CREATE TYPE fee_payment_option_enum AS ENUM
    ('per_semester', 'annual', 'lump_sum');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fee_head_enum AS ENUM
    ('application', 'registration', 'semester', 'exam', 'study_material', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method_enum AS ENUM
    ('upi', 'bank_transfer', 'cash', 'card', 'cheque', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status_enum AS ENUM ('reported', 'verified', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE fee_payment_option_enum OWNER TO supabase_admin;
ALTER TYPE fee_head_enum           OWNER TO supabase_admin;
ALTER TYPE payment_method_enum     OWNER TO supabase_admin;
ALTER TYPE payment_status_enum     OWNER TO supabase_admin;

-- ============================================================
-- fee_templates
-- ============================================================
CREATE TABLE IF NOT EXISTS fee_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Enrollment codes: LPU / AMI / DBU. Same vocabulary as contacts.university
  -- (migration 026) and src/lib/reports/university-code.ts. Deliberately not a
  -- second vocabulary.
  university TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('online', 'distance')),
  program TEXT NOT NULL,
  -- '' rather than NULL for the general track, so the unique index below
  -- actually constrains it. A NULL specialization would let the same general
  -- programme be inserted any number of times.
  specialization TEXT NOT NULL DEFAULT '',
  payment_option fee_payment_option_enum NOT NULL,
  -- Terms of THIS option: semesters for per_semester, years for annual,
  -- 1 for lump_sum.
  term_count INTEGER CHECK (term_count IS NULL OR term_count > 0),
  -- Charged once per term.
  programme_fee NUMERIC(12,2),
  exam_fee NUMERIC(12,2),
  -- Whole-programme cost, so options are comparable without recomputing.
  -- Carried explicitly because the terms are not always equal: Amity's BA
  -- splits 115,000 as 19,200 x5 then 19,000, and term x per-term would be
  -- 200 rupees out.
  total_fee NUMERIC(12,2),
  -- Charged once, at admission, not per term.
  application_fee NUMERIC(12,2),
  study_material_fee NUMERIC(12,2),
  -- The discount already reflected in the figures above (LPU's Student Grant,
  -- Amity's one-time and yearly discounts). Informational: it explains the
  -- price, it is not applied again.
  list_discount_pct NUMERIC(5,2),
  currency TEXT NOT NULL DEFAULT 'INR',
  -- Free-text tier label. Amity's sheet prices every programme twice at
  -- different discounts with nothing in the file saying why; rather than
  -- guess, both survive and are told apart here.
  variant TEXT NOT NULL DEFAULT '',
  -- Where the numbers came from, kept so a disputed fee is traceable to a
  -- brochure or spreadsheet rather than to somebody's memory.
  source TEXT,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, university, mode, program, specialization,
          payment_option, variant, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_fee_templates_lookup
  ON fee_templates(account_id, university, mode, program)
  WHERE active;

-- ============================================================
-- student_fee_plans / student_fee_installments
-- ============================================================
CREATE TABLE IF NOT EXISTS student_fee_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Provenance only. ON DELETE SET NULL: retiring a template must not delete
  -- a student's agreed plan.
  template_id UUID REFERENCES fee_templates(id) ON DELETE SET NULL,
  university TEXT,
  mode TEXT,
  program TEXT,
  specialization TEXT NOT NULL DEFAULT '',
  payment_option fee_payment_option_enum,
  currency TEXT NOT NULL DEFAULT 'INR',
  -- The number the student was quoted. Snapshotted at creation.
  agreed_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  note TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One live plan per student. A student switching programme gets their plan
  -- edited, not a second one, otherwise "what do they owe" has two answers.
  UNIQUE (contact_id)
);

CREATE TABLE IF NOT EXISTS student_fee_installments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES student_fee_plans(id) ON DELETE CASCADE,
  head fee_head_enum NOT NULL,
  -- 1-based within its head; NULL for one-off heads like application.
  term_index INTEGER,
  label TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  due_date DATE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fee_installments_plan
  ON student_fee_installments(plan_id, position);

-- ============================================================
-- payments
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES student_fee_plans(id) ON DELETE SET NULL,
  -- Which installment this settles. Nullable: money sometimes arrives before
  -- anyone has built the plan, and refusing to record it would push it back
  -- off-system, which is the problem this table exists to solve.
  installment_id UUID REFERENCES student_fee_installments(id) ON DELETE SET NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  method payment_method_enum NOT NULL,
  -- UPI ref, NEFT UTR, cheque number. Not unique: cash has none, and a
  -- mistyped reference must not block recording that money arrived.
  reference TEXT,
  note TEXT,
  status payment_status_enum NOT NULL DEFAULT 'reported',
  logged_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A verified or rejected payment must say who decided and when. Without
  -- this the audit trail is optional, which is the same as not having one.
  CONSTRAINT payment_decision_recorded CHECK (
    status = 'reported'
    OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_payments_contact
  ON payments(contact_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_account_status
  ON payments(account_id, status, paid_at DESC);

CREATE TABLE IF NOT EXISTS payment_receipts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  mime_type TEXT,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_receipts_payment
  ON payment_receipts(payment_id);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE fee_templates            ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_fee_plans        ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_fee_installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_receipts         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read fee templates" ON fee_templates;
CREATE POLICY "Members read fee templates" ON fee_templates
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS "Admins write fee templates" ON fee_templates;
CREATE POLICY "Admins write fee templates" ON fee_templates
  FOR ALL USING (is_account_member(account_id, 'admin'::account_role_enum))
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));

DROP POLICY IF EXISTS "Members read fee plans" ON student_fee_plans;
CREATE POLICY "Members read fee plans" ON student_fee_plans
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS "Counsellors manage fee plans" ON student_fee_plans;
CREATE POLICY "Counsellors manage fee plans" ON student_fee_plans
  FOR ALL USING (is_account_member(account_id, 'agent'::account_role_enum))
  WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));

DROP POLICY IF EXISTS "Members read fee installments" ON student_fee_installments;
CREATE POLICY "Members read fee installments" ON student_fee_installments
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS "Counsellors manage fee installments" ON student_fee_installments;
CREATE POLICY "Counsellors manage fee installments" ON student_fee_installments
  FOR ALL USING (is_account_member(account_id, 'agent'::account_role_enum))
  WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));

-- Payments: counsellors may read and file, but only admins may change a row.
-- The status transition is verify_payment()'s job, not an UPDATE's.
DROP POLICY IF EXISTS "Members read payments" ON payments;
CREATE POLICY "Members read payments" ON payments
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS "Counsellors report payments" ON payments;
CREATE POLICY "Counsellors report payments" ON payments
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent'::account_role_enum)
    AND logged_by = auth.uid()
    -- A counsellor cannot file a payment that is already verified. Without
    -- this, "agents report, admins verify" would be a UI convention rather
    -- than a rule.
    AND status = 'reported'
    AND verified_by IS NULL
  );
DROP POLICY IF EXISTS "Admins amend payments" ON payments;
CREATE POLICY "Admins amend payments" ON payments
  FOR UPDATE USING (is_account_member(account_id, 'admin'::account_role_enum))
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
DROP POLICY IF EXISTS "Admins delete payments" ON payments;
CREATE POLICY "Admins delete payments" ON payments
  FOR DELETE USING (is_account_member(account_id, 'admin'::account_role_enum));

DROP POLICY IF EXISTS "Members read payment receipts" ON payment_receipts;
CREATE POLICY "Members read payment receipts" ON payment_receipts
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS "Counsellors attach payment receipts" ON payment_receipts;
CREATE POLICY "Counsellors attach payment receipts" ON payment_receipts
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent'::account_role_enum)
  );
DROP POLICY IF EXISTS "Admins remove payment receipts" ON payment_receipts;
CREATE POLICY "Admins remove payment receipts" ON payment_receipts
  FOR DELETE USING (is_account_member(account_id, 'admin'::account_role_enum));

-- ============================================================
-- Ownership and grants, stated rather than inherited (see 055).
-- ============================================================
ALTER TABLE fee_templates            OWNER TO supabase_admin;
ALTER TABLE student_fee_plans        OWNER TO supabase_admin;
ALTER TABLE student_fee_installments OWNER TO supabase_admin;
ALTER TABLE payments                 OWNER TO supabase_admin;
ALTER TABLE payment_receipts         OWNER TO supabase_admin;

REVOKE ALL ON fee_templates, student_fee_plans, student_fee_installments,
              payments, payment_receipts
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON fee_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON student_fee_plans TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON student_fee_installments TO authenticated;
-- No UPDATE or DELETE for the browser role on payments: the RLS policies would
-- confine them to admins anyway, and withholding the grant means a counsellor's
-- client cannot even attempt it.
GRANT SELECT, INSERT ON payments TO authenticated;
GRANT SELECT, INSERT ON payment_receipts TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON fee_templates, student_fee_plans,
      student_fee_installments, payments, payment_receipts TO service_role;

-- ============================================================
-- Private receipt bucket. Bank references and UPI screenshots are financial
-- PII; the bucket is private, like application-docs (045) and unlike
-- chat-media, which has to be public for Meta to fetch outbound sends.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'payment-receipts',
  'payment-receipts',
  false,
  16777216,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Same account-scoped path convention as flow-media (020) and
-- application-docs (045): payment-receipts/account-<account_id>/...
DROP POLICY IF EXISTS "Members read payment receipts storage" ON storage.objects;
CREATE POLICY "Members read payment receipts storage" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'payment-receipts'
    AND is_account_member(
      NULLIF(replace(split_part(name, '/', 1), 'account-', ''), '')::uuid
    )
  );

DROP POLICY IF EXISTS "Counsellors write payment receipts storage" ON storage.objects;
CREATE POLICY "Counsellors write payment receipts storage" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'payment-receipts'
    AND is_account_member(
      NULLIF(replace(split_part(name, '/', 1), 'account-', ''), '')::uuid,
      'agent'::account_role_enum
    )
  );

-- ============================================================
-- verify_payment(payment_id, status, note)
--
-- The admin half of "counsellors report, admins verify". Exists as a function
-- because RLS is row-level: a policy can say who may update a payment row, but
-- not that a counsellor may edit the note while only an admin may move the
-- status. Withholding UPDATE from the browser role entirely and routing the
-- one legitimate transition through here is the same shape migration 026 used
-- for update_contact_enrollment.
--
-- Only reported -> verified|rejected is allowed. Re-deciding a settled payment
-- is not an edit, it is a correction, and it should leave a trace rather than
-- silently overwrite who signed off.
-- ============================================================
CREATE OR REPLACE FUNCTION public.verify_payment(
  p_payment_id uuid,
  p_status text,
  p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id uuid;
  v_current payment_status_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'Status must be verified or rejected, got %', p_status
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, status INTO v_account_id, v_current
  FROM payments WHERE id = p_payment_id;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Payment not found' USING ERRCODE = '42704';
  END IF;

  IF NOT is_account_member(v_account_id, 'admin'::account_role_enum) THEN
    RAISE EXCEPTION 'Verifying a payment requires admin in this account'
      USING ERRCODE = '42501';
  END IF;

  IF v_current <> 'reported' THEN
    RAISE EXCEPTION 'Payment is already %, not awaiting a decision', v_current
      USING ERRCODE = '22023';
  END IF;

  UPDATE payments
  SET status = p_status::payment_status_enum,
      verified_by = auth.uid(),
      verified_at = now(),
      decision_note = p_note
  WHERE id = p_payment_id;
END;
$$;

ALTER FUNCTION public.verify_payment(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.verify_payment(uuid, text, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.verify_payment(uuid, text, text) TO authenticated;

-- ============================================================
-- apply_fee_template(contact_id, template_id, start_date)
--
-- Materialize a template into one student's plan and its installments, then
-- return the plan id. The amounts are COPIED, not referenced: see the header.
--
-- Dating: the one-time heads fall on the start date; each term is spaced by
-- the option's own period (6 months for per_semester, 12 for annual, and the
-- lump sum is a single charge on day one). Dates are a starting point for the
-- counsellor to adjust, not a university calendar.
--
-- Replaces any existing plan for the contact, because student_fee_plans is
-- UNIQUE on contact_id and two plans would mean two answers to "what is
-- outstanding". Payments already recorded survive: their plan_id and
-- installment_id are ON DELETE SET NULL, so the money stays on the ledger and
-- is simply no longer attached to a line item.
-- ============================================================
CREATE OR REPLACE FUNCTION public.apply_fee_template(
  p_contact_id uuid,
  p_template_id uuid,
  p_start_date date DEFAULT CURRENT_DATE
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t fee_templates%ROWTYPE;
  v_account_id uuid;
  v_plan_id uuid;
  v_months integer;
  v_terms integer;
  v_total numeric(12,2) := 0;
  i integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account_id FROM contacts WHERE id = p_contact_id;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Contact not found' USING ERRCODE = '42704';
  END IF;

  IF NOT is_account_member(v_account_id, 'agent'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires counsellor access in this account'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO t FROM fee_templates WHERE id = p_template_id;
  IF t.id IS NULL THEN
    RAISE EXCEPTION 'Fee template not found' USING ERRCODE = '42704';
  END IF;
  -- A template from another account must not be reachable even by id.
  IF t.account_id <> v_account_id THEN
    RAISE EXCEPTION 'Fee template belongs to a different account'
      USING ERRCODE = '42501';
  END IF;

  v_terms := COALESCE(t.term_count, 1);
  v_months := CASE t.payment_option
                WHEN 'per_semester' THEN 6
                WHEN 'annual' THEN 12
                ELSE 0
              END;

  DELETE FROM student_fee_plans WHERE contact_id = p_contact_id;

  INSERT INTO student_fee_plans (
    account_id, contact_id, template_id, university, mode, program,
    specialization, payment_option, currency, agreed_total, created_by
  ) VALUES (
    v_account_id, p_contact_id, t.id, t.university, t.mode, t.program,
    t.specialization, t.payment_option, t.currency, 0, auth.uid()
  ) RETURNING id INTO v_plan_id;

  -- One-time heads first, both dated at the start.
  IF COALESCE(t.application_fee, 0) > 0 THEN
    INSERT INTO student_fee_installments
      (account_id, plan_id, head, label, amount, due_date, position)
    VALUES (v_account_id, v_plan_id, 'application', 'Application fee',
            t.application_fee, p_start_date, 0);
    v_total := v_total + t.application_fee;
  END IF;

  -- Per-term heads.
  FOR i IN 1..v_terms LOOP
    IF COALESCE(t.programme_fee, 0) > 0 THEN
      INSERT INTO student_fee_installments
        (account_id, plan_id, head, term_index, label, amount, due_date, position)
      VALUES (
        v_account_id, v_plan_id, 'semester', i,
        CASE t.payment_option
          WHEN 'per_semester' THEN 'Semester ' || i
          WHEN 'annual' THEN 'Year ' || i
          ELSE 'Programme fee (lump sum)'
        END,
        t.programme_fee,
        p_start_date + ((i - 1) * v_months || ' months')::interval,
        i * 10
      );
      v_total := v_total + t.programme_fee;
    END IF;

    IF COALESCE(t.exam_fee, 0) > 0 THEN
      INSERT INTO student_fee_installments
        (account_id, plan_id, head, term_index, label, amount, due_date, position)
      VALUES (
        v_account_id, v_plan_id, 'exam', i, 'Examination fee ' || i,
        t.exam_fee,
        p_start_date + ((i - 1) * v_months || ' months')::interval,
        i * 10 + 1
      );
      v_total := v_total + t.exam_fee;
    END IF;
  END LOOP;

  -- The template's own total wins where it has one. The terms are not always
  -- equal (Amity's BA is 19,200 x5 then 19,000), so summing per-term amounts
  -- can be a couple of hundred rupees out, and the printed total is what the
  -- student was actually quoted.
  UPDATE student_fee_plans
  SET agreed_total = CASE
        WHEN COALESCE(t.total_fee, 0) > 0
          THEN t.total_fee + COALESCE(t.application_fee, 0)
        ELSE v_total
      END
  WHERE id = v_plan_id;

  RETURN v_plan_id;
END;
$$;

ALTER FUNCTION public.apply_fee_template(uuid, uuid, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_fee_template(uuid, uuid, date)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.apply_fee_template(uuid, uuid, date)
  TO authenticated;

-- ============================================================
-- payment_ledger(account_id)
--
-- One row per student who has a plan or has paid something: agreed, received,
-- awaiting verification, outstanding, and the next installment due.
--
-- Only VERIFIED payments count as received. A reported-but-unchecked payment
-- is a claim, and treating a claim as money in the bank is how a ledger starts
-- lying; it is returned separately as `reported` so the gap is visible rather
-- than hidden.
--
-- Same authorization convention as application_tracker (046).
-- ============================================================
CREATE OR REPLACE FUNCTION public.payment_ledger(p_account_id uuid)
RETURNS TABLE (
  contact_id uuid,
  name text,
  phone text,
  roll_number text,
  university text,
  program text,
  payment_option text,
  currency text,
  plan_id uuid,
  agreed_total numeric,
  received numeric,
  reported numeric,
  outstanding numeric,
  next_due_label text,
  next_due_date date,
  next_due_amount numeric,
  last_payment_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

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
    COALESCE(pl.agreed_total, 0) - COALESCE(pay.verified_sum, 0),
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
  -- Earliest installment not yet covered by a verified payment against it.
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
    AND (pl.id IS NOT NULL OR pay.last_at IS NOT NULL)
  ORDER BY
    (COALESCE(pl.agreed_total, 0) - COALESCE(pay.verified_sum, 0)) DESC,
    ct.name;
END;
$$;

ALTER FUNCTION public.payment_ledger(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.payment_ledger(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.payment_ledger(uuid) TO authenticated;
