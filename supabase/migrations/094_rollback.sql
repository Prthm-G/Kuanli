-- 094_rollback.sql: undo 094_counsellor_number_privacy.sql. Chats on counsellor numbers become visible to every member
-- again, as before 094: unlink the counsellor numbers first (apply-kuanli-counsellor-number.mjs --rollback) or delete
-- those chats if counsellors must not see them. Moves no row.
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS guard_counsellor_chat_delete ON public.conversations;
DROP FUNCTION IF EXISTS public.guard_counsellor_chat_delete();
DROP TRIGGER IF EXISTS refuse_member_media_proxy_url ON public.messages;
DROP FUNCTION IF EXISTS public.refuse_member_media_proxy_url();
DROP TRIGGER IF EXISTS refuse_hidden_chat_reference ON public.deals;
DROP TRIGGER IF EXISTS refuse_hidden_chat_reference ON public.follow_up_entries;
DROP FUNCTION IF EXISTS public.refuse_hidden_chat_reference();

-- 084's claim, exactly as before 094.
CREATE OR REPLACE FUNCTION public.claim_webhook_inbox(p_limit integer DEFAULT 20, p_min_age_seconds integer DEFAULT 120)
 RETURNS TABLE(id bigint, body jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  DELETE FROM public.webhook_inbox w WHERE w.processed_at < now() - interval '7 days';
  RETURN QUERY
  UPDATE public.webhook_inbox w SET attempts = w.attempts + 1, claimed_at = now()
   WHERE w.id IN (SELECT i.id FROM public.webhook_inbox i
                   WHERE i.processed_at IS NULL AND i.attempts < 5
                     AND i.received_at < now() - make_interval(secs => p_min_age_seconds)
                     AND (i.claimed_at IS NULL OR i.claimed_at < now() - interval '5 minutes')
                   ORDER BY i.id LIMIT p_limit
                   FOR UPDATE SKIP LOCKED)
  RETURNING w.id, w.body;
END $function$;

DROP TRIGGER IF EXISTS assign_lead_number_on_other_chat ON public.conversations;
DROP TRIGGER IF EXISTS assign_lead_number_on_other_chat ON public.deals;
DROP TRIGGER IF EXISTS assign_lead_number_on_other_chat ON public.student_fee_plans;
DROP TRIGGER IF EXISTS assign_lead_number_on_other_chat ON public.payments;
DROP FUNCTION IF EXISTS public.assign_lead_number_on_other_chat();
DROP TRIGGER IF EXISTS contacts_counsellor_number_only_guard ON public.contacts;
DROP FUNCTION IF EXISTS public.contacts_counsellor_number_only_guard();
DROP TRIGGER IF EXISTS contacts_counsellor_number_only_insert ON public.contacts;
DROP FUNCTION IF EXISTS public.contacts_counsellor_number_only_insert();
DROP TRIGGER IF EXISTS record_counsellor_number ON public.counsellors;
DROP FUNCTION IF EXISTS public.record_counsellor_number();
DROP FUNCTION IF EXISTS public.clear_counsellor_number_only(uuid);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['deals', 'payments', 'fee_discounts', 'student_fee_plans', 'contact_notes', 'follow_up_entries',
                           'follow_up_log', 'contact_tags', 'contact_custom_values', 'application_documents',
                           'broadcast_recipients', 'counsellor_assignments', 'student_fee_installments', 'payment_receipts',
                           'payment_hops', 'deal_stage_events'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS hide_counsellor_number_contacts ON public.%I', t);
  END LOOP;
END $$;
-- As live before 094.
GRANT EXECUTE ON FUNCTION public.merge_duplicate_contacts() TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_conversation_summary(uuid) TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.update_contact_enrollment(p_contact_id uuid, p_university text, p_intake_year text, p_intake_session text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.apply_fee_template(p_contact_id uuid, p_template_id uuid, p_start_date date DEFAULT CURRENT_DATE)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  IF COALESCE(t.application_fee, 0) > 0 THEN
    INSERT INTO student_fee_installments
      (account_id, plan_id, head, label, amount, due_date, position)
    VALUES (v_account_id, v_plan_id, 'application', 'Application fee',
            t.application_fee, p_start_date, 0);
    v_total := v_total + t.application_fee;
  END IF;

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
        v_account_id, v_plan_id, 'exam', i,
        -- A lump-sum plan has one term, and its examination figure covers the
        -- whole programme. Numbering it "1" made 8,000 look like one
        -- semester's exam fee rather than four.
        CASE
          WHEN t.payment_option = 'lump_sum'
            THEN 'Examination fee (whole programme)'
          ELSE 'Examination fee ' || i
        END,
        t.exam_fee,
        p_start_date + ((i - 1) * v_months || ' months')::interval,
        i * 10 + 1
      );
      v_total := v_total + t.exam_fee;
    END IF;
  END LOOP;

  UPDATE student_fee_plans
  SET agreed_total = CASE
        WHEN COALESCE(t.total_fee, 0) > 0
          THEN t.total_fee + COALESCE(t.application_fee, 0)
        ELSE v_total
      END
  WHERE id = v_plan_id;

  RETURN v_plan_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.growth_live(p_account_id uuid, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_since timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'owner'::account_role_enum) THEN
    RAISE EXCEPTION 'This page is for the account owner'
      USING ERRCODE = '42501';
  END IF;

  -- IST midnight, (days - 1) days ago: exactly `days` whole IST days incl. today.
  v_since := (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
              - make_interval(days => LEAST(GREATEST(p_days, 1), 120) - 1))
             AT TIME ZONE 'Asia/Kolkata';

  RETURN jsonb_build_object(
    'last_ad_referral_at', (
      SELECT max(ad_referral_at) FROM conversations WHERE account_id = p_account_id
    ),
    'daily', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'day', d.day, 'new_conversations', d.new_conversations,
               'ad_referrals', d.ad_referrals) ORDER BY d.day DESC)
      FROM (
        SELECT day, sum(n_new)::int AS new_conversations, sum(n_ad)::int AS ad_referrals
        FROM (
          SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, 1 AS n_new, 0 AS n_ad
          FROM conversations WHERE account_id = p_account_id AND created_at >= v_since
          UNION ALL
          SELECT (COALESCE(ad_referral_msg_at, ad_referral_at) AT TIME ZONE 'Asia/Kolkata')::date, 0, 1
          FROM conversations
          WHERE account_id = p_account_id
            AND COALESCE(ad_referral_msg_at, ad_referral_at) >= v_since
        ) x
        GROUP BY day
      ) d
    ), '[]'::jsonb),
    'by_ad', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ad_source_id', a.ad_source_id, 'conversations', a.n,
               'last_at', a.last_at) ORDER BY a.n DESC, a.last_at DESC)
      FROM (
        SELECT ad_source_id, count(*)::int AS n,
               max(COALESCE(ad_referral_msg_at, ad_referral_at)) AS last_at
        FROM conversations
        WHERE account_id = p_account_id
          AND COALESCE(ad_referral_msg_at, ad_referral_at) >= v_since
          AND ad_source_id IS NOT NULL
        GROUP BY ad_source_id
        ORDER BY count(*) DESC
        LIMIT 25
      ) a
    ), '[]'::jsonb),
    'by_number', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'phone_number_id', b.phone_number_id,
               'display_phone_number', b.display_phone_number,
               'conversations', b.n, 'last_at', b.last_at) ORDER BY b.n DESC)
      FROM (
        SELECT c.phone_number_id, max(w.display_phone_number) AS display_phone_number,
               count(*)::int AS n, max(c.created_at) AS last_at
        FROM conversations c
        LEFT JOIN whatsapp_config w
          ON w.phone_number_id = c.phone_number_id AND w.account_id = c.account_id
        WHERE c.account_id = p_account_id AND c.created_at >= v_since
        GROUP BY c.phone_number_id
      ) b
    ), '[]'::jsonb),
    'contacts_by_source', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('source', s.source, 'contacts', s.n) ORDER BY s.n DESC)
      FROM (
        SELECT source, count(*)::int AS n
        FROM contacts
        WHERE account_id = p_account_id AND created_at >= v_since
        GROUP BY source
      ) s
    ), '[]'::jsonb)
  );
END;
$function$;

DROP FUNCTION IF EXISTS public.create_counsellor_number_contact(uuid, uuid, text, text, text);
DROP INDEX IF EXISTS public.messages_proxied_media_url;
ALTER TABLE public.whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_history_scope_check;
ALTER TABLE public.whatsapp_config DROP COLUMN IF EXISTS history_scope;

-- Contacts policies and the contact functions exactly as they were before 094. Contacts that arrived through a
-- counsellor number keep a NULL roll_number (no LD number); they become visible to every member.
DROP POLICY IF EXISTS contacts_delete ON public.contacts;
CREATE POLICY contacts_delete ON public.contacts FOR DELETE USING (is_account_member(account_id, 'agent'::account_role_enum));

DROP POLICY IF EXISTS contacts_select ON public.contacts;
CREATE POLICY contacts_select ON public.contacts FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS contacts_update ON public.contacts;
CREATE POLICY contacts_update ON public.contacts FOR UPDATE USING (is_account_member(account_id, 'agent'::account_role_enum));

CREATE OR REPLACE FUNCTION public.generate_temp_lead_id()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.roll_number IS NULL THEN
        NEW.roll_number := 'LD-' || TO_CHAR(NOW(), 'YYMM') || '-' || LPAD(nextval('temp_lead_seq')::text, 4, '0');
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.follow_up_overdue_count(p_account_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
      RAISE EXCEPTION 'This action requires membership in this account'
        USING ERRCODE = '42501';
    END IF;
  ELSIF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_count
  FROM contacts ct
  JOIN LATERAL (
    SELECT fe.next_due_at FROM follow_up_entries fe
    WHERE fe.contact_id = ct.id
    ORDER BY fe.occurred_at DESC, fe.created_at DESC
    LIMIT 1
  ) e ON e.next_due_at IS NOT NULL AND e.next_due_at < now()
  WHERE ct.account_id = p_account_id;

  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.follow_up_timeline(p_account_id uuid, p_contact_id uuid)
 RETURNS TABLE(source text, entry_id uuid, occurred_at timestamp with time zone, method text, outcome text, summary text, next_due_at timestamp with time zone, next_method text, actor_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    'manual'::text,
    e.id,
    e.occurred_at,
    e.method::text,
    e.outcome::text,
    e.summary,
    e.next_due_at,
    e.next_method::text,
    pr.full_name
  FROM follow_up_entries e
  LEFT JOIN profiles pr ON pr.user_id = e.logged_by
  WHERE e.account_id = p_account_id AND e.contact_id = p_contact_id

  UNION ALL

  SELECT
    'auto'::text,
    l.id,
    l.sent_at,
    'whatsapp'::text,
    NULL::text,
    -- What the ladder actually sent. Template rungs carry no body, so name
    -- the template instead of showing an empty row.
    COALESCE(r.body, 'Template: ' || r.template_name, 'Automated follow-up'),
    NULL::timestamptz,
    NULL::text,
    'Rung ' || r.rung_order::text
  FROM follow_up_log l
  JOIN follow_up_rungs r ON r.id = l.rung_id
  WHERE l.account_id = p_account_id AND l.contact_id = p_contact_id

  ORDER BY 3 DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.follow_up_worklist(p_account_id uuid)
 RETURNS TABLE(contact_id uuid, entry_id uuid, conversation_id uuid, name text, phone text, roll_number text, university text, stage_name text, occurred_at timestamp with time zone, method followup_method_enum, outcome followup_outcome_enum, summary text, next_due_at timestamp with time zone, next_method followup_method_enum, logged_by uuid, logged_by_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    e.id,
    e.conversation_id,
    ct.name,
    ct.phone,
    ct.roll_number,
    ct.university,
    ps.name,
    e.occurred_at,
    e.method,
    e.outcome,
    e.summary,
    e.next_due_at,
    e.next_method,
    e.logged_by,
    pr.full_name
  FROM contacts ct
  -- The newest entry only. An older promise that has since been superseded
  -- by a newer log line is settled by definition.
  JOIN LATERAL (
    SELECT fe.* FROM follow_up_entries fe
    WHERE fe.contact_id = ct.id
    ORDER BY fe.occurred_at DESC, fe.created_at DESC
    LIMIT 1
  ) e ON e.next_due_at IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT d.stage_id FROM deals d
    WHERE d.contact_id = ct.id AND d.account_id = p_account_id
    ORDER BY d.updated_at DESC NULLS LAST LIMIT 1
  ) dl ON true
  LEFT JOIN pipeline_stages ps ON ps.id = dl.stage_id
  LEFT JOIN profiles pr ON pr.user_id = e.logged_by
  WHERE ct.account_id = p_account_id
  ORDER BY e.next_due_at ASC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.payment_ledger(p_account_id uuid)
 RETURNS TABLE(contact_id uuid, name text, phone text, roll_number text, university text, program text, payment_option text, currency text, plan_id uuid, agreed_total numeric, received numeric, reported numeric, discounts numeric, pending_discounts numeric, outstanding numeric, in_hand numeric, next_due_label text, next_due_date date, next_due_amount numeric, last_payment_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- The policies exactly as they were before 094.
DROP POLICY IF EXISTS conversations_delete ON public.conversations;
CREATE POLICY conversations_delete ON public.conversations FOR DELETE USING (is_account_member(account_id, 'agent'::account_role_enum));

DROP POLICY IF EXISTS conversations_insert ON public.conversations;
CREATE POLICY conversations_insert ON public.conversations FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));

DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS conversations_update ON public.conversations;
CREATE POLICY conversations_update ON public.conversations FOR UPDATE USING (is_account_member(account_id, 'agent'::account_role_enum));

DROP POLICY IF EXISTS message_reactions_modify ON public.message_reactions;
CREATE POLICY message_reactions_modify ON public.message_reactions USING ((EXISTS ( SELECT 1
   FROM (messages m
     JOIN conversations c ON ((c.id = m.conversation_id)))
  WHERE ((m.id = message_reactions.message_id) AND is_account_member(c.account_id, 'agent'::account_role_enum))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (messages m
     JOIN conversations c ON ((c.id = m.conversation_id)))
  WHERE ((m.id = message_reactions.message_id) AND is_account_member(c.account_id, 'agent'::account_role_enum)))));

DROP POLICY IF EXISTS message_reactions_select ON public.message_reactions;
CREATE POLICY message_reactions_select ON public.message_reactions FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (messages m
     JOIN conversations c ON ((c.id = m.conversation_id)))
  WHERE ((m.id = message_reactions.message_id) AND is_account_member(c.account_id)))));

DROP POLICY IF EXISTS messages_modify ON public.messages;
CREATE POLICY messages_modify ON public.messages USING ((EXISTS ( SELECT 1
   FROM conversations c
  WHERE ((c.id = messages.conversation_id) AND is_account_member(c.account_id, 'agent'::account_role_enum))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM conversations c
  WHERE ((c.id = messages.conversation_id) AND is_account_member(c.account_id, 'agent'::account_role_enum)))));

DROP POLICY IF EXISTS messages_select ON public.messages;
CREATE POLICY messages_select ON public.messages FOR SELECT USING ((EXISTS ( SELECT 1
   FROM conversations c
  WHERE ((c.id = messages.conversation_id) AND is_account_member(c.account_id)))));

-- The functions exactly as they were before 094 (093's and live).
CREATE OR REPLACE FUNCTION public.counsellor_held_leads(p_account_id uuid)
 RETURNS TABLE(counsellor_id uuid, conversation_id uuid, contact_id uuid, source text, assigned_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH held AS (
    SELECT x.counsellor_id, x.conversation_id, x.contact_id, x.source, x.assigned_at
      FROM (
        (SELECT DISTINCT ON (a.contact_id) a.counsellor_id, a.conversation_id, a.contact_id, 'assigned'::text AS source, a.assigned_at
           FROM counsellor_assignments a
          WHERE a.account_id = p_account_id
          ORDER BY a.contact_id, a.assigned_at DESC)
        UNION ALL
        SELECT q.counsellor_id, q.conversation_id, q.contact_id, 'restored', q.restored_at
          FROM lost_restore_queue q
         WHERE q.account_id = p_account_id AND q.restored_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM counsellor_assignments a WHERE a.contact_id = q.contact_id)
      ) x
      JOIN conversations cv ON cv.id = x.conversation_id
      JOIN counsellors c ON c.id = x.counsellor_id
     -- An owner set by hand wins: a reassigned lead leaves the old counsellor.
     WHERE cv.assigned_agent_id IS NULL OR cv.assigned_agent_id = c.profile_id
  )
  SELECT * FROM held
  UNION ALL
  SELECT o.counsellor_id, o.conversation_id, o.contact_id, 'owned', o.assigned_at
    FROM (SELECT DISTINCT ON (c.id, cv.contact_id) c.id AS counsellor_id, cv.id AS conversation_id, cv.contact_id,
                 COALESCE((SELECT max(a.assigned_at) FROM counsellor_assignments a WHERE a.contact_id = cv.contact_id),
                          greatest(cv.created_at, cv.last_message_at)) AS assigned_at
            FROM conversations cv
            JOIN counsellors c ON c.profile_id = cv.assigned_agent_id AND c.account_id = cv.account_id
           WHERE cv.account_id = p_account_id
           ORDER BY c.id, cv.contact_id, cv.last_message_at DESC NULLS LAST) o
   WHERE NOT EXISTS (SELECT 1 FROM held h WHERE h.counsellor_id = o.counsellor_id AND h.contact_id = o.contact_id)
$function$
;

CREATE OR REPLACE FUNCTION public.my_assigned_conversation_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT l.conversation_id
    FROM profiles p
    JOIN counsellors c ON c.profile_id = p.id
    CROSS JOIN LATERAL counsellor_current_leads(c.account_id) l
   WHERE p.user_id = auth.uid() AND l.counsellor_id = c.id
  UNION
  SELECT cv.id
    FROM profiles p
    JOIN conversations cv ON cv.assigned_agent_id = p.id AND cv.account_id = p.account_id
   WHERE p.user_id = auth.uid()
     AND NOT EXISTS (SELECT 1 FROM (SELECT d.stage_id FROM deals d WHERE d.contact_id = cv.contact_id
                                     ORDER BY d.created_at DESC NULLS LAST LIMIT 1) ld
                       JOIN pipeline_stages s ON s.id = ld.stage_id
                      WHERE s.name IN ('Lost', 'Not Interested'))
$function$
;

CREATE OR REPLACE FUNCTION public.lead_queue(p_account_id uuid)
 RETURNS TABLE(deal_id uuid, contact_id uuid, conversation_id uuid, name text, phone text, roll_number text, stage_name text, stage_position integer, interest_university text, interest_mode text, interest_course text, interest_specialization text, ad_headline text, ad_body text, source text, customer_messages bigint, last_customer_at timestamp with time zone, last_agent_at timestamp with time zone, last_follow_up_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    d.id,
    ct.id,
    conv.id,
    ct.name,
    ct.phone,
    ct.roll_number,
    ps.name,
    ps.position,
    intr.interest_university,
    intr.interest_mode,
    intr.interest_course,
    intr.interest_specialization,
    ct.ad_headline,
    ct.ad_body,
    ct.source,
    COALESCE(msg.customer_messages, 0),
    msg.last_customer_at,
    msg.last_agent_at,
    (SELECT max(fe.occurred_at) FROM follow_up_entries fe
      WHERE fe.contact_id = ct.id AND fe.account_id = p_account_id)
  FROM deals d
  JOIN pipeline_stages ps ON ps.id = d.stage_id
  JOIN contacts ct ON ct.id = d.contact_id
  LEFT JOIN LATERAL (
    SELECT c.id FROM conversations c
    WHERE c.contact_id = ct.id
    ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1
  ) conv ON true
  LEFT JOIN LATERAL (
    SELECT c.interest_university, c.interest_mode, c.interest_course,
           c.interest_specialization
    FROM conversations c
    WHERE c.contact_id = ct.id AND c.interest_updated_at IS NOT NULL
    ORDER BY c.interest_updated_at DESC LIMIT 1
  ) intr ON true
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE m.sender_type = 'customer') AS customer_messages,
      max(m.created_at) FILTER (WHERE m.sender_type = 'customer') AS last_customer_at,
      max(m.created_at) FILTER (WHERE m.sender_type = 'agent') AS last_agent_at
    FROM messages m
    JOIN conversations c2 ON c2.id = m.conversation_id
    WHERE c2.contact_id = ct.id
  ) msg ON true
  WHERE d.account_id = p_account_id
    AND ps.name NOT IN ('Enrolled', 'Lost', 'Not Interested');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.application_tracker(p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'stage', row->>'name'), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'contact_id', ct.id,
      'name', ct.name,
      'phone', ct.phone,
      'roll_number', ct.roll_number,
      'university', ct.university,
      'stage', ps.name,
      'conversation_id', conv.id,
      'required', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'doc_type', r.doc_type,
          'label', r.label,
          'status', COALESCE((
            SELECT ad.status FROM application_documents ad
            WHERE ad.contact_id = ct.id AND ad.doc_type = r.doc_type
            ORDER BY ad.created_at DESC LIMIT 1
          ), 'missing'),
          'document_id', (
            SELECT ad.id FROM application_documents ad
            WHERE ad.contact_id = ct.id AND ad.doc_type = r.doc_type
            ORDER BY ad.created_at DESC LIMIT 1
          )
        ) ORDER BY r.position)
        FROM university_required_docs r
        WHERE r.account_id = p_account_id
          AND r.university = COALESCE(ct.university, 'LPU')
      ), '[]'::jsonb),
      'unsorted', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'document_id', ad.id,
          'created_at', ad.created_at,
          'media_url', m.media_url,
          'content_text', m.content_text,
          'content_type', m.content_type
        ) ORDER BY ad.created_at DESC)
        FROM application_documents ad
        LEFT JOIN messages m ON m.id = ad.message_id
        WHERE ad.contact_id = ct.id AND ad.doc_type IS NULL
          AND ad.status <> 'rejected'
      ), '[]'::jsonb)
    ) AS row
    FROM deals d
    JOIN pipeline_stages ps ON ps.id = d.stage_id
      AND ps.name IN ('Application Started', 'Enrolled')
    JOIN contacts ct ON ct.id = d.contact_id
    LEFT JOIN LATERAL (
      SELECT c.id FROM conversations c
      WHERE c.contact_id = ct.id
      ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1
    ) conv ON true
    WHERE d.account_id = p_account_id
  ) rows;

  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.capture_application_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contact_id uuid;
  v_account_id uuid;
BEGIN
  IF NEW.sender_type <> 'customer'
     OR NEW.content_type NOT IN ('image', 'document') THEN
    RETURN NEW;
  END IF;

  SELECT c.contact_id, c.account_id INTO v_contact_id, v_account_id
  FROM conversations c WHERE c.id = NEW.conversation_id;

  IF v_contact_id IS NULL THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM deals d
    JOIN pipeline_stages ps ON ps.id = d.stage_id
    WHERE d.contact_id = v_contact_id
      AND ps.name IN ('Application Started', 'Enrolled')
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO application_documents (account_id, contact_id, message_id, status)
  VALUES (v_account_id, v_contact_id, NEW.id, 'received');

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.create_chat_link(p_conversation uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE t text;
BEGIN
  IF p_conversation IS NULL OR NOT EXISTS (SELECT 1 FROM conversations WHERE id = p_conversation) THEN RETURN NULL; END IF;
  SELECT token INTO t FROM chat_links
   WHERE conversation_id = p_conversation AND expires_at > now() + interval '1 day'
   ORDER BY expires_at DESC LIMIT 1;
  IF t IS NOT NULL THEN RETURN t; END IF;
  t := translate(encode(gen_random_bytes(18), 'base64'), '+/', '-_');
  INSERT INTO chat_links (token, conversation_id) VALUES (t, p_conversation);
  DELETE FROM chat_links WHERE expires_at < now() - interval '30 days';
  RETURN t;
END $function$
;

CREATE OR REPLACE FUNCTION public.follow_ups_due(p_account_id uuid, p_limit integer DEFAULT 25)
 RETURNS TABLE(contact_id uuid, conversation_id uuid, rung_id uuid, rung_order integer, body text, template_name text, contact_name text, interest_university text, hours_silent numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    ct.id,
    conv.id,
    rung.id,
    rung.rung_order,
    rung.body,
    rung.template_name,
    ct.name,
    intr.interest_university,
    round(EXTRACT(EPOCH FROM (now() - m.last_customer_at)) / 3600, 1)
  FROM contacts ct
  JOIN deals d ON d.contact_id = ct.id AND d.account_id = p_account_id
  JOIN pipeline_stages ps ON ps.id = d.stage_id
    AND ps.name IN ('New Lead', 'Engaged', 'Qualified', 'Counselor Active')
  JOIN LATERAL (
    SELECT c.id, c.bot_active FROM conversations c
    WHERE c.contact_id = ct.id
    ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1
  ) conv ON true
  JOIN LATERAL (
    SELECT max(msg.created_at) FILTER (WHERE msg.sender_type = 'customer') AS last_customer_at
    FROM messages msg
    JOIN conversations c2 ON c2.id = msg.conversation_id
    WHERE c2.contact_id = ct.id
  ) m ON m.last_customer_at IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT c.interest_university FROM conversations c
    WHERE c.contact_id = ct.id AND c.interest_updated_at IS NOT NULL
    ORDER BY c.interest_updated_at DESC LIMIT 1
  ) intr ON true
  JOIN LATERAL (
    SELECT r.* FROM follow_up_rungs r
    WHERE r.account_id = p_account_id
      AND r.active
      AND EXTRACT(EPOCH FROM (now() - m.last_customer_at)) / 3600 >= r.delay_hours
      AND (r.template_name IS NOT NULL
           OR EXTRACT(EPOCH FROM (now() - m.last_customer_at)) / 3600 < 24)
      -- this rung has not fired this spell
      AND NOT EXISTS (
        SELECT 1 FROM follow_up_log l
        WHERE l.contact_id = ct.id AND l.rung_id = r.id
          AND l.sent_at > m.last_customer_at)
      -- no higher rung has fired this spell
      AND NOT EXISTS (
        SELECT 1 FROM follow_up_log l
        JOIN follow_up_rungs r2 ON r2.id = l.rung_id
        WHERE l.contact_id = ct.id
          AND l.sent_at > m.last_customer_at
          AND r2.rung_order >= r.rung_order)
    ORDER BY r.rung_order
    LIMIT 1
  ) rung ON true
  WHERE ct.account_id = p_account_id
    AND COALESCE(conv.bot_active, true)
    -- spacing guard: at most one follow-up per contact per 24h
    AND NOT EXISTS (
      SELECT 1 FROM follow_up_log l
      WHERE l.contact_id = ct.id
        AND l.sent_at > now() - INTERVAL '24 hours')
  ORDER BY m.last_customer_at ASC
  LIMIT p_limit;
$function$
;

CREATE OR REPLACE FUNCTION public.lifecycle_sweep(p_account_id uuid, p_lost_after_days integer DEFAULT 14)
 RETURNS TABLE(deal_id uuid, contact_id uuid, from_stage text, to_stage text)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_intake_id uuid;
  v_app_started_pos integer;
BEGIN
  SELECT id INTO v_intake_id FROM pipelines
    WHERE account_id = p_account_id AND name = 'Student Admissions';
  IF v_intake_id IS NULL THEN
    RAISE EXCEPTION 'lifecycle_sweep: % has no "Student Admissions" intake pipeline — the first argument must be an ACCOUNT id (changed in migration 047)', p_account_id;
  END IF;

  SELECT position INTO v_app_started_pos FROM pipeline_stages
    WHERE pipeline_id = v_intake_id AND name = 'Application Started';
  IF v_app_started_pos IS NULL THEN
    RAISE EXCEPTION 'lifecycle_sweep: intake pipeline is missing "Application Started"';
  END IF;

  CREATE TEMP TABLE _lifecycle_signals ON COMMIT DROP AS
  SELECT
    ct.id AS cid,
    ct.account_id,
    ct.user_id,
    ct.phone,
    bool_or(cv.interest_university IS NOT NULL) AS univ_resolved,
    ct.university IS NOT NULL AS roll_issued,
    max(cv.created_at) AS newest_conv_at,
    bool_or(msg.bot_reply) AS bot_reply,
    bool_or(msg.agent_reply) AS agent_reply,
    max(msg.last_customer_at) AS last_customer_at
  FROM contacts ct
  JOIN conversations cv ON cv.contact_id = ct.id
  LEFT JOIN LATERAL (
    SELECT
      bool_or(m.sender_type = 'bot') AS bot_reply,
      bool_or(m.sender_type = 'agent') AS agent_reply,
      max(m.created_at) FILTER (WHERE m.sender_type = 'customer') AS last_customer_at
    FROM messages m WHERE m.conversation_id = cv.id
  ) msg ON true
  WHERE ct.account_id = p_account_id
  GROUP BY ct.id, ct.account_id, ct.user_id, ct.phone, ct.university;

  ALTER TABLE _lifecycle_signals
    ADD COLUMN target_pipeline_id uuid,
    ADD COLUMN floor_name text,
    ADD COLUMN floor_pos integer,
    ADD COLUMN stale boolean;

  -- Route target. A roll number pins the university (the enrollment code is
  -- part of the permanent id), so it outranks conversational interest, which
  -- can flap. Unresolved or unrecognised falls back to intake.
  UPDATE _lifecycle_signals s SET target_pipeline_id = COALESCE(
    (SELECT p.id FROM pipelines p
      WHERE p.account_id = p_account_id
        AND p.name = (
          SELECT CASE ct.university
            WHEN 'LPU' THEN 'LPU Admissions'
            WHEN 'AMI' THEN 'Amity Admissions'
            WHEN 'DBU' THEN 'DBU Admissions'
          END
          FROM contacts ct WHERE ct.id = s.cid AND s.roll_issued
        )),
    (SELECT p.id FROM pipelines p
      WHERE p.account_id = p_account_id
        AND p.name = (
          SELECT c.interest_university || ' Admissions' FROM conversations c
          WHERE c.contact_id = s.cid AND c.interest_updated_at IS NOT NULL
          ORDER BY c.interest_updated_at DESC LIMIT 1
        )),
    v_intake_id);

  UPDATE _lifecycle_signals s SET
    floor_name = CASE
      WHEN s.roll_issued THEN 'Application Started'
      WHEN s.agent_reply THEN 'Counselor Active'
      WHEN s.univ_resolved THEN 'Qualified'
      WHEN s.bot_reply THEN 'Engaged'
      ELSE 'New Lead'
    END,
    stale = COALESCE(s.last_customer_at, s.newest_conv_at)
              < now() - make_interval(days => p_lost_after_days);
  UPDATE _lifecycle_signals s SET floor_pos =
    (SELECT position FROM pipeline_stages
      WHERE pipeline_id = v_intake_id AND name = s.floor_name);

  -- Step 1: every contact with a conversation gets a deal, created directly
  -- in its target pipeline.
  RETURN QUERY
  WITH ins AS (
    INSERT INTO deals (account_id, user_id, pipeline_id, contact_id,
                       conversation_id, title, stage_id, currency, value, notes)
    SELECT s.account_id, s.user_id, s.target_pipeline_id, s.cid,
           (SELECT cv.id FROM conversations cv WHERE cv.contact_id = s.cid
             ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1),
           'Lead - ' || s.phone,
           (SELECT id FROM pipeline_stages
             WHERE pipeline_id = s.target_pipeline_id AND name = 'New Lead'),
           'INR', 0, 'Source: organic'
    FROM _lifecycle_signals s
    WHERE NOT EXISTS (SELECT 1 FROM deals d
                       WHERE d.contact_id = s.cid AND d.account_id = p_account_id)
    RETURNING deals.id, deals.contact_id
  )
  SELECT ins.id, ins.contact_id, NULL::text, 'New Lead'::text FROM ins;

  -- Step 2: route existing deals to the pipeline their university points at,
  -- keeping the stage by name. Lost and Not Interested never route; Application Started+
  -- routes only on the roll number (interest flapping cannot move them).
  RETURN QUERY
  WITH upd AS (
    UPDATE deals d SET
      pipeline_id = s.target_pipeline_id,
      stage_id = tgt.id
    FROM _lifecycle_signals s, pipeline_stages cur, pipeline_stages tgt
    WHERE d.account_id = p_account_id
      AND d.contact_id = s.cid
      AND d.pipeline_id <> s.target_pipeline_id
      AND cur.id = d.stage_id
      AND (cur.position < v_app_started_pos OR s.roll_issued)
      AND cur.name NOT IN ('Lost', 'Not Interested')
      AND tgt.pipeline_id = s.target_pipeline_id
      AND tgt.name = cur.name
    RETURNING d.id, d.contact_id, cur.name
  )
  SELECT upd.id, upd.contact_id, upd.name, upd.name FROM upd;

  -- Step 3: revive Lost and Not Interested deals whose contact messaged after
  -- the move there and within the Lost window.
  RETURN QUERY
  WITH upd AS (
    UPDATE deals d SET stage_id = f.id
    FROM _lifecycle_signals s, pipeline_stages cur, pipeline_stages f
    WHERE d.account_id = p_account_id
      AND d.contact_id = s.cid
      AND cur.id = d.stage_id
      AND cur.name IN ('Lost', 'Not Interested')
      AND f.pipeline_id = d.pipeline_id
      AND f.name = s.floor_name
      AND s.last_customer_at > d.updated_at
      AND s.last_customer_at >= now() - make_interval(days => p_lost_after_days)
    RETURNING d.id, d.contact_id, cur.name AS from_name, s.floor_name
  )
  SELECT upd.id, upd.contact_id, upd.from_name, upd.floor_name FROM upd;

  -- Step 4: mark stale deals Lost (below Application Started only).
  RETURN QUERY
  WITH upd AS (
    UPDATE deals d SET stage_id = lost.id
    FROM _lifecycle_signals s, pipeline_stages cur, pipeline_stages lost
    WHERE d.account_id = p_account_id
      AND d.contact_id = s.cid
      AND cur.id = d.stage_id
      AND cur.position < v_app_started_pos
      -- 093: Not Interested sits after Lost, so the position test already skips it. Said outright.
      AND cur.name <> 'Not Interested'
      AND lost.pipeline_id = d.pipeline_id
      AND lost.name = 'Lost'
      AND s.stale
      -- 091: silence on the bot number says nothing once a person has the lead, because counsellors reply from
      -- their own phones. Only a human marks those Lost.
      AND (d.lost_snooze_until IS NULL OR d.lost_snooze_until <= now())
      AND NOT EXISTS (SELECT 1 FROM counsellor_assignments a WHERE a.contact_id = d.contact_id)
      AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = d.contact_id AND c.assigned_agent_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM follow_up_entries f WHERE f.contact_id = d.contact_id
                        AND f.occurred_at >= now() - make_interval(days => p_lost_after_days))
      AND NOT EXISTS (SELECT 1 FROM deal_stage_events e WHERE e.deal_id = d.id AND e.changed_by IS NOT NULL
                        AND e.changed_at >= now() - make_interval(days => p_lost_after_days))
    RETURNING d.id, d.contact_id, cur.name
  )
  SELECT upd.id, upd.contact_id, upd.name, 'Lost'::text FROM upd;

  -- Step 5: forward-only advance to the signal floor within the deal's own
  -- pipeline. Position comparison excludes Lost and Enrolled as before.
  RETURN QUERY
  WITH upd AS (
    UPDATE deals d SET stage_id = f.id
    FROM _lifecycle_signals s, pipeline_stages cur, pipeline_stages f
    WHERE d.account_id = p_account_id
      AND d.contact_id = s.cid
      AND cur.id = d.stage_id
      AND f.pipeline_id = d.pipeline_id
      AND f.name = s.floor_name
      AND cur.position < s.floor_pos
    RETURNING d.id, d.contact_id, cur.name, s.floor_name
  )
  SELECT upd.id, upd.contact_id, upd.name, upd.floor_name FROM upd;

  DROP TABLE _lifecycle_signals;
END;
$function$
;

REVOKE ALL ON FUNCTION public.counsellor_held_leads(uuid) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.contacts_hidden_from_me();
DROP INDEX IF EXISTS public.contacts_counsellor_number_only;
-- Contacts that arrived through a counsellor number become ordinary contacts (still with no LD number).
ALTER TABLE public.contacts DROP COLUMN IF EXISTS counsellor_number_only;
DROP FUNCTION IF EXISTS public.counsellor_phone_number_ids();
DROP FUNCTION IF EXISTS public.can_see_counsellor_chats(uuid);
-- The record of every number ever linked (the list above read it).
DROP TABLE IF EXISTS public.counsellor_number_history;
