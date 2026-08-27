-- 060_lump_sum_exam_label.sql
-- KB-FEEPAY-R4-38
--
-- On a lump-sum plan the examination line covers the whole programme, not one
-- term: an LPU Online MBA lump sum carries 8,000, which is 2,000 x 4. It was
-- being labelled "Examination fee 1", which reads as a single semester's exam
-- fee priced four times too high. A counsellor reading the schedule to a
-- student would have to work out that it is not.
--
-- Only the label changes. Amounts, ordering and totals are untouched.
--
-- Rollback: re-apply the apply_fee_template definition from migration 056.

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
$$;

ALTER FUNCTION public.apply_fee_template(uuid, uuid, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_fee_template(uuid, uuid, date)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.apply_fee_template(uuid, uuid, date)
  TO authenticated;
