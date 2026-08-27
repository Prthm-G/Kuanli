-- 057_payment_routes_and_discounts.sql
-- KB-PAYROUTE-R4-37
--
-- The two things migration 056 left out: where the money physically went, and
-- what was knocked off the price.
--
-- payment_hops
--
--   A payment is not one event. A student pays Skeure, Skeure remits to the
--   university, and between those two moments Skeure is holding money that
--   belongs to neither party's balance sheet in a simple ledger. Recording
--   each leg is what makes "who is holding this right now" answerable:
--   student -> skeure settled with skeure -> university still pending means it
--   is sitting with us.
--
--   Commission is DERIVED, never stored: settled inbound minus settled
--   outbound, per student. A stored commission column drifts the moment a hop
--   is corrected, and then two numbers disagree with no way to tell which is
--   right.
--
-- fee_discounts
--
--   Per the operator's decision, a proposed discount reduces the outstanding
--   balance IMMEDIATELY and the approval is a review afterwards. That is the
--   faster workflow and it was chosen knowingly, but it means a rejection
--   raises a balance that has already been quoted. Two things make that
--   visible rather than surprising:
--
--     the outstanding calculation counts every discount that is not rejected,
--     so a pending one is already reflected and the UI marks it as reversible;
--
--     rejecting one writes a follow-up entry against the contact (migration
--     054), so the counsellor meets the reversal in the student's timeline
--     rather than noticing a number moved.
--
-- Outstanding, after this migration:
--   agreed_total - verified payments - discounts WHERE status <> 'rejected'
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.decide_fee_discount(uuid, text, text);
--   DROP TABLE IF EXISTS payment_hops, fee_discounts;
--   DROP TYPE IF EXISTS discount_status_enum, hop_status_enum, payment_party_enum;
--   -- and re-apply 056's payment_ledger definition.

DO $$ BEGIN
  CREATE TYPE payment_party_enum AS ENUM
    ('student', 'skeure', 'university', 'bank');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hop_status_enum AS ENUM ('pending', 'sent', 'settled', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE discount_status_enum AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE payment_party_enum   OWNER TO supabase_admin;
ALTER TYPE hop_status_enum      OWNER TO supabase_admin;
ALTER TYPE discount_status_enum OWNER TO supabase_admin;

CREATE TABLE IF NOT EXISTS payment_hops (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  hop_order INTEGER NOT NULL,
  from_party payment_party_enum NOT NULL,
  to_party payment_party_enum NOT NULL,
  moved_at TIMESTAMPTZ,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method payment_method_enum,
  reference TEXT,
  status hop_status_enum NOT NULL DEFAULT 'pending',
  note TEXT,
  recorded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_id, hop_order),
  -- A leg from a party to itself is a data-entry slip, not a movement.
  CONSTRAINT hop_parties_differ CHECK (from_party <> to_party),
  -- A settled or sent leg has a date. Without it "when did we remit" has no
  -- answer, which is the question this table exists to answer.
  CONSTRAINT hop_moved_when_settled CHECK (
    status IN ('pending', 'failed') OR moved_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_payment_hops_payment
  ON payment_hops(payment_id, hop_order);

CREATE TABLE IF NOT EXISTS fee_discounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES student_fee_plans(id) ON DELETE SET NULL,
  installment_id UUID REFERENCES student_fee_installments(id) ON DELETE SET NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  -- Required, not optional. An unexplained discount is the one a reviewer
  -- cannot decide on, and "why" is the whole content of the approval.
  reason TEXT NOT NULL,
  status discount_status_enum NOT NULL DEFAULT 'pending',
  proposed_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  decided_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT discount_reason_not_blank CHECK (length(btrim(reason)) > 0),
  CONSTRAINT discount_decision_recorded CHECK (
    status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_fee_discounts_contact
  ON fee_discounts(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fee_discounts_pending
  ON fee_discounts(account_id, created_at DESC)
  WHERE status = 'pending';

ALTER TABLE payment_hops  ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_discounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read payment hops" ON payment_hops;
CREATE POLICY "Members read payment hops" ON payment_hops
  FOR SELECT USING (is_account_member(account_id));
-- Counsellors record the inbound leg they witnessed; correcting or removing a
-- leg is an admin action, because a hop is the audit trail of where money went.
DROP POLICY IF EXISTS "Counsellors record payment hops" ON payment_hops;
CREATE POLICY "Counsellors record payment hops" ON payment_hops
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent'::account_role_enum)
  );
DROP POLICY IF EXISTS "Admins amend payment hops" ON payment_hops;
CREATE POLICY "Admins amend payment hops" ON payment_hops
  FOR UPDATE USING (is_account_member(account_id, 'admin'::account_role_enum))
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
DROP POLICY IF EXISTS "Admins delete payment hops" ON payment_hops;
CREATE POLICY "Admins delete payment hops" ON payment_hops
  FOR DELETE USING (is_account_member(account_id, 'admin'::account_role_enum));

DROP POLICY IF EXISTS "Members read fee discounts" ON fee_discounts;
CREATE POLICY "Members read fee discounts" ON fee_discounts
  FOR SELECT USING (is_account_member(account_id));
-- Same shape as payments: a counsellor may propose, but only as themselves and
-- only as pending. Approving your own discount is not a UI oversight to guard
-- against, it is refused here.
DROP POLICY IF EXISTS "Counsellors propose discounts" ON fee_discounts;
CREATE POLICY "Counsellors propose discounts" ON fee_discounts
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent'::account_role_enum)
    AND proposed_by = auth.uid()
    AND status = 'pending'
    AND decided_by IS NULL
  );
DROP POLICY IF EXISTS "Admins decide discounts" ON fee_discounts;
CREATE POLICY "Admins decide discounts" ON fee_discounts
  FOR UPDATE USING (is_account_member(account_id, 'admin'::account_role_enum))
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
DROP POLICY IF EXISTS "Admins delete discounts" ON fee_discounts;
CREATE POLICY "Admins delete discounts" ON fee_discounts
  FOR DELETE USING (is_account_member(account_id, 'admin'::account_role_enum));

ALTER TABLE payment_hops  OWNER TO supabase_admin;
ALTER TABLE fee_discounts OWNER TO supabase_admin;

REVOKE ALL ON payment_hops, fee_discounts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON payment_hops TO authenticated;
GRANT SELECT, INSERT ON fee_discounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON payment_hops, fee_discounts
  TO service_role;

-- ============================================================
-- decide_fee_discount(discount_id, status, note)
--
-- Admin approval or rejection. A function rather than a policy for the same
-- reason verify_payment is: the browser role has no UPDATE grant at all, so
-- the only route to a decision is through here.
--
-- Rejecting writes a follow-up entry against the contact. The operator chose
-- to have discounts take effect immediately, which means a rejection RAISES a
-- balance the counsellor has probably already quoted. Leaving that as a silent
-- number change is how a student gets told one figure and billed another; the
-- timeline entry puts it where the counsellor will actually see it.
--
-- The follow-up insert satisfies its own RLS: the policies key on auth.uid(),
-- which survives SECURITY DEFINER, so this writes as the deciding admin rather
-- than as the function owner.
-- ============================================================
CREATE OR REPLACE FUNCTION public.decide_fee_discount(
  p_discount_id uuid,
  p_status text,
  p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d fee_discounts%ROWTYPE;
  v_contact_name text;
  v_currency text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Status must be approved or rejected, got %', p_status
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO d FROM fee_discounts WHERE id = p_discount_id;
  IF d.id IS NULL THEN
    RAISE EXCEPTION 'Discount not found' USING ERRCODE = '42704';
  END IF;

  IF NOT is_account_member(d.account_id, 'admin'::account_role_enum) THEN
    RAISE EXCEPTION 'Deciding a discount requires admin in this account'
      USING ERRCODE = '42501';
  END IF;

  IF d.status <> 'pending' THEN
    RAISE EXCEPTION 'Discount is already %, not awaiting a decision', d.status
      USING ERRCODE = '22023';
  END IF;

  UPDATE fee_discounts
  SET status = p_status::discount_status_enum,
      decided_by = auth.uid(),
      decided_at = now(),
      decision_note = p_note
  WHERE id = p_discount_id;

  IF p_status = 'rejected' THEN
    SELECT ct.name INTO v_contact_name FROM contacts ct WHERE ct.id = d.contact_id;
    SELECT COALESCE(pl.currency, acc.default_currency, 'INR')
      INTO v_currency
    FROM accounts acc
    LEFT JOIN student_fee_plans pl ON pl.contact_id = d.contact_id
    WHERE acc.id = d.account_id;

    INSERT INTO follow_up_entries
      (account_id, contact_id, occurred_at, method, summary, logged_by)
    VALUES (
      d.account_id,
      d.contact_id,
      now(),
      'call',
      format(
        'Discount of %s %s was NOT approved. Reason given: %s.%s '
        || 'The outstanding balance has gone back up by this amount, so if a '
        || 'lower figure was already quoted to %s it needs correcting.',
        v_currency, trim(to_char(d.amount, 'FM999999999.00')), d.reason,
        CASE WHEN p_note IS NULL OR btrim(p_note) = ''
             THEN '' ELSE ' Decision note: ' || p_note || '.' END,
        COALESCE(v_contact_name, 'the student')
      ),
      auth.uid()
    );
  END IF;
END;
$$;

ALTER FUNCTION public.decide_fee_discount(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.decide_fee_discount(uuid, text, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.decide_fee_discount(uuid, text, text)
  TO authenticated;

-- ============================================================
-- payment_ledger, replacing the 056 definition.
--
-- Adds three things: discounts (everything not rejected, per the operator's
-- immediate-effect decision), in_hand (settled inbound minus settled outbound,
-- the derived commission / float), and pending_discounts so the UI can mark
-- the reversible part.
-- ============================================================
-- The return columns change, and CREATE OR REPLACE cannot alter a function's
-- OUT parameters ("cannot change return type of existing function"). Drop
-- first. Safe: nothing holds a reference to it across a transaction, and the
-- migration recreates it immediately.
DROP FUNCTION IF EXISTS public.payment_ledger(uuid);

CREATE FUNCTION public.payment_ledger(p_account_id uuid)
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
  discounts numeric,
  pending_discounts numeric,
  outstanding numeric,
  in_hand numeric,
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
    AND (pl.id IS NOT NULL OR pay.last_at IS NOT NULL OR disc.live_sum IS NOT NULL)
  ORDER BY
    GREATEST(
      COALESCE(pl.agreed_total, 0)
        - COALESCE(pay.verified_sum, 0)
        - COALESCE(disc.live_sum, 0),
      0) DESC,
    ct.name;
END;
$$;

ALTER FUNCTION public.payment_ledger(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.payment_ledger(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.payment_ledger(uuid) TO authenticated;
