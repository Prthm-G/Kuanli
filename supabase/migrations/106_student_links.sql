-- 106 (KB-JOURNEY-R1B): "same student" records, read-only. No merge: rows never move, only reads widen.
-- A student's set = the opened contact + its phone twin (same last 10 digits, both numbers 10 digits or 91 + 10)
-- + one hop over contact_links from either, with each linked contact's phone twin, minus contact_link_exclusions pairs.
-- Every function is SECURITY INVOKER: contacts_select (098) and the restrictive hide_counsellor_number_contacts policies
-- (094) decide what each caller gets, and a link row is visible only when both of its contacts are.
CREATE INDEX IF NOT EXISTS contacts_account_phone_last10
  ON public.contacts (account_id, right(phone_normalized, 10))
  WHERE phone_normalized ~ '^(91)?[0-9]{10}$';

CREATE TABLE IF NOT EXISTS public.contact_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_a  uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  contact_b  uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_links_ordered CHECK (contact_a < contact_b),
  CONSTRAINT contact_links_pair UNIQUE (account_id, contact_a, contact_b)
);
CREATE INDEX IF NOT EXISTS contact_notes_contact_time ON public.contact_notes (contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS contact_links_b ON public.contact_links (account_id, contact_b);

CREATE TABLE IF NOT EXISTS public.contact_link_exclusions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_a  uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  contact_b  uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_link_exclusions_ordered CHECK (contact_a < contact_b),
  CONSTRAINT contact_link_exclusions_pair UNIQUE (account_id, contact_a, contact_b)
);
CREATE INDEX IF NOT EXISTS contact_link_exclusions_b ON public.contact_link_exclusions (account_id, contact_b);

ALTER TABLE public.contact_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_link_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_links, public.contact_link_exclusions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.contact_links, public.contact_link_exclusions TO authenticated;
GRANT ALL ON public.contact_links, public.contact_link_exclusions TO service_role;

-- Read or write a row only when the caller can see both contacts (the EXISTS runs under contacts_select, so a hidden
-- contact's id is never confirmed). Writes need agent; created_by is the caller. No UPDATE policy: rows are immutable.
DO $$
DECLARE t text; both_seen text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contact_links', 'contact_link_exclusions'] LOOP
    both_seen := format($b$EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = %1$I.contact_a AND c.account_id = %1$I.account_id)
      AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = %1$I.contact_b AND c.account_id = %1$I.account_id)$b$, t);
    EXECUTE format('DROP POLICY IF EXISTS %1$I ON public.%2$I', t || '_select', t);
    EXECUTE format('CREATE POLICY %1$I ON public.%2$I FOR SELECT TO authenticated USING (
      account_id = ANY ((SELECT public.my_account_ids(''viewer''))::uuid[]) AND %3$s)', t || '_select', t, both_seen);
    EXECUTE format('DROP POLICY IF EXISTS %1$I ON public.%2$I', t || '_insert', t);
    EXECUTE format('CREATE POLICY %1$I ON public.%2$I FOR INSERT TO authenticated WITH CHECK (
      account_id = ANY ((SELECT public.my_account_ids(''agent''))::uuid[]) AND created_by = auth.uid() AND %3$s)', t || '_insert', t, both_seen);
    EXECUTE format('DROP POLICY IF EXISTS %1$I ON public.%2$I', t || '_delete', t);
    EXECUTE format('CREATE POLICY %1$I ON public.%2$I FOR DELETE TO authenticated USING (
      account_id = ANY ((SELECT public.my_account_ids(''agent''))::uuid[]) AND %3$s)', t || '_delete', t, both_seen);
  END LOOP;
END $$;

-- A link and an exclusion for the same pair cannot coexist. Both triggers are SECURITY INVOKER: the caller's RLS still
-- applies (an exclusion insert needs the same agent role and visibility that deleting the link needs).
CREATE OR REPLACE FUNCTION public.contact_link_exclusion_clears_link() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM public.contact_links WHERE account_id = NEW.account_id AND contact_a = NEW.contact_a AND contact_b = NEW.contact_b;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS contact_link_exclusion_clears_link ON public.contact_link_exclusions;
CREATE TRIGGER contact_link_exclusion_clears_link AFTER INSERT ON public.contact_link_exclusions
  FOR EACH ROW EXECUTE FUNCTION public.contact_link_exclusion_clears_link();

CREATE OR REPLACE FUNCTION public.contact_link_refuses_excluded() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.contact_link_exclusions x WHERE x.account_id = NEW.account_id
                AND x.contact_a = NEW.contact_a AND x.contact_b = NEW.contact_b) THEN
    RAISE EXCEPTION 'these two records are marked as not the same student; remove that first' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS contact_link_refuses_excluded ON public.contact_links;
CREATE TRIGGER contact_link_refuses_excluded BEFORE INSERT ON public.contact_links
  FOR EACH ROW EXECUTE FUNCTION public.contact_link_refuses_excluded();

CREATE OR REPLACE FUNCTION public.student_set(p_account uuid, p_contact uuid)
RETURNS TABLE(contact_id uuid, via text, link_id uuid)
ROWS 8 LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  WITH self AS (
    SELECT c.id, c.phone_normalized AS pn FROM public.contacts c WHERE c.id = p_contact AND c.account_id = p_account
  ),
  near AS (   -- the opened contact and its phone twin
    SELECT s.id, 'self'::text AS via, NULL::uuid AS link_id FROM self s
    UNION ALL
    SELECT c.id, 'phone', NULL FROM self s
      JOIN public.contacts c ON c.account_id = p_account AND c.id <> s.id
       AND c.phone_normalized ~ '^(91)?[0-9]{10}$' AND right(c.phone_normalized, 10) = right(s.pn, 10)
     WHERE s.pn ~ '^(91)?[0-9]{10}$'
       AND NOT EXISTS (SELECT 1 FROM public.contact_link_exclusions x WHERE x.account_id = p_account
                          AND x.contact_a = least(s.id, c.id) AND x.contact_b = greatest(s.id, c.id))
  ),
  hop AS (    -- one link hop from either
    SELECT c.id, c.phone_normalized AS pn, l.id AS link_id
      FROM near n
      JOIN public.contact_links l ON l.account_id = p_account AND n.id IN (l.contact_a, l.contact_b)
      JOIN public.contacts c ON c.account_id = p_account
       AND c.id = CASE WHEN l.contact_a = n.id THEN l.contact_b ELSE l.contact_a END
     WHERE NOT EXISTS (SELECT 1 FROM public.contact_link_exclusions x WHERE x.account_id = p_account
                          AND x.contact_a = least(n.id, c.id) AND x.contact_b = greatest(n.id, c.id))
       AND NOT EXISTS (SELECT 1 FROM public.contact_link_exclusions x WHERE x.account_id = p_account
                          AND x.contact_a = least(p_contact, c.id) AND x.contact_b = greatest(p_contact, c.id))
  ),
  far AS (    -- the linked contacts and their phone twins
    SELECT h.id, 'link'::text AS via, h.link_id FROM hop h
    UNION ALL
    SELECT c.id, 'link', h.link_id FROM hop h
      JOIN public.contacts c ON c.account_id = p_account AND c.id <> h.id
       AND c.phone_normalized ~ '^(91)?[0-9]{10}$' AND right(c.phone_normalized, 10) = right(h.pn, 10)
     WHERE h.pn ~ '^(91)?[0-9]{10}$'
       AND NOT EXISTS (SELECT 1 FROM public.contact_link_exclusions x WHERE x.account_id = p_account
                          AND x.contact_a = least(h.id, c.id) AND x.contact_b = greatest(h.id, c.id))
  ),
  everyone AS (SELECT * FROM near UNION ALL SELECT * FROM far)
  SELECT DISTINCT ON (e.id) e.id, e.via, e.link_id
    FROM everyone e
   WHERE e.via = 'self'
      OR NOT EXISTS (SELECT 1 FROM public.contact_link_exclusions x WHERE x.account_id = p_account
                        AND x.contact_a = least(p_contact, e.id) AND x.contact_b = greatest(p_contact, e.id))
   ORDER BY e.id, CASE e.via WHEN 'self' THEN 0 WHEN 'phone' THEN 1 ELSE 2 END, e.link_id
$$;

CREATE OR REPLACE FUNCTION public.student_contact_ids(p_account uuid, p_contact uuid)
RETURNS SETOF uuid
ROWS 8 LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT s.contact_id FROM public.student_set(p_account, p_contact) s
$$;

-- Manual follow-ups, bot follow-ups, notes and stage moves of the whole set, newest first. The inner join to contacts
-- is a second visibility filter on top of each table's own RLS. Ties on `at` across a page edge can skip a row (rare:
-- two stage moves in one transaction); the UI pages by `at`.
CREATE OR REPLACE FUNCTION public.student_timeline(p_account uuid, p_contact uuid, p_before timestamptz DEFAULT NULL,
                                                   p_limit integer DEFAULT 50)
RETURNS TABLE(kind text, id uuid, at timestamptz, who text, summary text, contact_id uuid, phone_last4 text,
              method text, outcome text, next_due_at timestamptz, next_method text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  WITH ids AS (
    SELECT c.id, nullif(right(c.phone_normalized, 4), '') AS last4
      FROM public.student_contact_ids(p_account, p_contact) AS s(id)
      JOIN public.contacts c ON c.id = s.id AND c.account_id = p_account
  ),
  feed AS (
    SELECT 'follow_up'::text AS kind, e.id, e.occurred_at AS at, pr.full_name AS who, e.summary, e.contact_id,
           ids.last4 AS phone_last4, e.method::text AS method, e.outcome::text AS outcome, e.next_due_at,
           e.next_method::text AS next_method
      FROM public.follow_up_entries e
      JOIN ids ON ids.id = e.contact_id
      LEFT JOIN public.profiles pr ON pr.user_id = e.logged_by
     WHERE e.account_id = p_account
    UNION ALL
    SELECT 'bot_follow_up', l.id, l.sent_at, 'Bot',
           coalesce(r.body, 'Template: ' || r.template_name, 'Automated follow-up'),
           l.contact_id, ids.last4, 'whatsapp', NULL, NULL, NULL
      FROM public.follow_up_log l
      JOIN ids ON ids.id = l.contact_id
      JOIN public.follow_up_rungs r ON r.id = l.rung_id
     WHERE l.account_id = p_account
    UNION ALL
    SELECT 'note', n.id, n.created_at, pr.full_name, n.note_text, n.contact_id, ids.last4, NULL, NULL, NULL, NULL
      FROM public.contact_notes n
      JOIN ids ON ids.id = n.contact_id
      LEFT JOIN public.profiles pr ON pr.user_id = n.user_id
     WHERE n.account_id = p_account
    UNION ALL
    SELECT 'stage', ev.id, ev.changed_at,
           coalesce(pr.full_name, CASE WHEN ev.changed_by IS NULL THEN 'Automation' END),
           CASE WHEN fs.name IS NULL THEN 'Moved to ' || ts.name ELSE fs.name || ' to ' || ts.name END,
           d.contact_id, ids.last4, NULL, NULL, NULL, NULL
      FROM public.deal_stage_events ev
      JOIN public.deals d ON d.id = ev.deal_id AND d.account_id = p_account
      JOIN ids ON ids.id = d.contact_id
      JOIN public.pipeline_stages ts ON ts.id = ev.to_stage_id
      LEFT JOIN public.pipeline_stages fs ON fs.id = ev.from_stage_id
      LEFT JOIN public.profiles pr ON pr.user_id = ev.changed_by
     WHERE ev.account_id = p_account
  )
  SELECT f.kind, f.id, f.at, f.who, f.summary, f.contact_id, f.phone_last4, f.method, f.outcome, f.next_due_at, f.next_method
    FROM feed f
   WHERE f.at IS NOT NULL AND (p_before IS NULL OR f.at < p_before)
   ORDER BY f.at DESC, f.id DESC
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

REVOKE ALL ON FUNCTION public.student_set(uuid, uuid), public.student_contact_ids(uuid, uuid),
  public.student_timeline(uuid, uuid, timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_set(uuid, uuid), public.student_contact_ids(uuid, uuid),
  public.student_timeline(uuid, uuid, timestamptz, integer) TO authenticated, service_role;

DO $$ BEGIN
  IF to_regprocedure('public.applications_punched_gate()') IS NULL THEN RAISE EXCEPTION '106 needs 104 applied first'; END IF;
END $$;
-- Carried from R1a's review: 104's punched gate checked for an existing application row with a plain EXISTS on its INSERT
-- leg, which can see a row a concurrent transaction is moving to another contact. FOR KEY SHARE locks the row it finds, so
-- the answer holds until this transaction ends. Same body otherwise. 106_rollback.sql restores 104's text.
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
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM public.applications a WHERE a.contact_id = NEW.contact_id AND a.account_id = NEW.account_id FOR KEY SHARE;
    IF FOUND THEN RETURN NEW; END IF;
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

