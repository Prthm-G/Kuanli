-- 096_rollback.sql  (KB-ADMISSIONS-R1-17)
-- Undoes 096_admissions_applications.sql. Run in ONE transaction by devtools/apply-kuanli-096.mjs --rollback-db
-- --yes-drop-applications, which exports the data first (applications, payment_events, document_access_log, the payment
-- columns, login kinds, upload marks, referrers, reversed payments) to backups/kuanli-096-rollback-<stamp>/ and then runs this
-- file with `SET LOCAL app.yes_drop_applications = 'on'` in front. Run bare, it REFUSES while any of that data exists.
-- Safe to run twice: with 096 gone it changes nothing but re-asserts the two restored function bodies.
--
-- What 096 added, and what this file does with each (nothing 096 did not add is touched):
--   tables            applications, payment_events (and its sequence), document_access_log       -> dropped (policies, indexes, triggers go with them)
--   payments          head, received_by, collected_by columns (FK and default go with them)      -> dropped; values were exported
--   student_portal_credentials  kind column, CHECK, uq_portal_credentials_contact_kind            -> dropped; kinds were exported
--   application_documents       uploaded_to_portal_at / _by, file_deleted_at                      -> dropped; marks were exported
--   contacts          referred_by_contact_id, its CHECK and index                                 -> dropped; referrers were exported
--   triggers          applications_advance, applications_fill_provisional, applications_mirror_registration,
--                     applications_guard_retain_files, payments_advance, payments_collected_by, payments_freeze, payments_log_event,
--                     portal_credentials_fill_provisional, portal_credentials_then_advance, application_documents_advance,
--                     student_fee_plans_advance, contacts_referrer_same_account                   -> dropped FIRST, before anything they read
--   functions (new)   advance_application, advance_application_on_change, application_checklist, application_card_status,
--                     backfill_applications, mirror_registration_number, default_payment_collected_by, freeze_acknowledged_payment,
--                     log_payment_event, reverse_payment, duplicate_payment_reference, fill_provisional_app_id,
--                     fill_provisional_on_application, check_referrer_same_account, mark_documents_uploaded, guard_retain_files -> dropped
--   functions (replaced)  payment_ledger (094 body), queue_lost_restore (091 body)                -> restored byte for byte (apply script checks md5)
--   payment_status_enum 'reversed'  cannot be dropped from an enum. Every reversed payment is set back to 'verified' with a note
--                     (it was exported first). The label stays; nothing reads it. 096 re-applied finds it (ADD VALUE IF NOT EXISTS).
--   grants            096's REVOKE DELETE on payments / payment_receipts: production's app role (authenticated) holds SELECT, INSERT there
--                     and never held DELETE, so the REVOKE changed nothing and this file grants nothing. apply-kuanli-096.mjs refuses to
--                     apply when authenticated already holds DELETE on either table, so "nothing to restore" is checked, not assumed;
--                     it also prints the ACLs before and after a rollback.
--
-- NOT undone, on purpose:
--   * cards the auto-move advanced stay where they are (their stage events stay). 095_rollback.sql owns the stages.
--   * files in the application-docs storage bucket stay (this file cannot see storage).
--   * Meta conversion events queued by auto-moves stay (they were true when reported).
--   * login kinds: after a re-apply every existing login is a registration login again (a second login of one student becomes
--     'other'). Restore the real kinds from portal-credential-kinds.csv in the rollback export folder.
-- Order matters: the triggers go first so nothing fires while rows are rewritten and dropped; reversed payments are
-- rewritten next (no freeze trigger left to stop it); functions that read what is about to go are dropped before it.

SET LOCAL lock_timeout = '5s';

-- 0. Refuse while there is data to lose --------------------------------------------------------------------------------------
DO $$
DECLARE
  n_app int := 0; n_pev int := 0; n_log int := 0; n_rev int := 0; n_pay int := 0; n_kind int := 0; n_mark int := 0; n_ref int := 0;
  v_total int;
BEGIN
  IF to_regclass('public.applications') IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM public.applications' INTO n_app; END IF;
  IF to_regclass('public.payment_events') IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM public.payment_events' INTO n_pev; END IF;
  IF to_regclass('public.document_access_log') IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM public.document_access_log' INTO n_log; END IF;
  SELECT count(*) INTO n_rev FROM public.payments WHERE status::text = 'reversed';
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.payments'::regclass AND attname = 'head' AND NOT attisdropped) THEN
    EXECUTE $q$SELECT count(*) FROM public.payments WHERE head <> 'other' OR received_by IS NOT NULL OR collected_by IS NOT NULL$q$ INTO n_pay;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.student_portal_credentials'::regclass AND attname = 'kind' AND NOT attisdropped) THEN
    EXECUTE $q$SELECT count(*) FROM public.student_portal_credentials WHERE kind <> 'registration'$q$ INTO n_kind;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.application_documents'::regclass AND attname = 'uploaded_to_portal_at' AND NOT attisdropped) THEN
    EXECUTE $q$SELECT count(*) FROM public.application_documents WHERE uploaded_to_portal_at IS NOT NULL OR uploaded_to_portal_by IS NOT NULL OR file_deleted_at IS NOT NULL$q$ INTO n_mark;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.contacts'::regclass AND attname = 'referred_by_contact_id' AND NOT attisdropped) THEN
    EXECUTE $q$SELECT count(*) FROM public.contacts WHERE referred_by_contact_id IS NOT NULL$q$ INTO n_ref;
  END IF;
  v_total := n_app + n_pev + n_log + n_rev + n_pay + n_kind + n_mark + n_ref;
  IF v_total > 0 AND coalesce(current_setting('app.yes_drop_applications', true), '') <> 'on' THEN
    RAISE EXCEPTION '096 rollback refused: it would drop data (applications %, payment events %, document access log %, reversed payments %, payments with 096 columns set %, non-registration logins %, document marks %, referrers %). Export it, then run apply-kuanli-096.mjs --rollback-db --yes-drop-applications',
      n_app, n_pev, n_log, n_rev, n_pay, n_kind, n_mark, n_ref USING ERRCODE = 'P0001';
  END IF;
END $$;

-- 1. Triggers 096 added ---------------------------------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS applications_advance ON public.applications;
DROP TRIGGER IF EXISTS applications_fill_provisional ON public.applications;
DROP TRIGGER IF EXISTS applications_mirror_registration ON public.applications;
DROP TRIGGER IF EXISTS applications_guard_retain_files ON public.applications;
DROP TRIGGER IF EXISTS payments_advance ON public.payments;
DROP TRIGGER IF EXISTS payments_collected_by ON public.payments;
DROP TRIGGER IF EXISTS payments_freeze ON public.payments;
DROP TRIGGER IF EXISTS payments_log_event ON public.payments;
DROP TRIGGER IF EXISTS portal_credentials_fill_provisional ON public.student_portal_credentials;
DROP TRIGGER IF EXISTS portal_credentials_then_advance ON public.student_portal_credentials;
DROP TRIGGER IF EXISTS application_documents_advance ON public.application_documents;
DROP TRIGGER IF EXISTS student_fee_plans_advance ON public.student_fee_plans;
DROP TRIGGER IF EXISTS contacts_referrer_same_account ON public.contacts;

-- 2. Reversed payments go back to verified, with a note (the label 'reversed' cannot leave the enum) ----------------------------
UPDATE public.payments
   SET status = 'verified',
       decision_note = concat_ws(' | ', nullif(btrim(decision_note), ''), 'Reversal undone by the 096 rollback; the payment counts as verified again')
 WHERE status::text = 'reversed';

-- 3. The two functions 096 replaced, back to their pre-096 bodies (exact copies of production before 096) -----------------------
-- 094_counsellor_number_privacy.sql, as before 096.
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

-- 091_lead_handling.sql, as before 096.
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

-- 4. Functions 096 added (card status first: it wraps the checklist) ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.application_card_status(uuid);
DROP FUNCTION IF EXISTS public.application_checklist(uuid, uuid);
DROP FUNCTION IF EXISTS public.advance_application(uuid);
DROP FUNCTION IF EXISTS public.advance_application_on_change();
DROP FUNCTION IF EXISTS public.backfill_applications(uuid);
DROP FUNCTION IF EXISTS public.mirror_registration_number();
DROP FUNCTION IF EXISTS public.default_payment_collected_by();
DROP FUNCTION IF EXISTS public.freeze_acknowledged_payment();
DROP FUNCTION IF EXISTS public.log_payment_event();
DROP FUNCTION IF EXISTS public.reverse_payment(uuid, text);
DROP FUNCTION IF EXISTS public.duplicate_payment_reference(uuid, text);
DROP FUNCTION IF EXISTS public.fill_provisional_app_id();
DROP FUNCTION IF EXISTS public.fill_provisional_on_application();
DROP FUNCTION IF EXISTS public.check_referrer_same_account();
DROP FUNCTION IF EXISTS public.mark_documents_uploaded(uuid);
DROP FUNCTION IF EXISTS public.guard_retain_files();

-- 5. Tables 096 added (no CASCADE: an unexpected dependent object stops the rollback instead of vanishing) ----------------------
DROP TABLE IF EXISTS public.document_access_log;
DROP TABLE IF EXISTS public.payment_events;
DROP TABLE IF EXISTS public.applications;

-- 6. Columns, constraints and indexes 096 added to existing tables ---------------------------------------------------------------
ALTER TABLE public.payments DROP COLUMN IF EXISTS head, DROP COLUMN IF EXISTS received_by, DROP COLUMN IF EXISTS collected_by;
DROP INDEX IF EXISTS public.uq_portal_credentials_contact_kind;
ALTER TABLE public.student_portal_credentials DROP CONSTRAINT IF EXISTS student_portal_credentials_kind_check;
ALTER TABLE public.student_portal_credentials DROP COLUMN IF EXISTS kind;
ALTER TABLE public.application_documents
  DROP COLUMN IF EXISTS uploaded_to_portal_at, DROP COLUMN IF EXISTS uploaded_to_portal_by, DROP COLUMN IF EXISTS file_deleted_at;
DROP INDEX IF EXISTS public.idx_contacts_referred_by;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_referred_by_not_self;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS referred_by_contact_id;
