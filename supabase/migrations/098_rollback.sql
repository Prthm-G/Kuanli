-- 098_rollback.sql  (KB-BRANCHES-R2): every member sees every lead of the account again, as after 094 + 097.
-- Restores the 094 contacts policies, the readers' 093-096 bodies and the storage policies verbatim; drops the owner
-- column, its log, writers, guards and the Option 1 functions. Counsellor rows that Add member created or linked stay
-- (they are ordinary R1 rotation entries). Run with psql -1, after rolling the Kuanli image back to pre-098.

SET LOCAL lock_timeout = '5s';

-- 4. RLS
DROP POLICY IF EXISTS own_leads_only ON public.conversations;
DROP POLICY IF EXISTS own_leads_only ON public.deals;
DROP POLICY IF EXISTS own_leads_only ON public.meta_conversion_events;
DROP POLICY IF EXISTS own_leads_only ON public.flow_runs;
DROP POLICY IF EXISTS own_leads_only ON public.automation_logs;
DROP POLICY IF EXISTS contacts_select ON public.contacts;
CREATE POLICY contacts_select ON public.contacts FOR SELECT USING (
  public.is_account_member(account_id)
  AND (NOT counsellor_number_only OR public.can_see_counsellor_chats(account_id)));
DROP POLICY IF EXISTS contacts_update ON public.contacts;
CREATE POLICY contacts_update ON public.contacts FOR UPDATE USING (
  public.is_account_member(account_id, 'agent'::public.account_role_enum)
  AND (NOT counsellor_number_only OR public.can_see_counsellor_chats(account_id)));
DROP POLICY IF EXISTS contacts_delete ON public.contacts;
CREATE POLICY contacts_delete ON public.contacts FOR DELETE USING (
  public.is_account_member(account_id, 'agent'::public.account_role_enum)
  AND (NOT counsellor_number_only OR public.can_see_counsellor_chats(account_id)));

-- 5. the readers, as 093/094/095/096 left them
CREATE OR REPLACE FUNCTION public.application_tracker(p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_hidden text[];
  v_all_contacts boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

  -- 094: counsellor numbers, and contacts that arrived through one, unless the caller is an admin or the owner.
  v_hidden := CASE WHEN can_see_counsellor_chats(p_account_id) THEN '{}'::text[]
                   ELSE counsellor_phone_number_ids() END;
  v_all_contacts := can_see_counsellor_chats(p_account_id);

  SELECT COALESCE(jsonb_agg(row ORDER BY sort_pos, row->>'name'), '[]'::jsonb)
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
    ) AS row, ps.position AS sort_pos
    FROM deals d
    JOIN pipeline_stages ps ON ps.id = d.stage_id
      AND ps.position BETWEEN public.stage_position(ps.pipeline_id, 'Application Started')
                          AND public.stage_position(ps.pipeline_id, 'Enrolled')
    JOIN contacts ct ON ct.id = d.contact_id
    LEFT JOIN LATERAL (
      SELECT c.id FROM conversations c
      WHERE c.contact_id = ct.id
        AND NOT coalesce(c.phone_number_id = ANY (v_hidden), false)
      ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1
    ) conv ON true
    WHERE d.account_id = p_account_id
      AND (v_all_contacts OR NOT ct.counsellor_number_only)
  ) rows;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.follow_up_worklist(p_account_id uuid)
 RETURNS TABLE(contact_id uuid, entry_id uuid, conversation_id uuid, name text, phone text, roll_number text, university text, stage_name text, occurred_at timestamp with time zone, method followup_method_enum, outcome followup_outcome_enum, summary text, next_due_at timestamp with time zone, next_method followup_method_enum, logged_by uuid, logged_by_name text)
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
    AND (v_all_contacts OR NOT ct.counsellor_number_only)
  ORDER BY e.next_due_at ASC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.lead_queue(p_account_id uuid)
 RETURNS TABLE(deal_id uuid, contact_id uuid, conversation_id uuid, name text, phone text, roll_number text, stage_name text, stage_position integer, interest_university text, interest_mode text, interest_course text, interest_specialization text, ad_headline text, ad_body text, source text, customer_messages bigint, last_customer_at timestamp with time zone, last_agent_at timestamp with time zone, last_follow_up_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hidden text[];
  v_all_contacts boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

  -- 094: counsellor numbers, and contacts that arrived through one, unless the caller is an admin or the owner.
  v_hidden := CASE WHEN can_see_counsellor_chats(p_account_id) THEN '{}'::text[]
                   ELSE counsellor_phone_number_ids() END;
  v_all_contacts := can_see_counsellor_chats(p_account_id);

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
      AND NOT coalesce(c.phone_number_id = ANY (v_hidden), false)
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
      AND NOT coalesce(c2.phone_number_id = ANY (v_hidden), false)
  ) msg ON true
  WHERE d.account_id = p_account_id
    AND (v_all_contacts OR NOT ct.counsellor_number_only)
    AND ps.name NOT IN ('Enrolled', 'Lost', 'Not Interested');
END;
$function$;

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

CREATE OR REPLACE FUNCTION public.follow_up_overdue_count(p_account_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
  v_all_contacts boolean := true;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
      RAISE EXCEPTION 'This action requires membership in this account'
        USING ERRCODE = '42501';
    END IF;
  ELSIF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- 094: a logged-in member below admin does not count contacts that arrived through a counsellor number. The
  -- service role (the owner's EOD email) counts them all.
  IF auth.uid() IS NOT NULL THEN
    v_all_contacts := can_see_counsellor_chats(p_account_id);
  END IF;

  SELECT count(*) INTO v_count
  FROM contacts ct
  JOIN LATERAL (
    SELECT fe.next_due_at FROM follow_up_entries fe
    WHERE fe.contact_id = ct.id
    ORDER BY fe.occurred_at DESC, fe.created_at DESC
    LIMIT 1
  ) e ON e.next_due_at IS NOT NULL AND e.next_due_at < now()
  WHERE ct.account_id = p_account_id
    AND (v_all_contacts OR NOT ct.counsellor_number_only);

  RETURN v_count;
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
  v_hidden boolean;
  v_plan_id uuid;
  v_months integer;
  v_terms integer;
  v_total numeric(12,2) := 0;
  i integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, counsellor_number_only INTO v_account_id, v_hidden FROM contacts WHERE id = p_contact_id;
  -- 094: a contact that arrived through a counsellor number is "not found" below admin, like a missing one.
  IF v_account_id IS NULL OR (v_hidden AND NOT can_see_counsellor_chats(v_account_id)) THEN
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

CREATE OR REPLACE FUNCTION public.update_contact_enrollment(p_contact_id uuid, p_university text, p_intake_year text, p_intake_session text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account_id UUID;
  v_hidden boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, counsellor_number_only INTO v_account_id, v_hidden FROM contacts WHERE id = p_contact_id;

  -- 094: a contact that arrived through a counsellor number is "not found" below admin, like a missing one.
  IF v_account_id IS NULL OR (v_hidden AND NOT can_see_counsellor_chats(v_account_id)) THEN
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

  -- 094: nothing about a contact that arrived through a counsellor number, below admin.
  IF NOT can_see_counsellor_chats(p_account_id)
     AND EXISTS (SELECT 1 FROM contacts WHERE id = p_contact_id AND counsellor_number_only) THEN
    RETURN;
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

CREATE OR REPLACE FUNCTION public.funnel_analytics(p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sources jsonb;
  v_funnel jsonb;
  v_interest jsonb;
  v_trend jsonb;
  v_totals jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

  -- Per-deal facts shared by totals, sources, and interest.
  CREATE TEMP TABLE _fa_deals ON COMMIT DROP AS
  SELECT
    d.id,
    d.contact_id,
    cur.name AS current_stage,
    GREATEST(
      CASE WHEN cur.name NOT IN ('Lost', 'Not Interested') THEN cur.position ELSE 0 END,
      COALESCE((
        SELECT max(ps2.position) FROM deal_stage_events e
        JOIN pipeline_stages ps2 ON ps2.id = e.to_stage_id
        WHERE e.deal_id = d.id AND ps2.name NOT IN ('Lost', 'Not Interested')
      ), 0)
    ) AS reached_pos,
    (SELECT sm.position FROM pipeline_stages sm
      WHERE sm.pipeline_id = d.pipeline_id AND sm.name = 'Qualified') AS qualified_pos,
    (SELECT sm.position FROM pipeline_stages sm
      WHERE sm.pipeline_id = d.pipeline_id AND sm.name = 'Counselor Active') AS counselor_pos,
    (SELECT sm.position FROM pipeline_stages sm
      WHERE sm.pipeline_id = d.pipeline_id AND sm.name = 'Application Started') AS application_pos,
    COALESCE(
      NULLIF(ct.ad_headline, ''),
      NULLIF(left(ct.ad_body, 60), ''),
      'Organic'
    ) AS source,
    intr.interest_university
  FROM deals d
  JOIN pipeline_stages cur ON cur.id = d.stage_id
  JOIN contacts ct ON ct.id = d.contact_id
  LEFT JOIN LATERAL (
    SELECT c.interest_university FROM conversations c
    WHERE c.contact_id = ct.id AND c.interest_updated_at IS NOT NULL
    ORDER BY c.interest_updated_at DESC LIMIT 1
  ) intr ON true
  WHERE d.account_id = p_account_id;

  SELECT jsonb_build_object(
    'leads', count(*),
    'enrolled', count(*) FILTER (WHERE current_stage = 'Enrolled'),
    'lost', count(*) FILTER (WHERE current_stage = 'Lost'),
    'reached_application', count(*) FILTER (WHERE reached_pos >= application_pos)
  ) INTO v_totals FROM _fa_deals;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'leads')::int DESC), '[]'::jsonb)
  INTO v_sources
  FROM (
    SELECT jsonb_build_object(
      'source', source,
      'leads', count(*),
      'qualified', count(*) FILTER (WHERE reached_pos >= qualified_pos),
      'counselor', count(*) FILTER (WHERE reached_pos >= counselor_pos),
      'application', count(*) FILTER (WHERE reached_pos >= application_pos),
      'enrolled', count(*) FILTER (WHERE current_stage = 'Enrolled'),
      'lost', count(*) FILTER (WHERE current_stage = 'Lost')
    ) AS row
    FROM _fa_deals GROUP BY source
  ) s;

  -- Current + ever-reached counts per stage NAME. Migration 047 split deals
  -- across per-university pipelines whose ladders are clones, so the account
  -- funnel groups by name (a per-pipeline row set would list every stage
  -- once per board). Lost and Not Interested (093) keep their current count only: they are exits, not
  -- a rung on the ladder.
  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'position')::int), '[]'::jsonb)
  INTO v_funnel
  FROM (
    SELECT jsonb_build_object(
      'stage', ps.name,
      'position', ps.position,
      'current', (SELECT count(*) FROM _fa_deals f WHERE f.current_stage = ps.name),
      'reached', CASE WHEN ps.name IN ('Lost', 'Not Interested') THEN NULL
                      ELSE (SELECT count(*) FROM _fa_deals f WHERE f.reached_pos >= ps.position) END
    ) AS row
    FROM (
      SELECT DISTINCT s.name, s.position FROM pipeline_stages s
      WHERE s.pipeline_id IN (
        SELECT DISTINCT d.pipeline_id FROM deals d WHERE d.account_id = p_account_id
      )
    ) ps
  ) f;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'leads')::int DESC), '[]'::jsonb)
  INTO v_interest
  FROM (
    SELECT jsonb_build_object(
      'university', COALESCE(interest_university, 'Unresolved'),
      'leads', count(*),
      'application', count(*) FILTER (WHERE reached_pos >= application_pos),
      'enrolled', count(*) FILTER (WHERE current_stage = 'Enrolled'),
      'lost', count(*) FILTER (WHERE current_stage = 'Lost')
    ) AS row
    FROM _fa_deals GROUP BY interest_university
  ) i;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'day')), '[]'::jsonb)
  INTO v_trend
  FROM (
    SELECT jsonb_build_object(
      'day', day::text,
      'median_minutes', round(med::numeric, 1),
      'responses', n
    ) AS row
    FROM (
      SELECT (resp_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_minutes) AS med,
             count(*) AS n
      FROM (
        SELECT m.created_at AS resp_at,
               EXTRACT(EPOCH FROM (m.created_at - lag(m.created_at) OVER w)) / 60 AS gap_minutes,
               m.sender_type,
               lag(m.sender_type) OVER w AS prev_type
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.account_id = p_account_id
          AND m.created_at >= now() - INTERVAL '14 days'
        WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.created_at)
      ) pairs
      WHERE sender_type = 'agent' AND prev_type = 'customer'
      GROUP BY 1
    ) days
  ) t;

  DROP TABLE _fa_deals;

  RETURN jsonb_build_object(
    'totals', v_totals,
    'sources', v_sources,
    'funnel', v_funnel,
    'interest', v_interest,
    'response_trend', v_trend
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.pipeline_funnel(p_account_id uuid, p_pipeline_id uuid)
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

  IF NOT EXISTS (
    SELECT 1 FROM pipelines p
    WHERE p.id = p_pipeline_id AND p.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'Pipeline not found in this account' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'position')::int), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'stage', ps.name,
      'position', ps.position,
      'color', ps.color,
      'current', (
        SELECT count(*) FROM deals d WHERE d.stage_id = ps.id
      ),
      'reached', CASE WHEN ps.name IN ('Lost', 'Not Interested') THEN NULL ELSE (
        SELECT count(DISTINCT x.deal_id) FROM (
          SELECT d.id AS deal_id FROM deals d
          JOIN pipeline_stages cur ON cur.id = d.stage_id
          WHERE d.pipeline_id = p_pipeline_id
            AND cur.name NOT IN ('Lost', 'Not Interested')
            AND cur.position >= ps.position
          UNION
          SELECT e.deal_id FROM deal_stage_events e
          JOIN pipeline_stages es ON es.id = e.to_stage_id
          WHERE es.pipeline_id = p_pipeline_id
            AND es.name NOT IN ('Lost', 'Not Interested')
            AND es.position >= ps.position
        ) x
      ) END,
      'median_hours', (
        SELECT round(percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (sp.left_at - sp.entered_at)) / 3600
               )::numeric, 1)
        FROM (
          SELECT e.changed_at AS entered_at,
                 lead(e.changed_at) OVER (PARTITION BY e.deal_id ORDER BY e.changed_at) AS left_at,
                 e.to_stage_id
          FROM deal_stage_events e
          WHERE e.account_id = p_account_id
        ) sp
        WHERE sp.to_stage_id = ps.id AND sp.left_at IS NOT NULL
      )
    ) AS row
    FROM pipeline_stages ps
    WHERE ps.pipeline_id = p_pipeline_id
  ) f;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.duplicate_payment_reference(p_account_id uuid, p_reference text)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p_reference IS NULL OR btrim(p_reference) = '' THEN 0 ELSE
    (SELECT count(*)::int FROM public.payments p
      WHERE p.account_id = p_account_id AND p.status::text NOT IN ('rejected', 'reversed')
        AND lower(btrim(p.reference)) = lower(btrim(p_reference))) END $function$;

-- 6. storage, as before 098
DROP POLICY IF EXISTS "Chat media readable by uploader and admins" ON storage.objects;
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
CREATE POLICY "Chat media is publicly readable" ON storage.objects FOR SELECT USING (bucket_id = 'chat-media'::text);
DROP POLICY IF EXISTS "Members read application docs" ON storage.objects;
CREATE POLICY "Members read application docs" ON storage.objects FOR SELECT USING (
  (bucket_id = 'application-docs'::text)
  AND public.is_account_member((NULLIF(replace(split_part(name, '/'::text, 1), 'account-'::text, ''::text), ''::text))::uuid));
DROP POLICY IF EXISTS "Members read payment receipts storage" ON storage.objects;
CREATE POLICY "Members read payment receipts storage" ON storage.objects FOR SELECT USING (
  (bucket_id = 'payment-receipts'::text)
  AND public.is_account_member((NULLIF(replace(split_part(name, '/'::text, 1), 'account-'::text, ''::text), ''::text))::uuid));
DROP INDEX IF EXISTS public.application_documents_storage_path;
DROP INDEX IF EXISTS public.payment_receipts_storage_path;

-- 7. Option 1, 3. writers and guards, 2. helpers, 1. the column and its log
DROP FUNCTION IF EXISTS public.add_counsellor(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.set_counsellor_active(uuid, boolean);
DROP FUNCTION IF EXISTS public.set_contact_owner(uuid, uuid, uuid);
DROP TRIGGER IF EXISTS contact_owner_from_chat ON public.conversations;
DROP TRIGGER IF EXISTS contact_owner_from_assignment ON public.counsellor_assignments;
DROP TRIGGER IF EXISTS contact_owner_audit ON public.contacts;
DROP TRIGGER IF EXISTS contact_owner_guard ON public.contacts;
DROP FUNCTION IF EXISTS public.contact_owner_from_chat();
DROP FUNCTION IF EXISTS public.contact_owner_from_assignment();
DROP FUNCTION IF EXISTS public.contact_owner_audit();
DROP FUNCTION IF EXISTS public.contact_owner_guard();
DROP FUNCTION IF EXISTS public.set_owner_trusted(uuid, uuid, text, boolean);
DROP FUNCTION IF EXISTS public.my_account_ids(public.account_role_enum);
DROP FUNCTION IF EXISTS public.my_profile_id();
DROP TABLE IF EXISTS public.contact_owner_log;
DROP INDEX IF EXISTS public.contacts_account_owner;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS owner_profile_id;
