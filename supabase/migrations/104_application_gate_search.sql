-- 104 (KB-JOURNEY-R1A): university application number, the "details punched" gate, search_students.
-- Gate fires only when details_punched_at goes from NULL to set, so old punched rows keep saving.
-- Rollback: 104_rollback.sql (refuses while any university_app_number holds a value, unless SET k104.drop_values = 'yes').
ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS university_app_number text;
CREATE INDEX IF NOT EXISTS applications_account_university_app_number
  ON public.applications (account_id, university_app_number);

CREATE OR REPLACE FUNCTION public.is_placeholder_email(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT p IS NULL
      OR btrim(p) !~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
      OR split_part(lower(btrim(p)), '@', 1) IN ('na','n.a','none','test','abc','xyz','noemail','nomail','no','nil','null','demo','sample')
      OR split_part(lower(btrim(p)), '@', 1) ~ '^(.)\1*$'
$$;
REVOKE ALL ON FUNCTION public.is_placeholder_email(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_placeholder_email(text) TO authenticated, service_role;

-- SECURITY DEFINER only to read the one column contacts.email of the row being punched, whatever the caller's contact
-- policies; it returns no data. Who is exempt: the gate applies to browser sessions only (the 'role' setting is
-- authenticated or anon, the same test 098's contact_owner_guard uses; current_user would be the function owner here).
-- So service_role (SET ROLE service_role, or a service_role jwt claim) and the superuser connections (n8n, migrations,
-- backfill) pass, as does a call inside app.suppress_automation = 'on' (096 backfill_applications).
CREATE OR REPLACE FUNCTION public.applications_punched_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_missing text[] := '{}'; v_email text;
BEGIN
  IF NEW.details_punched_at IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.details_punched_at IS NOT NULL THEN RETURN NEW; END IF;
  IF current_setting('role', true) NOT IN ('authenticated', 'anon')
     OR coalesce(auth.role(), '') = 'service_role'
     OR coalesce(current_setting('app.suppress_automation', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  SELECT email INTO v_email FROM public.contacts WHERE id = NEW.contact_id AND account_id = NEW.account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'contact not found in this account' USING ERRCODE = 'P0001'; END IF;
  -- PostgREST upserts (INSERT ... ON CONFLICT (contact_id) DO UPDATE) send only the changed columns, so the proposed row
  -- of this BEFORE INSERT call lacks the stored father_name/program/university. When a row already exists for the contact
  -- the INSERT leg steps aside; the UPDATE leg of the same upsert fires this trigger again with the merged row and checks it.
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM public.applications a
                                   WHERE a.contact_id = NEW.contact_id AND a.account_id = NEW.account_id) THEN
    RETURN NEW;
  END IF;
  IF nullif(btrim(NEW.father_name), '') IS NULL THEN v_missing := v_missing || 'father_name'::text; END IF;
  IF nullif(btrim(NEW.program), '') IS NULL THEN v_missing := v_missing || 'program'::text; END IF;
  IF nullif(btrim(NEW.university), '') IS NULL THEN v_missing := v_missing || 'university'::text; END IF;
  IF public.is_placeholder_email(v_email) THEN v_missing := v_missing || 'email'::text; END IF;
  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'missing: %', array_to_string(v_missing, ',') USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.applications_punched_gate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS applications_punched_gate ON public.applications;
CREATE TRIGGER applications_punched_gate BEFORE INSERT OR UPDATE OF details_punched_at ON public.applications
  FOR EACH ROW EXECUTE FUNCTION public.applications_punched_gate();

-- SECURITY INVOKER: contacts and applications RLS (094 counsellor-number-only, 098 owner / open_to_team) decide the rows.
CREATE OR REPLACE FUNCTION public.search_students(p_account uuid, p_q text)
RETURNS TABLE(contact_id uuid, name text, phone text, university text, provisional_app_id text,
              university_app_number text, registration_number text, matched text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  WITH q AS (SELECT btrim(p_q) t, right(regexp_replace(p_q, '\D', '', 'g'), 10) d)
  SELECT c.id, c.name, c.phone, coalesce(a.university, c.university), a.provisional_app_id,
         a.university_app_number, a.registration_number,
         CASE
           WHEN lower(a.provisional_app_id) = lower(q.t) THEN 'provisional_id'
           WHEN lower(a.university_app_number) = lower(q.t) THEN 'university_app_number'
           WHEN lower(a.registration_number) = lower(q.t) OR lower(c.university_roll_number) = lower(q.t) THEN 'registration_number'
           WHEN length(q.d) = 10 AND right(c.phone_normalized, 10) = q.d THEN 'phone'
           WHEN lower(c.email) = lower(q.t) THEN 'email'
           WHEN lower(c.roll_number) = lower(q.t) THEN 'roll_number'
           ELSE 'name'
         END
    FROM q, public.contacts c
    LEFT JOIN public.applications a ON a.contact_id = c.id
   WHERE c.account_id = p_account AND length(q.t) >= 2
     AND (   lower(a.provisional_app_id) = lower(q.t) OR lower(a.university_app_number) = lower(q.t)
          OR lower(a.registration_number) = lower(q.t) OR lower(c.university_roll_number) = lower(q.t)
          OR lower(c.roll_number) = lower(q.t) OR lower(c.email) = lower(q.t)
          OR (length(q.d) >= 6 AND c.phone_normalized LIKE '%' || q.d || '%')
          OR strpos(lower(c.name), lower(q.t)) > 0)
   ORDER BY coalesce(lower(a.provisional_app_id) = lower(q.t) OR lower(a.university_app_number) = lower(q.t)
                     OR lower(a.registration_number) = lower(q.t), false) DESC,
            c.created_at DESC
   LIMIT 10
$$;
REVOKE ALL ON FUNCTION public.search_students(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_students(uuid, text) TO authenticated, service_role;
