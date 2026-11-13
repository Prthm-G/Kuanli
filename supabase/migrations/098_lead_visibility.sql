-- 098_lead_visibility.sql  (KB-BRANCHES-R2)
-- Counsellors see only their own leads, plus every lead that existed before 098; the owner and admins see everything
-- (owner decisions 2026-11-12/13). Needs 096 (it re-creates 096's readers with the filter added) and 097.
--
-- 0. contacts.open_to_team (owner, 2026-11-13: "Let counsellor see all the old leads"): true on every lead that exists
--    when 098 first runs (ADD COLUMN DEFAULT true, then the default becomes false: no row is rewritten), false on every
--    lead after. "Own lead" below always means: owner_profile_id = me OR open_to_team. Members cannot change it.
--
-- 1. contacts.owner_profile_id: the one owner of a lead (a profiles.id). Backfill (owner's option A): the latest
--    counsellor assignment's login, else the newest chat's assigned_agent_id, else the newest deal's assigned_to, else
--    NULL (owner and admins only).
-- 2. my_profile_id(), my_account_ids(min_role): the caller's profile and accounts, computed once per statement
--    (InitPlans), never once per row. The rule itself is written inline in the contacts policies (a SQL function with
--    sub-selects is not inlined, and a per-row call made the inbox 5-15x slower on 20k leads).
-- 3. Who sets the owner:
--      - a new counsellor assignment (the bot's handover, silent or unanswered pick) to a counsellor with a login;
--        a repeat (sticky) assignment to the same counsellor leaves it alone, so an admin's change sticks;
--      - Kuanli "Assign" on a chat (a human), or any chat assignment while the lead has no owner yet;
--      - a contact a counsellor creates is theirs;
--      - set_contact_owner(contact, profile, branch): admins (the Owner selector), which also moves the lead's chats;
--      - add_counsellor (Kuanli Add member, Option 1) when it links a login to a counsellor seeded earlier.
--    Below admin nobody can write owner_profile_id directly. Every change is logged in contact_owner_log.
-- 4. RLS: contacts SELECT/UPDATE/DELETE add "own lead or admin", so every table 094 hangs off a contact follows. Restrictive
--    own_leads_only on conversations (and so messages, reactions, Realtime), deals with no contact, meta_conversion_
--    events, flow_runs, automation_logs.
-- 4b. Automations and flows (they run as the service role on every lead): admins write them, members read.
-- 5. The SECURITY DEFINER readers that hand lead rows or counts to members get the same rule (below admin: own leads):
--    lead_queue, application_tracker, follow_up_worklist, follow_up_timeline, follow_up_overdue_count, payment_ledger,
--    funnel_analytics, pipeline_funnel, update_contact_enrollment, apply_fee_template. duplicate_payment_reference
--    becomes DEFINER (count only) so the duplicate-UTR check still sees every payment in the account.
-- 6. Storage: application-docs and payment-receipts objects are readable only with a visible document/receipt row;
--    chat-media can no longer be listed by anyone (members of the account still can; public URLs are unchanged).
-- 7. Option 1: add_counsellor and set_counsellor_active (admins): Kuanli's Add member creates or links the rotation
--    entry; the Members list turns rotation on and off (on only after the Telegram join).
-- Service-role code (n8n, webhook, crons, pings) is unaffected. Run with psql -1. Rollback: 098_rollback.sql.

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.applications') IS NULL OR to_regclass('public.branches') IS NULL THEN
    RAISE EXCEPTION '098 needs 096 (admissions applications) and 097 (branches) live first';
  END IF;
END $$;

-- Every table whose policies or triggers change, locked once, up front, in one order: waiting (up to 5 s, then the apply
-- script retries) happens before anything is held, not halfway through. About a second on prod's size.
LOCK TABLE public.contacts, public.conversations, public.deals, public.counsellor_assignments, public.meta_conversion_events,
  public.flow_runs, public.automation_logs, public.automations, public.automation_steps, public.flows, public.flow_nodes,
  public.payment_receipts, public.application_documents, storage.objects IN ACCESS EXCLUSIVE MODE;
-- the backfill runs only the first time (a re-run must not re-own leads an admin has unowned since)
SELECT set_config('kuanli.k098_first_run', (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
  AND table_name = 'contacts' AND column_name = 'owner_profile_id'))::text, true);

-- 1. the owner column ---------------------------------------------------------------------------------------------------
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS owner_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
-- every lead that exists now stays visible to the whole team; new leads start private (see 0. above)
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS open_to_team boolean NOT NULL DEFAULT true;
ALTER TABLE public.contacts ALTER COLUMN open_to_team SET DEFAULT false;
CREATE INDEX IF NOT EXISTS contacts_account_owner ON public.contacts (account_id, owner_profile_id);

CREATE TABLE IF NOT EXISTS public.contact_owner_log (
  id         bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  old_owner  uuid,
  new_owner  uuid,
  changed_by uuid,                       -- auth.uid() of a logged-in caller; NULL for the bot, crons and psql
  via        text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_owner_log_contact ON public.contact_owner_log (contact_id, at DESC);
ALTER TABLE public.contact_owner_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_owner_log_admin_read ON public.contact_owner_log;
CREATE POLICY contact_owner_log_admin_read ON public.contact_owner_log FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'admin'::public.account_role_enum));
REVOKE ALL ON public.contact_owner_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.contact_owner_log TO authenticated;
GRANT SELECT, INSERT ON public.contact_owner_log TO service_role;
REVOKE ALL ON SEQUENCE public.contact_owner_log_id_seq FROM PUBLIC, anon, authenticated;

-- Backfill (option A), first run only. Replica mode: no updated_at and no row triggers on thousands of rows (logical
-- decoding still sees each change). The lead's LATEST counsellor decides: their login, or nobody yet if they have no
-- login (add_counsellor hands those over when it links one). The joins on profiles drop stale ids (assigned_agent_id
-- has no foreign key).
SET LOCAL session_replication_role = replica;
UPDATE public.contacts ct SET owner_profile_id = coalesce(
    (SELECT p.id FROM (SELECT a.counsellor_id FROM public.counsellor_assignments a
                        WHERE a.contact_id = ct.id ORDER BY a.assigned_at DESC LIMIT 1) l
       JOIN public.counsellors c ON c.id = l.counsellor_id
       JOIN public.profiles p ON p.id = c.profile_id AND p.account_id = ct.account_id),
    (SELECT cv.assigned_agent_id FROM public.conversations cv
       JOIN public.profiles p ON p.id = cv.assigned_agent_id AND p.account_id = ct.account_id
      WHERE cv.contact_id = ct.id ORDER BY cv.updated_at DESC NULLS LAST LIMIT 1),
    (SELECT d.assigned_to FROM public.deals d
       JOIN public.profiles p ON p.id = d.assigned_to AND p.account_id = ct.account_id
      WHERE d.contact_id = ct.id ORDER BY d.created_at DESC NULLS LAST LIMIT 1))
 WHERE ct.owner_profile_id IS NULL AND current_setting('kuanli.k098_first_run', true) = 'true';
SET LOCAL session_replication_role = origin;

-- 2. the visibility rule --------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_profile_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT p.id FROM public.profiles p WHERE p.user_id = auth.uid() $$;
ALTER FUNCTION public.my_profile_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.my_profile_id() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_profile_id() TO anon, authenticated, service_role;   -- anon: NULL, never raises

-- Accounts where the caller has at least p_min_role (same ranking as is_account_member). One profile per login.
CREATE OR REPLACE FUNCTION public.my_account_ids(p_min_role public.account_role_enum)
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT coalesce(array_agg(p.account_id), '{}'::uuid[]) FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND array_position(ARRAY['viewer', 'agent', 'admin', 'owner']::public.account_role_enum[], p.account_role)
       >= array_position(ARRAY['viewer', 'agent', 'admin', 'owner']::public.account_role_enum[], p_min_role) $$;
ALTER FUNCTION public.my_account_ids(public.account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.my_account_ids(public.account_role_enum) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_account_ids(public.account_role_enum) TO anon, authenticated, service_role;

-- 3. who sets the owner ---------------------------------------------------------------------------------------------------
-- Trusted writers set kuanli.owner_write (transaction-local) and the reason in kuanli.owner_via. A member below admin
-- writing owner_profile_id or open_to_team any other way is refused; on their own insert the owner becomes them and the
-- lead is not open to the team.
CREATE OR REPLACE FUNCTION public.contact_owner_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF current_setting('role', true) IN ('authenticated', 'anon')
     AND coalesce(current_setting('kuanli.owner_write', true), '') <> 'on'
     AND NOT public.is_account_member(NEW.account_id, 'admin'::public.account_role_enum) THEN
    IF TG_OP = 'INSERT' THEN
      NEW.owner_profile_id := public.my_profile_id();
      NEW.open_to_team := false;
    ELSIF NEW.owner_profile_id IS DISTINCT FROM OLD.owner_profile_id THEN
      RAISE EXCEPTION 'a lead''s owner is set by assignment or an admin' USING ERRCODE = '42501';
    ELSIF NEW.open_to_team IS DISTINCT FROM OLD.open_to_team THEN
      RAISE EXCEPTION 'only an admin can open a lead to the team' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.owner_profile_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.profiles p WHERE p.id = NEW.owner_profile_id AND p.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'the owner must be a member of the lead''s account' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.contact_owner_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS contact_owner_guard ON public.contacts;
CREATE TRIGGER contact_owner_guard BEFORE INSERT OR UPDATE OF owner_profile_id, open_to_team ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contact_owner_guard();

CREATE OR REPLACE FUNCTION public.contact_owner_audit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.owner_profile_id IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.owner_profile_id IS DISTINCT FROM OLD.owner_profile_id) THEN
    INSERT INTO public.contact_owner_log (account_id, contact_id, old_owner, new_owner, changed_by, via)
    VALUES (NEW.account_id, NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.owner_profile_id END, NEW.owner_profile_id,
            auth.uid(), coalesce(nullif(current_setting('kuanli.owner_via', true), ''),
                                 CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'direct' END));
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.contact_owner_audit() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS contact_owner_audit ON public.contacts;
CREATE TRIGGER contact_owner_audit AFTER INSERT OR UPDATE OF owner_profile_id ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contact_owner_audit();

-- Internal: set a lead's owner as a trusted writer.
CREATE OR REPLACE FUNCTION public.set_owner_trusted(p_contact uuid, p_profile uuid, p_via text, p_only_if_unowned boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  PERFORM set_config('kuanli.owner_write', 'on', true);
  PERFORM set_config('kuanli.owner_via', p_via, true);
  UPDATE public.contacts SET owner_profile_id = p_profile
   WHERE id = p_contact AND owner_profile_id IS DISTINCT FROM p_profile
     AND (NOT p_only_if_unowned OR owner_profile_id IS NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('kuanli.owner_write', '', true);
  PERFORM set_config('kuanli.owner_via', '', true);
  RETURN n > 0;
END $$;
REVOKE ALL ON FUNCTION public.set_owner_trusted(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- A new counsellor for the lead (the bot's handover, a silent or unanswered pick): their login owns it. A repeat
-- assignment to the same counsellor (sticky) leaves the owner alone, so an admin's change sticks.
CREATE OR REPLACE FUNCTION public.contact_owner_from_assignment()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_profile uuid;
BEGIN
  SELECT c.profile_id INTO v_profile FROM public.counsellors c
    JOIN public.profiles p ON p.id = c.profile_id AND p.account_id = NEW.account_id   -- never abort the bot's handover
   WHERE c.id = NEW.counsellor_id;
  IF v_profile IS NULL OR EXISTS (SELECT 1 FROM public.counsellor_assignments a
                                   WHERE a.contact_id = NEW.contact_id AND a.counsellor_id = NEW.counsellor_id AND a.id <> NEW.id) THEN
    RETURN NULL;
  END IF;
  PERFORM public.set_owner_trusted(NEW.contact_id, v_profile, 'assignment:' || NEW.assigned_via, false);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.contact_owner_from_assignment() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS contact_owner_from_assignment ON public.counsellor_assignments;
CREATE TRIGGER contact_owner_from_assignment AFTER INSERT ON public.counsellor_assignments
  FOR EACH ROW EXECUTE FUNCTION public.contact_owner_from_assignment();

-- A chat assigned to someone: an admin's "Assign" in Kuanli moves the lead; the bot, the webhook and crons
-- (mark_counsellor_reached) only fill an empty owner. Clearing a chat's assignee never removes the owner.
CREATE OR REPLACE FUNCTION public.contact_owner_from_chat()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.contact_id IS NULL OR NEW.assigned_agent_id IS NULL OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id
     OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.assigned_agent_id AND p.account_id = NEW.account_id)
     -- a counsellor re-assigning their own chat does not hand the lead over (only admins move leads)
     OR (auth.uid() IS NOT NULL AND NOT public.is_account_member(NEW.account_id, 'admin'::public.account_role_enum)) THEN
    RETURN NULL;
  END IF;
  PERFORM public.set_owner_trusted(NEW.contact_id, NEW.assigned_agent_id,
            CASE WHEN auth.uid() IS NULL THEN 'chat:system' ELSE 'chat:assign' END, auth.uid() IS NULL);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.contact_owner_from_chat() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS contact_owner_from_chat ON public.conversations;
CREATE TRIGGER contact_owner_from_chat AFTER UPDATE OF assigned_agent_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.contact_owner_from_chat();

-- The Owner selector (admins and the owner). p_profile NULL = unowned (owner and admins only); p_branch NULL = keep.
-- The lead's chats on ordinary numbers move with it, so "My leads", the inbox and the 9:30 list agree.
CREATE OR REPLACE FUNCTION public.set_contact_owner(p_contact uuid, p_profile uuid, p_branch uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_acc uuid;
BEGIN
  SELECT account_id INTO v_acc FROM public.contacts WHERE id = p_contact;
  IF v_acc IS NULL OR auth.uid() IS NULL OR NOT public.is_account_member(v_acc, 'admin'::public.account_role_enum) THEN
    RAISE EXCEPTION 'only an admin can change a lead''s owner' USING ERRCODE = '42501';
  END IF;
  IF p_profile IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_profile AND account_id = v_acc) THEN
    RAISE EXCEPTION 'that person is not a member of this account' USING ERRCODE = '22023';
  END IF;
  IF p_branch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND account_id = v_acc) THEN
    RAISE EXCEPTION 'that branch is not in this account' USING ERRCODE = '22023';
  END IF;
  PERFORM public.set_owner_trusted(p_contact, p_profile, 'admin', false);
  IF p_branch IS NOT NULL THEN
    UPDATE public.contacts SET branch_id = p_branch WHERE id = p_contact AND branch_id IS DISTINCT FROM p_branch;
  END IF;
  IF p_profile IS NOT NULL THEN
    UPDATE public.conversations cv SET assigned_agent_id = p_profile, updated_at = now()
     WHERE cv.contact_id = p_contact AND cv.assigned_agent_id IS DISTINCT FROM p_profile
       AND NOT coalesce(cv.phone_number_id = ANY (public.counsellor_phone_number_ids()), false);
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.set_contact_owner(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_contact_owner(uuid, uuid, uuid) TO authenticated, service_role;

-- 4. RLS --------------------------------------------------------------------------------------------------------------------
-- = is_account_member(account_id[, 'agent']) AND (NOT counsellor_number_only OR can_see_counsellor_chats(account_id))
--   AND (own lead OR open to the team OR admin), with each helper evaluated once per statement. A future branch manager adds one OR here.
DROP POLICY IF EXISTS contacts_select ON public.contacts;
CREATE POLICY contacts_select ON public.contacts FOR SELECT USING (
  account_id = ANY ((SELECT public.my_account_ids('viewer'))::uuid[])
  AND (NOT counsellor_number_only OR account_id = ANY ((SELECT public.my_account_ids('admin'))::uuid[]))
  AND (owner_profile_id = (SELECT public.my_profile_id()) OR open_to_team OR account_id = ANY ((SELECT public.my_account_ids('admin'))::uuid[])));
DROP POLICY IF EXISTS contacts_update ON public.contacts;
CREATE POLICY contacts_update ON public.contacts FOR UPDATE USING (
  account_id = ANY ((SELECT public.my_account_ids('agent'))::uuid[])
  AND (NOT counsellor_number_only OR account_id = ANY ((SELECT public.my_account_ids('admin'))::uuid[]))
  AND (owner_profile_id = (SELECT public.my_profile_id()) OR open_to_team OR account_id = ANY ((SELECT public.my_account_ids('admin'))::uuid[])));
DROP POLICY IF EXISTS contacts_delete ON public.contacts;
CREATE POLICY contacts_delete ON public.contacts FOR DELETE USING (
  account_id = ANY ((SELECT public.my_account_ids('agent'))::uuid[])
  AND (NOT counsellor_number_only OR account_id = ANY ((SELECT public.my_account_ids('admin'))::uuid[]))
  AND (owner_profile_id = (SELECT public.my_profile_id()) OR open_to_team OR account_id = ANY ((SELECT public.my_account_ids('admin'))::uuid[])));

-- What hangs off a chat or a deal follows its lead; rows with no lead are for admins only.
DROP POLICY IF EXISTS own_leads_only ON public.conversations;
CREATE POLICY own_leads_only ON public.conversations AS RESTRICTIVE FOR ALL
  USING ((contact_id IS NULL AND account_id = ANY ((SELECT public.my_account_ids('admin'))::uuid[]))
         OR EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = conversations.contact_id))
  WITH CHECK ((contact_id IS NULL AND account_id = ANY ((SELECT public.my_account_ids('admin'))::uuid[]))
         OR EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = conversations.contact_id));
DROP POLICY IF EXISTS own_leads_only ON public.deals;
CREATE POLICY own_leads_only ON public.deals AS RESTRICTIVE FOR ALL
  USING (contact_id IS NOT NULL OR account_id = ANY ((SELECT public.my_account_ids('admin'))::uuid[]))
  WITH CHECK (contact_id IS NOT NULL OR account_id = ANY ((SELECT public.my_account_ids('admin'))::uuid[]));
DROP POLICY IF EXISTS own_leads_only ON public.meta_conversion_events;
CREATE POLICY own_leads_only ON public.meta_conversion_events AS RESTRICTIVE FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.conversations cv WHERE cv.id = meta_conversion_events.conversation_id));
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['flow_runs', 'automation_logs'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS own_leads_only ON public.%I', t);
    EXECUTE format($p$CREATE POLICY own_leads_only ON public.%1$I AS RESTRICTIVE FOR ALL
      USING ((contact_id IS NULL AND account_id = ANY ((SELECT public.my_account_ids('admin'))::uuid[]))
             OR EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = %1$I.contact_id))
      WITH CHECK ((contact_id IS NULL AND account_id = ANY ((SELECT public.my_account_ids('admin'))::uuid[]))
             OR EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = %1$I.contact_id))$p$, t);
  END LOOP;
END $$;

-- 4b. Automations and flows run with the service role on every lead of the account (a webhook step, a send, a field
-- update), so from R2 only admins write them; members still read them.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['automations', 'flows'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %1$s_insert ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_insert ON public.%1$I FOR INSERT WITH CHECK (public.is_account_member(account_id, ''admin''::public.account_role_enum))', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_update ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_update ON public.%1$I FOR UPDATE USING (public.is_account_member(account_id, ''admin''::public.account_role_enum))', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_delete ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_delete ON public.%1$I FOR DELETE USING (public.is_account_member(account_id, ''admin''::public.account_role_enum))', t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS automation_steps_modify ON public.automation_steps;
CREATE POLICY automation_steps_modify ON public.automation_steps FOR ALL
  USING (EXISTS (SELECT 1 FROM public.automations a WHERE a.id = automation_steps.automation_id AND public.is_account_member(a.account_id, 'admin'::public.account_role_enum)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.automations a WHERE a.id = automation_steps.automation_id AND public.is_account_member(a.account_id, 'admin'::public.account_role_enum)));
DROP POLICY IF EXISTS flow_nodes_modify ON public.flow_nodes;
CREATE POLICY flow_nodes_modify ON public.flow_nodes FOR ALL
  USING (EXISTS (SELECT 1 FROM public.flows f WHERE f.id = flow_nodes.flow_id AND public.is_account_member(f.account_id, 'admin'::public.account_role_enum)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.flows f WHERE f.id = flow_nodes.flow_id AND public.is_account_member(f.account_id, 'admin'::public.account_role_enum)));

-- 5. the SECURITY DEFINER readers (bodies copied from 093/094/095/096; signatures, grants and search_path unchanged) -----
CREATE OR REPLACE FUNCTION public.application_tracker(p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me uuid := public.my_profile_id();
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
    -- 098: below admin, only the caller's own leads
    AND (v_all_contacts OR ct.owner_profile_id = v_me OR ct.open_to_team)
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
  v_me uuid := public.my_profile_id();
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
    -- 098: below admin, only the caller's own leads
    AND (v_all_contacts OR ct.owner_profile_id = v_me OR ct.open_to_team)
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
  v_me uuid := public.my_profile_id();
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
    -- 098: below admin, only the caller's own leads
    AND (v_all_contacts OR ct.owner_profile_id = v_me OR ct.open_to_team)
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
  v_me uuid := public.my_profile_id();
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
    -- 098: below admin, only the caller's own leads
    AND (v_all_contacts OR ct.owner_profile_id = v_me OR ct.open_to_team)
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
  v_me uuid := public.my_profile_id();
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
    AND (v_all_contacts OR NOT ct.counsellor_number_only)
    -- 098: below admin, only the caller's own leads
    AND (v_all_contacts OR ct.owner_profile_id = v_me OR ct.open_to_team);

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
  v_owner uuid;
  v_open boolean;
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

  SELECT account_id, counsellor_number_only, owner_profile_id, open_to_team INTO v_account_id, v_hidden, v_owner, v_open FROM contacts WHERE id = p_contact_id;
  -- 094: a contact that arrived through a counsellor number is "not found" below admin, like a missing one.
  -- 098: so is a lead the caller does not own, below admin.
  IF v_account_id IS NULL OR (v_hidden AND NOT can_see_counsellor_chats(v_account_id))
     OR (NOT can_see_counsellor_chats(v_account_id) AND v_owner IS DISTINCT FROM public.my_profile_id() AND NOT v_open) THEN
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
  v_owner uuid;
  v_open boolean;
  v_account_id UUID;
  v_hidden boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, counsellor_number_only, owner_profile_id, open_to_team INTO v_account_id, v_hidden, v_owner, v_open FROM contacts WHERE id = p_contact_id;

  -- 094: a contact that arrived through a counsellor number is "not found" below admin, like a missing one.
  -- 098: so is a lead the caller does not own, below admin.
  IF v_account_id IS NULL OR (v_hidden AND NOT can_see_counsellor_chats(v_account_id))
     OR (NOT can_see_counsellor_chats(v_account_id) AND v_owner IS DISTINCT FROM public.my_profile_id() AND NOT v_open) THEN
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
  -- 098: nor about a lead the caller does not own.
  IF NOT can_see_counsellor_chats(p_account_id)
     AND (EXISTS (SELECT 1 FROM contacts WHERE id = p_contact_id AND counsellor_number_only)
          OR NOT EXISTS (SELECT 1 FROM contacts WHERE id = p_contact_id AND (owner_profile_id = public.my_profile_id() OR open_to_team))) THEN
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
  v_all_leads boolean := can_see_counsellor_chats(p_account_id);
  v_me uuid := public.my_profile_id();
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
  WHERE d.account_id = p_account_id
    -- 098: below admin, the caller's own leads and open ones, never a counsellor-number lead (094)
    AND (v_all_leads OR (NOT ct.counsellor_number_only AND (ct.owner_profile_id = v_me OR ct.open_to_team)));

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
          AND (v_all_leads OR EXISTS (SELECT 1 FROM contacts oc WHERE oc.id = c.contact_id AND NOT oc.counsellor_number_only AND (oc.owner_profile_id = v_me OR oc.open_to_team)))
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
  v_all_leads boolean := can_see_counsellor_chats(p_account_id);
  v_me uuid := public.my_profile_id();
  v_deals uuid[];
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

  -- 098: below admin, count the caller's own leads and open ones, never a counsellor-number lead (094)
  IF NOT v_all_leads THEN
    v_deals := ARRAY(SELECT d.id FROM deals d JOIN contacts ct ON ct.id = d.contact_id
                      WHERE d.pipeline_id = p_pipeline_id AND NOT ct.counsellor_number_only AND (ct.owner_profile_id = v_me OR ct.open_to_team));
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'position')::int), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'stage', ps.name,
      'position', ps.position,
      'color', ps.color,
      'current', (
        SELECT count(*) FROM deals d WHERE d.stage_id = ps.id AND (v_all_leads OR d.id = ANY (v_deals))
      ),
      'reached', CASE WHEN ps.name IN ('Lost', 'Not Interested') THEN NULL ELSE (
        SELECT count(DISTINCT x.deal_id) FROM (
          SELECT d.id AS deal_id FROM deals d
          JOIN pipeline_stages cur ON cur.id = d.stage_id
          WHERE d.pipeline_id = p_pipeline_id
            AND cur.name NOT IN ('Lost', 'Not Interested')
            AND cur.position >= ps.position
            AND (v_all_leads OR d.id = ANY (v_deals))
          UNION
          SELECT e.deal_id FROM deal_stage_events e
          JOIN pipeline_stages es ON es.id = e.to_stage_id
          WHERE es.pipeline_id = p_pipeline_id
            AND es.name NOT IN ('Lost', 'Not Interested')
            AND es.position >= ps.position
            AND (v_all_leads OR e.deal_id = ANY (v_deals))
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
            AND (v_all_leads OR e.deal_id = ANY (v_deals))
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
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- 098: DEFINER, so a counsellor's duplicate-UTR check still sees every payment in the account after own-leads RLS.
  -- Returns a count only, and nothing to anyone below agent in that account.
  SELECT CASE WHEN p_reference IS NULL OR btrim(p_reference) = ''
                   OR NOT public.is_account_member(p_account_id, 'agent'::public.account_role_enum) THEN 0 ELSE
    (SELECT count(*)::int FROM public.payments p
      WHERE p.account_id = p_account_id AND p.status::text NOT IN ('rejected', 'reversed')
        AND lower(btrim(p.reference)) = lower(btrim(p_reference))) END $function$;

-- 6. storage ---------------------------------------------------------------------------------------------------------------
-- A stored document or receipt is readable through the API only with a visible row for it (the subqueries run under
-- RLS, so they follow ownership), or by the person who uploaded it (a receipt is uploaded before its row exists, and an
-- upload reads its own object back). Signed links the server makes with the service role are unchanged. Folder names
-- are compared as text: a file outside an account folder (prod has brochure/ files in chat-media) must not make the
-- policy error for everyone.
CREATE INDEX IF NOT EXISTS application_documents_storage_path ON public.application_documents (storage_path);
-- unique: one receipt row per stored file, so a member cannot add a receipt row naming somebody else's file to read it
CREATE UNIQUE INDEX IF NOT EXISTS payment_receipts_storage_path ON public.payment_receipts (storage_path);

DROP POLICY IF EXISTS "Members read application docs" ON storage.objects;
CREATE POLICY "Members read application docs" ON storage.objects FOR SELECT USING (
  bucket_id = 'application-docs'
  AND EXISTS (SELECT 1 FROM unnest((SELECT public.my_account_ids('viewer'))) a WHERE split_part(name, '/', 1) = 'account-' || a::text)
  AND (owner_id = (auth.uid())::text
       OR EXISTS (SELECT 1 FROM public.application_documents d WHERE d.storage_path = objects.name)));

DROP POLICY IF EXISTS "Members read payment receipts storage" ON storage.objects;
CREATE POLICY "Members read payment receipts storage" ON storage.objects FOR SELECT USING (
  bucket_id = 'payment-receipts'
  AND EXISTS (SELECT 1 FROM unnest((SELECT public.my_account_ids('viewer'))) a WHERE split_part(name, '/', 1) = 'account-' || a::text)
  AND (owner_id = (auth.uid())::text
       OR EXISTS (SELECT 1 FROM public.payment_receipts r WHERE r.storage_path = objects.name)));

-- chat-media stays a public bucket (Meta fetches outbound media by public URL; the inbox shows mirrors by public URL),
-- and public URLs do not go through these policies. What changes is listing through the API: before, anyone with the
-- public key could list every object (inbound student IDs and marksheets among them). Now only the account's admins
-- can, and a member sees what they uploaded themselves.
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Chat media readable by uploader and admins" ON storage.objects;
CREATE POLICY "Chat media readable by uploader and admins" ON storage.objects FOR SELECT USING (
  bucket_id = 'chat-media'
  AND (owner_id = (auth.uid())::text
       OR EXISTS (SELECT 1 FROM unnest((SELECT public.my_account_ids('admin'))) a WHERE split_part(name, '/', 1) = 'account-' || a::text)));

-- 7. Option 1: Kuanli's Add member creates or links the rotation entry -----------------------------------------------------
-- New number: a counsellor row, inactive, with a Telegram join code returned once. A number the R1 staff script seeded
-- with no login yet: link that row (same id; its branch, Telegram join and active state kept) and give the login the
-- row's unowned leads. A linked row or a retry returns the join code only while that counsellor has not joined Telegram. Refused: a number already on another login, a row in another branch, a login already linked.
CREATE OR REPLACE FUNCTION public.add_counsellor(p_profile uuid, p_branch uuid, p_wa_number text, p_display_name text)
RETURNS TABLE (counsellor_id uuid, telegram_start_code text, linked boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_acc uuid; v_num text := regexp_replace(coalesce(p_wa_number, ''), '[^0-9]', '', 'g');
  v_name text := btrim(coalesce(p_display_name, '')); v_row public.counsellors%ROWTYPE; v_code text; c record;
BEGIN
  SELECT account_id INTO v_acc FROM public.profiles WHERE id = p_profile;
  IF v_acc IS NULL OR auth.uid() IS NULL OR NOT public.is_account_member(v_acc, 'admin'::public.account_role_enum) THEN
    RAISE EXCEPTION 'only an admin can add a counsellor' USING ERRCODE = '42501';
  END IF;
  IF (SELECT account_role FROM public.profiles WHERE id = p_profile) = 'viewer' THEN
    RAISE EXCEPTION 'a viewer cannot take leads: make them a counsellor first' USING ERRCODE = '22023';
  END IF;
  IF length(v_num) = 10 THEN v_num := '91' || v_num; END IF;
  IF v_num !~ '^91[6-9][0-9]{9}$' THEN
    RAISE EXCEPTION 'enter the counsellor''s 10-digit Indian WhatsApp number' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND account_id = v_acc AND active) THEN
    RAISE EXCEPTION 'pick a branch of this account' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('add_counsellor:' || v_acc::text));

  SELECT * INTO v_row FROM public.counsellors WHERE account_id = v_acc AND wa_number = v_num FOR UPDATE;
  IF FOUND THEN
    IF v_row.profile_id = p_profile THEN   -- a retry: the join code again while they have not joined Telegram
      RETURN QUERY SELECT v_row.id, CASE WHEN v_row.telegram_chat_id IS NULL THEN v_row.telegram_start_code END, true; RETURN;
    ELSIF v_row.profile_id IS NOT NULL THEN
      RAISE EXCEPTION 'that WhatsApp number is already on another login' USING ERRCODE = '23505';
    ELSIF v_row.branch_id <> p_branch THEN
      RAISE EXCEPTION 'that WhatsApp number is already a counsellor in another branch' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.counsellors WHERE profile_id = p_profile AND id IS DISTINCT FROM v_row.id) THEN
    RAISE EXCEPTION 'this login is already linked to a counsellor' USING ERRCODE = '23505';
  END IF;

  IF v_row.id IS NOT NULL THEN
    UPDATE public.counsellors SET profile_id = p_profile WHERE id = v_row.id;
    -- the leads whose latest assignment is this counsellor and that nobody owns yet
    FOR c IN SELECT DISTINCT ON (a.contact_id) a.contact_id AS lead, a.counsellor_id AS latest FROM public.counsellor_assignments a
              WHERE a.account_id = v_acc
                AND a.contact_id IN (SELECT x.contact_id FROM public.counsellor_assignments x WHERE x.counsellor_id = v_row.id)
              ORDER BY a.contact_id, a.assigned_at DESC LOOP
      IF c.latest = v_row.id THEN
        PERFORM public.set_owner_trusted(c.lead, p_profile, 'counsellor_linked', true);
      END IF;
    END LOOP;
    RETURN QUERY SELECT v_row.id, CASE WHEN v_row.telegram_chat_id IS NULL THEN v_row.telegram_start_code END, true; RETURN;
  END IF;

  IF length(v_name) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'the name must be 1 to 40 characters' USING ERRCODE = '22023';
  END IF;
  v_code := encode(extensions.gen_random_bytes(6), 'hex');
  INSERT INTO public.counsellors (account_id, profile_id, display_name, wa_number, telegram_start_code, active, branch_id)
  VALUES (v_acc, p_profile, v_name, v_num, v_code, false, p_branch)
  RETURNING id INTO v_row.id;
  RETURN QUERY SELECT v_row.id, v_code, false;
END $$;
REVOKE ALL ON FUNCTION public.add_counsellor(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_counsellor(uuid, uuid, text, text) TO authenticated, service_role;

-- Rotation on/off from the Members list. On needs the Telegram join (handover alerts go there).
CREATE OR REPLACE FUNCTION public.set_counsellor_active(p_counsellor uuid, p_on boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_row public.counsellors%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.counsellors WHERE id = p_counsellor;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_account_member(v_row.account_id, 'admin'::public.account_role_enum) THEN
    RAISE EXCEPTION 'only an admin can change the rotation' USING ERRCODE = '42501';
  END IF;
  IF coalesce(p_on, false) AND v_row.telegram_chat_id IS NULL THEN
    RAISE EXCEPTION 'this counsellor has not joined Telegram yet' USING ERRCODE = '22023';
  END IF;
  UPDATE public.counsellors SET active = coalesce(p_on, false) WHERE id = p_counsellor AND active IS DISTINCT FROM coalesce(p_on, false);
END $$;
REVOKE ALL ON FUNCTION public.set_counsellor_active(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_counsellor_active(uuid, boolean) TO authenticated, service_role;

-- 8. self-check: every re-created reader carries the own-lead filter (a later re-run of 096 would silently drop it) ------
DO $$
DECLARE f text; v_missing text[] := '{}';
BEGIN
  FOREACH f IN ARRAY ARRAY['lead_queue', 'application_tracker', 'follow_up_worklist', 'follow_up_timeline',
                           'follow_up_overdue_count', 'payment_ledger', 'funnel_analytics', 'pipeline_funnel',
                           'update_contact_enrollment', 'apply_fee_template'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f
                     AND pg_get_functiondef(p.oid) ~ 'open_to_team') THEN
      v_missing := v_missing || f;
    END IF;
  END LOOP;
  IF cardinality(v_missing) > 0 THEN RAISE EXCEPTION '098 self-check: no own-lead filter in %', v_missing; END IF;
END $$;
