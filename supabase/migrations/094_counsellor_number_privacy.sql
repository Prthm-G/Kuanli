-- 094_counsellor_number_privacy.sql  (KB-COEXIST-20261109)
-- Counsellor numbers on coexistence: the counsellors' own WhatsApp Business numbers come into Kuanli (their app chats,
-- app echoes and up to 180 days of history), and those chats are for the owner and admins only. Never for counsellors,
-- not even on their own number. Builds on 093.
--
-- A counsellor number is any counsellors.phone_number_id, now or ever (counsellor_number_history, written by a trigger
-- on counsellors), so linking a number in counsellors is what makes its chats private, and unlinking it later does
-- not make them public.
--
-- 1. counsellor_phone_number_ids(): the list, for policies and functions. SECURITY DEFINER because counsellors is
--    admin-only under RLS. Anon (the public API key) gets an empty list: it sees no chat anyway, and the policies must
--    not raise for it.
-- 2. RLS: conversations, messages and message_reactions on a counsellor number need can_see_counsellor_chats(account)
--    (admin or owner; one helper, so owner-only is a one-line change) to read or write. Everything else is as before. Realtime applies the same policies.
-- 3. SECURITY DEFINER and service functions leave those chats out where they hand chats or chat facts to counsellors:
--    my_assigned_conversation_ids (My leads), counsellor_held_leads (so the working set, the 9:30 list and the stale
--    alert), lead_queue (Work Queue: the chat it opens and the message counts, for non-admins), application_tracker
--    (the chat it opens, for non-admins), follow_ups_due (the bot's follow-up ladder never picks such a chat),
--    create_chat_link (no Telegram chat link for such a chat), capture_application_document (a file sent there is not
--    put on the applications page, where every member can open it).
-- 4. lifecycle_sweep creates no deal for a contact whose only chats are on counsellor numbers (history sync brings
--    every 1:1 chat of the last 180 days, personal ones too), and a new deal never points at such a chat. Messages
--    there still count as signals for a lead that has a deal (a reply to the counsellor is a reply).
-- 5. A delete that cascades into those chats (deleting the contact: contacts_delete lets agents, and FK cascades do
--    not check RLS) is refused below admin, by a trigger on conversations (row triggers fire on cascades too).
-- 6. claim_webhook_inbox also prunes rows that failed 5 times, after 7 days: a failed history chunk holds raw chats.
-- 7. Contacts that ARRIVED through a counsellor number (history brings every 1:1 chat, personal ones too) are for admins
--    and the owner only. contacts.counsellor_number_only is set only when the webhook creates a brand-new contact for
--    a counsellor-number chat; a contact found by phone (a lead, an imported student) is never flagged. The flag
--    clears, and the contact gets its LD number, on the first sign it is a lead: a chat on another number, a deal, a
--    fee plan or payment, a university set, or an admin clearing it. Hidden below admin: contacts, the tables that
--    hang off a contact (restrictive policies), the Work Queue, applications, follow-up lists and badge, fee ledger,
--    enrolment and fee-template RPCs, growth counts.
-- 8. A partial index for the media proxy's "is this media on a message I can see" lookup.
-- 9. whatsapp_config.history_scope. 10. update_contact_enrollment and apply_fee_template check that visibility.
-- 11. growth_live leaves counsellor-number chats and flagged contacts out of its counts. merge_duplicate_contacts and
--     refresh_conversation_summary are closed to the API roles (section 7). Only the webhook and psql make a flagged
--     contact; a chat must point at a contact the caller can see.
-- 12. A logged-in member cannot write a media-proxy link into a message (only the webhook does), nor point a deal or a
--     follow-up at a chat they cannot see.
-- No message, no n8n change, no ad event. Rollback: 094_rollback.sql.

SET LOCAL lock_timeout = '5s';

-- 1. the list ------------------------------------------------------------------------------------------------------------
-- Every number ever linked, so a chat on a number stays private after the number is unlinked (phone_number_id cleared or
-- changed, or the counsellor deleted). Otherwise its chats would count as "another number": the sweep would make deals
-- for them and clear every flag. Written only by the trigger below; read through counsellor_phone_number_ids() and by
-- the webhook (service role). A number linked by mistake is released by the owner in psql, deleting its row here
-- (docs/kuanli-coexistence-403-406.md).
CREATE TABLE IF NOT EXISTS public.counsellor_number_history (
  phone_number_id text PRIMARY KEY,
  first_linked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.counsellor_number_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.counsellor_number_history FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.counsellor_number_history TO service_role;
INSERT INTO public.counsellor_number_history (phone_number_id)
  SELECT DISTINCT phone_number_id FROM public.counsellors WHERE phone_number_id IS NOT NULL
  ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.record_counsellor_number()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.phone_number_id IS NOT NULL THEN
    INSERT INTO counsellor_number_history (phone_number_id) VALUES (NEW.phone_number_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_counsellor_number() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS record_counsellor_number ON public.counsellors;
CREATE TRIGGER record_counsellor_number
  AFTER INSERT OR UPDATE OF phone_number_id ON public.counsellors
  FOR EACH ROW EXECUTE FUNCTION public.record_counsellor_number();

CREATE OR REPLACE FUNCTION public.counsellor_phone_number_ids()
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- 'role' is the role the request runs as (PostgREST and Realtime SET ROLE), which SECURITY DEFINER does not change.
  SELECT CASE WHEN current_setting('role', true) = 'anon' THEN '{}'::text[] ELSE
    (SELECT coalesce(array_agg(DISTINCT n.pn ORDER BY n.pn), '{}'::text[])
       FROM (SELECT h.phone_number_id FROM counsellor_number_history h
             UNION SELECT c.phone_number_id FROM counsellors c WHERE c.phone_number_id IS NOT NULL) n(pn)) END
$$;
REVOKE ALL ON FUNCTION public.counsellor_phone_number_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.counsellor_phone_number_ids() TO anon, authenticated, service_role;

-- Who may see chats on counsellor numbers: the one place to change it. 'admin' includes the owner (017's ladder); 'owner'
-- would make them owner-only. Every 094 policy, function and trigger asks this. Plain SQL with no SET, so the planner
-- can inline it into the policies.
CREATE OR REPLACE FUNCTION public.can_see_counsellor_chats(p_account_id uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT public.is_account_member(p_account_id, 'admin'::public.account_role_enum)
$$;
REVOKE ALL ON FUNCTION public.can_see_counsellor_chats(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_see_counsellor_chats(uuid) TO anon, authenticated, service_role;

-- The flag (7). A NOT NULL column with a constant default is a catalogue change only.
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS counsellor_number_only boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS contacts_counsellor_number_only ON public.contacts (account_id) WHERE counsellor_number_only;

-- 2. RLS -------------------------------------------------------------------------------------------------------------------
-- (SELECT ...) makes the list an InitPlan: read once per statement, not once per row.
DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations FOR SELECT USING (
  public.is_account_member(account_id)
  AND (NOT coalesce(phone_number_id = ANY ((SELECT public.counsellor_phone_number_ids())::text[]), false)
       OR public.can_see_counsellor_chats(account_id)));

DROP POLICY IF EXISTS conversations_insert ON public.conversations;
-- A new or changed chat must also point at a contact the caller can see (contacts_select, section 7): a bot-number chat
-- on a hidden contact would clear its flag (assign_lead_number_on_other_chat) and show it to everyone.
CREATE POLICY conversations_insert ON public.conversations FOR INSERT WITH CHECK (
  public.is_account_member(account_id, 'agent'::public.account_role_enum)
  AND (NOT coalesce(phone_number_id = ANY ((SELECT public.counsellor_phone_number_ids())::text[]), false)
       OR public.can_see_counsellor_chats(account_id))
  AND (contact_id IS NULL OR EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = conversations.contact_id)));

-- WITH CHECK repeats the number rule (a chat cannot be moved onto a counsellor number) and adds the contact rule.
DROP POLICY IF EXISTS conversations_update ON public.conversations;
CREATE POLICY conversations_update ON public.conversations FOR UPDATE USING (
  public.is_account_member(account_id, 'agent'::public.account_role_enum)
  AND (NOT coalesce(phone_number_id = ANY ((SELECT public.counsellor_phone_number_ids())::text[]), false)
       OR public.can_see_counsellor_chats(account_id)))
WITH CHECK (
  public.is_account_member(account_id, 'agent'::public.account_role_enum)
  AND (NOT coalesce(phone_number_id = ANY ((SELECT public.counsellor_phone_number_ids())::text[]), false)
       OR public.can_see_counsellor_chats(account_id))
  AND (contact_id IS NULL OR EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = conversations.contact_id)));

DROP POLICY IF EXISTS conversations_delete ON public.conversations;
CREATE POLICY conversations_delete ON public.conversations FOR DELETE USING (
  public.is_account_member(account_id, 'agent'::public.account_role_enum)
  AND (NOT coalesce(phone_number_id = ANY ((SELECT public.counsellor_phone_number_ids())::text[]), false)
       OR public.can_see_counsellor_chats(account_id)));

DROP POLICY IF EXISTS messages_select ON public.messages;
CREATE POLICY messages_select ON public.messages FOR SELECT USING ((EXISTS (
  SELECT 1 FROM public.conversations c
   WHERE c.id = messages.conversation_id AND public.is_account_member(c.account_id)
     AND (NOT coalesce(c.phone_number_id = ANY ((SELECT public.counsellor_phone_number_ids())::text[]), false)
          OR public.can_see_counsellor_chats(c.account_id)))));

DROP POLICY IF EXISTS messages_modify ON public.messages;
CREATE POLICY messages_modify ON public.messages USING ((EXISTS (
  SELECT 1 FROM public.conversations c
   WHERE c.id = messages.conversation_id AND public.is_account_member(c.account_id, 'agent'::public.account_role_enum)
     AND (NOT coalesce(c.phone_number_id = ANY ((SELECT public.counsellor_phone_number_ids())::text[]), false)
          OR public.can_see_counsellor_chats(c.account_id)))))
WITH CHECK ((EXISTS (
  SELECT 1 FROM public.conversations c
   WHERE c.id = messages.conversation_id AND public.is_account_member(c.account_id, 'agent'::public.account_role_enum)
     AND (NOT coalesce(c.phone_number_id = ANY ((SELECT public.counsellor_phone_number_ids())::text[]), false)
          OR public.can_see_counsellor_chats(c.account_id)))));

DROP POLICY IF EXISTS message_reactions_select ON public.message_reactions;
CREATE POLICY message_reactions_select ON public.message_reactions FOR SELECT USING ((EXISTS (
  SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
   WHERE m.id = message_reactions.message_id AND public.is_account_member(c.account_id)
     AND (NOT coalesce(c.phone_number_id = ANY ((SELECT public.counsellor_phone_number_ids())::text[]), false)
          OR public.can_see_counsellor_chats(c.account_id)))));

DROP POLICY IF EXISTS message_reactions_modify ON public.message_reactions;
CREATE POLICY message_reactions_modify ON public.message_reactions USING ((EXISTS (
  SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
   WHERE m.id = message_reactions.message_id AND public.is_account_member(c.account_id, 'agent'::public.account_role_enum)
     AND (NOT coalesce(c.phone_number_id = ANY ((SELECT public.counsellor_phone_number_ids())::text[]), false)
          OR public.can_see_counsellor_chats(c.account_id)))))
WITH CHECK ((EXISTS (
  SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
   WHERE m.id = message_reactions.message_id AND public.is_account_member(c.account_id, 'agent'::public.account_role_enum)
     AND (NOT coalesce(c.phone_number_id = ANY ((SELECT public.counsellor_phone_number_ids())::text[]), false)
          OR public.can_see_counsellor_chats(c.account_id)))));

-- 3. lists and lookups -----------------------------------------------------------------------------------------------------
-- 093's, with chats on counsellor numbers left out of both parts. Feeds the working set, the 9:30 list, the stale alert
-- and My leads, which all go to counsellors.
CREATE OR REPLACE FUNCTION public.counsellor_held_leads(p_account_id uuid)
RETURNS TABLE (counsellor_id uuid, conversation_id uuid, contact_id uuid, source text, assigned_at timestamptz)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
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
     WHERE (cv.assigned_agent_id IS NULL OR cv.assigned_agent_id = c.profile_id)
       -- 094: never a chat on a counsellor number.
       AND NOT coalesce(cv.phone_number_id = ANY ((SELECT counsellor_phone_number_ids())::text[]), false)
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
             -- 094: mark_counsellor_reached gives the counsellor the chat on their own number; it stays out.
             AND NOT coalesce(cv.phone_number_id = ANY ((SELECT counsellor_phone_number_ids())::text[]), false)
           ORDER BY c.id, cv.contact_id, cv.last_message_at DESC NULLS LAST) o
   WHERE NOT EXISTS (SELECT 1 FROM held h WHERE h.counsellor_id = o.counsellor_id AND h.contact_id = o.contact_id)
$$;
REVOKE ALL ON FUNCTION public.counsellor_held_leads(uuid) FROM PUBLIC, anon, authenticated;

-- 093's, with a chat the caller may not open left out (counsellor numbers, for anyone below admin).
CREATE OR REPLACE FUNCTION public.my_assigned_conversation_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
     AND (NOT coalesce(cv.phone_number_id = ANY (counsellor_phone_number_ids()), false)
          OR can_see_counsellor_chats(cv.account_id))
     AND NOT EXISTS (SELECT 1 FROM (SELECT d.stage_id FROM deals d WHERE d.contact_id = cv.contact_id
                                     ORDER BY d.created_at DESC NULLS LAST LIMIT 1) ld
                       JOIN pipeline_stages s ON s.id = ld.stage_id
                      WHERE s.name IN ('Lost', 'Not Interested'))
$$;

-- 093's. Below admin, the chat it opens and the message counts come from chats that person can open; an admin sees the
-- lead's chats on every number, as in the inbox.
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

-- As live, with the chat it opens taken from chats the caller can open (counsellor numbers only for admins).
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
        AND NOT coalesce(c.phone_number_id = ANY (v_hidden), false)
      ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1
    ) conv ON true
    WHERE d.account_id = p_account_id
      AND (v_all_contacts OR NOT ct.counsellor_number_only)
  ) rows;

  RETURN v_result;
END;
$function$;

-- As live: an image or document from the student on a counsellor number stays in that chat only.
CREATE OR REPLACE FUNCTION public.capture_application_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contact_id uuid;
  v_account_id uuid;
  v_phone_number_id text;
BEGIN
  IF NEW.sender_type <> 'customer'
     OR NEW.content_type NOT IN ('image', 'document') THEN
    RETURN NEW;
  END IF;

  SELECT c.contact_id, c.account_id, c.phone_number_id INTO v_contact_id, v_account_id, v_phone_number_id
  FROM conversations c WHERE c.id = NEW.conversation_id;

  IF v_contact_id IS NULL THEN RETURN NEW; END IF;
  -- 094
  IF coalesce(v_phone_number_id = ANY (counsellor_phone_number_ids()), false) THEN RETURN NEW; END IF;

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
$function$;

-- As live: no Telegram chat link (read with the service role, no login) for a chat on a counsellor number.
CREATE OR REPLACE FUNCTION public.create_chat_link(p_conversation uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE t text;
BEGIN
  IF p_conversation IS NULL OR NOT EXISTS (
       SELECT 1 FROM conversations WHERE id = p_conversation
          AND NOT coalesce(phone_number_id = ANY (public.counsellor_phone_number_ids()), false)) THEN
    RETURN NULL;
  END IF;
  SELECT token INTO t FROM chat_links
   WHERE conversation_id = p_conversation AND expires_at > now() + interval '1 day'
   ORDER BY expires_at DESC LIMIT 1;
  IF t IS NOT NULL THEN RETURN t; END IF;
  t := translate(encode(gen_random_bytes(18), 'base64'), '+/', '-_');
  INSERT INTO chat_links (token, conversation_id) VALUES (t, p_conversation);
  DELETE FROM chat_links WHERE expires_at < now() - interval '30 days';
  RETURN t;
END $function$;

-- As live: the bot's follow-up ladder answers on the lead's chat with the bot, never on a counsellor number. A reply to
-- the counsellor still counts as the student writing (last_customer_at).
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
      AND NOT coalesce(c.phone_number_id = ANY ((SELECT counsellor_phone_number_ids())::text[]), false)
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
$function$;

-- 4. the sweep (093's, with Step 1 changed) --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lifecycle_sweep(p_account_id uuid, p_lost_after_days integer DEFAULT 14)
 RETURNS TABLE(deal_id uuid, contact_id uuid, from_stage text, to_stage text)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_intake_id uuid;
  v_app_started_pos integer;
  -- 094
  v_counsellor text[] := counsellor_phone_number_ids();
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
  -- in its target pipeline. 094: a conversation off the counsellor numbers,
  -- and not a contact that arrived through one; the deal never points at a
  -- chat on one.
  RETURN QUERY
  WITH ins AS (
    INSERT INTO deals (account_id, user_id, pipeline_id, contact_id,
                       conversation_id, title, stage_id, currency, value, notes)
    SELECT s.account_id, s.user_id, s.target_pipeline_id, s.cid,
           (SELECT cv.id FROM conversations cv WHERE cv.contact_id = s.cid
              AND NOT coalesce(cv.phone_number_id = ANY (v_counsellor), false)
             ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1),
           'Lead - ' || s.phone,
           (SELECT id FROM pipeline_stages
             WHERE pipeline_id = s.target_pipeline_id AND name = 'New Lead'),
           'INR', 0, 'Source: organic'
    FROM _lifecycle_signals s
    WHERE NOT EXISTS (SELECT 1 FROM deals d
                       WHERE d.contact_id = s.cid AND d.account_id = p_account_id)
      AND EXISTS (SELECT 1 FROM conversations cv WHERE cv.contact_id = s.cid
                   AND NOT coalesce(cv.phone_number_id = ANY (v_counsellor), false))
      -- A flagged contact clears when a real lead signal arrives (a bot-number chat from the webhook, a deal, a plan).
      AND NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = s.cid AND ct.counsellor_number_only)
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
$function$;

-- 5. no cascade delete of a counsellor-number chat below admin ---------------------------------------------------------------
-- A logged-in member's DELETE (PostgREST and Realtime run as 'authenticated'). The service role, the owner's psql and
-- an admin are not stopped. P0094 is the code the Contacts page shows a clear message for.
CREATE OR REPLACE FUNCTION public.guard_counsellor_chat_delete()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF current_setting('role', true) = 'authenticated'
     AND coalesce(OLD.phone_number_id = ANY (counsellor_phone_number_ids()), false)
     AND NOT can_see_counsellor_chats(OLD.account_id) THEN
    RAISE EXCEPTION 'This contact has chats on a counsellor''s own number. Only an admin or the owner can delete it.'
      USING ERRCODE = 'P0094';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.guard_counsellor_chat_delete() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS guard_counsellor_chat_delete ON public.conversations;
CREATE TRIGGER guard_counsellor_chat_delete
  BEFORE DELETE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.guard_counsellor_chat_delete();

-- 6. the webhook inbox (084's, with the prune widened) ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_webhook_inbox(p_limit integer DEFAULT 20, p_min_age_seconds integer DEFAULT 120)
 RETURNS TABLE(id bigint, body jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  -- 094: a row that failed its 5 attempts is never claimed again; drop it after 7 days like a processed one.
  DELETE FROM public.webhook_inbox w
   WHERE w.processed_at < now() - interval '7 days'
      OR (w.processed_at IS NULL AND w.attempts >= 5 AND w.received_at < now() - interval '7 days');
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

-- 7. contacts that arrived through a counsellor number --------------------------------------------------------------------
-- Insert stays as it is (anyone may add a contact; it is never flagged then).
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

-- What hangs off a contact: one restrictive policy per table, ANDed with the existing ones, for every command. The row
-- needs a contact the caller can see: the subquery runs under contacts_select, so it names no hidden id to anyone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['deals', 'payments', 'fee_discounts', 'student_fee_plans', 'contact_notes', 'follow_up_entries',
                           'follow_up_log', 'contact_tags', 'contact_custom_values', 'application_documents',
                           'broadcast_recipients', 'counsellor_assignments'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS hide_counsellor_number_contacts ON public.%I', t);
    EXECUTE format($p$CREATE POLICY hide_counsellor_number_contacts ON public.%1$I AS RESTRICTIVE FOR ALL
      USING (contact_id IS NULL OR EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = %1$I.contact_id))
      WITH CHECK (contact_id IS NULL OR EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = %1$I.contact_id))$p$, t);
  END LOOP;
END $$;
-- Rows that hang off a plan, a payment or a deal follow their parent's policies.
DROP POLICY IF EXISTS hide_counsellor_number_contacts ON public.student_fee_installments;
CREATE POLICY hide_counsellor_number_contacts ON public.student_fee_installments AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM public.student_fee_plans p WHERE p.id = student_fee_installments.plan_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.student_fee_plans p WHERE p.id = student_fee_installments.plan_id));
DROP POLICY IF EXISTS hide_counsellor_number_contacts ON public.payment_receipts;
CREATE POLICY hide_counsellor_number_contacts ON public.payment_receipts AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM public.payments p WHERE p.id = payment_receipts.payment_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.payments p WHERE p.id = payment_receipts.payment_id));
DROP POLICY IF EXISTS hide_counsellor_number_contacts ON public.payment_hops;
CREATE POLICY hide_counsellor_number_contacts ON public.payment_hops AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM public.payments p WHERE p.id = payment_hops.payment_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.payments p WHERE p.id = payment_hops.payment_id));
DROP POLICY IF EXISTS hide_counsellor_number_contacts ON public.deal_stage_events;
CREATE POLICY hide_counsellor_number_contacts ON public.deal_stage_events AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM public.deals d WHERE d.id = deal_stage_events.deal_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.deals d WHERE d.id = deal_stage_events.deal_id));

-- merge_duplicate_contacts (SECURITY DEFINER, no auth check) merges across the whole database: not for the API roles.
REVOKE ALL ON FUNCTION public.merge_duplicate_contacts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_contacts() TO service_role;
-- refresh_conversation_summary (SECURITY DEFINER, no auth check) rewrites any chat's summary; only 028's message
-- trigger calls it, and no app code. Not for the API roles.
REVOKE ALL ON FUNCTION public.refresh_conversation_summary(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_conversation_summary(uuid) TO service_role;

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

-- No LD lead number for a contact that arrived through a counsellor number. As live otherwise.
CREATE OR REPLACE FUNCTION public.generate_temp_lead_id()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.roll_number IS NULL AND NOT coalesce(NEW.counsellor_number_only, false) THEN
        NEW.roll_number := 'LD-' || TO_CHAR(NOW(), 'YYMM') || '-' || LPAD(nextval('temp_lead_seq')::text, 4, '0');
    END IF;
    RETURN NEW;
END;
$function$;

-- The webhook's insert for a brand-new contact first seen on a counsellor number (live, echo or history), flagged.
-- A contact found by phone is never passed here. Service role only.
CREATE OR REPLACE FUNCTION public.create_counsellor_number_contact(p_account_id uuid, p_user_id uuid, p_phone text, p_name text,
                                                                   p_source text DEFAULT 'organic')
RETURNS SETOF public.contacts
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO contacts (account_id, user_id, phone, name, source, counsellor_number_only)
  VALUES (p_account_id, p_user_id, p_phone, coalesce(nullif(p_name, ''), p_phone), coalesce(p_source, 'organic'), true)
  RETURNING *
$$;
REVOKE ALL ON FUNCTION public.create_counsellor_number_contact(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_counsellor_number_contact(uuid, uuid, text, text, text) TO service_role;

-- A flagged contact that turns out to be a lead: visible to everyone from now on, with an LD number. Never re-flagged.
CREATE OR REPLACE FUNCTION public.clear_counsellor_number_only(p_contact_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE contacts SET counsellor_number_only = false,
         roll_number = coalesce(roll_number, 'LD-' || TO_CHAR(NOW(), 'YYMM') || '-' || LPAD(nextval('temp_lead_seq')::text, 4, '0'))
   WHERE id = p_contact_id AND counsellor_number_only
$$;
REVOKE ALL ON FUNCTION public.clear_counsellor_number_only(uuid) FROM PUBLIC, anon, authenticated;

-- It clears on: a chat on any other number (conversations), a deal, a fee plan or a payment. A university set and an
-- admin clearing it: the contacts trigger below.
CREATE OR REPLACE FUNCTION public.assign_lead_number_on_other_chat()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'conversations' THEN
    -- A chat on a counsellor number says nothing; on any other number it is a lead.
    IF NOT coalesce(NEW.phone_number_id = ANY (counsellor_phone_number_ids()), false) THEN
      PERFORM clear_counsellor_number_only(NEW.contact_id);
    END IF;
  ELSE
    PERFORM clear_counsellor_number_only(NEW.contact_id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.assign_lead_number_on_other_chat() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS assign_lead_number_on_other_chat ON public.conversations;
CREATE TRIGGER assign_lead_number_on_other_chat
  AFTER INSERT OR UPDATE OF phone_number_id, contact_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.assign_lead_number_on_other_chat();
DROP TRIGGER IF EXISTS assign_lead_number_on_other_chat ON public.deals;
CREATE TRIGGER assign_lead_number_on_other_chat
  AFTER INSERT OR UPDATE OF contact_id ON public.deals
  FOR EACH ROW WHEN (NEW.contact_id IS NOT NULL) EXECUTE FUNCTION public.assign_lead_number_on_other_chat();
DROP TRIGGER IF EXISTS assign_lead_number_on_other_chat ON public.student_fee_plans;
CREATE TRIGGER assign_lead_number_on_other_chat
  AFTER INSERT ON public.student_fee_plans
  FOR EACH ROW EXECUTE FUNCTION public.assign_lead_number_on_other_chat();
DROP TRIGGER IF EXISTS assign_lead_number_on_other_chat ON public.payments;
CREATE TRIGGER assign_lead_number_on_other_chat
  AFTER INSERT ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.assign_lead_number_on_other_chat();

-- On contacts: the flag is never set again once cleared; below admin a logged-in member cannot change it (nor give the
-- contact its LD number that way); a university set (enrolment, the register import) clears it; clearing gives the LD
-- number.
CREATE OR REPLACE FUNCTION public.contacts_counsellor_number_only_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.counsellor_number_only AND NOT OLD.counsellor_number_only THEN
    NEW.counsellor_number_only := false;
  ELSIF NEW.counsellor_number_only IS DISTINCT FROM OLD.counsellor_number_only
        AND current_setting('role', true) = 'authenticated' AND NOT can_see_counsellor_chats(OLD.account_id) THEN
    NEW.counsellor_number_only := OLD.counsellor_number_only;
    NEW.roll_number := OLD.roll_number;
    RETURN NEW;
  END IF;
  IF NEW.counsellor_number_only AND NEW.university IS NOT NULL THEN
    NEW.counsellor_number_only := false;
  END IF;
  IF OLD.counsellor_number_only AND NOT NEW.counsellor_number_only AND NEW.roll_number IS NULL THEN
    NEW.roll_number := 'LD-' || TO_CHAR(NOW(), 'YYMM') || '-' || LPAD(nextval('temp_lead_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.contacts_counsellor_number_only_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS contacts_counsellor_number_only_guard ON public.contacts;
CREATE TRIGGER contacts_counsellor_number_only_guard
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_counsellor_number_only_guard();

-- Only the webhook (service role, create_counsellor_number_contact) and psql make a flagged contact. A logged-in member's
-- insert is unflagged, so nobody can hide a lead from colleagues. The name sorts before trigger_generate_temp_lead, so
-- the contact still gets its LD number.
CREATE OR REPLACE FUNCTION public.contacts_counsellor_number_only_insert()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.counsellor_number_only AND current_setting('role', true) IN ('authenticated', 'anon') THEN
    NEW.counsellor_number_only := false;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.contacts_counsellor_number_only_insert() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS contacts_counsellor_number_only_insert ON public.contacts;
CREATE TRIGGER contacts_counsellor_number_only_insert
  BEFORE INSERT ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_counsellor_number_only_insert();

-- 8. the media proxy lookup -------------------------------------------------------------------------------------------------
-- messages is small (about 25k rows, 11 MB): a plain build inside the transaction.
CREATE INDEX IF NOT EXISTS messages_proxied_media_url ON public.messages (media_url)
  WHERE media_url LIKE '/api/whatsapp/media/%';

-- 9. how much history to keep for a number -----------------------------------------------------------------------------------
-- 'all': every 1:1 chat Meta sends (the owner's choice, 9 Nov). 'known_contacts': only chats with someone already in
-- Contacts (a lead). The save script sets it per number (--history-scope); the webhook reads it with the config row.
ALTER TABLE public.whatsapp_config ADD COLUMN IF NOT EXISTS history_scope text NOT NULL DEFAULT 'all';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_history_scope_check') THEN
    ALTER TABLE public.whatsapp_config ADD CONSTRAINT whatsapp_config_history_scope_check
      CHECK (history_scope IN ('all', 'known_contacts'));
  END IF;
END $$;

-- 10. contact RPCs: the same visibility as the contacts policy, the same error for hidden and missing ----------------------
-- (decide_fee_discount and verify_payment are admin-only already.)
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

-- 11. growth counts: chats on counsellor numbers and contacts that arrived through them are not new leads ---------------
CREATE OR REPLACE FUNCTION public.growth_live(p_account_id uuid, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_since timestamptz;
  v_cn text[] := counsellor_phone_number_ids();
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
            AND NOT coalesce(phone_number_id = ANY (v_cn), false)
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
          AND NOT coalesce(c.phone_number_id = ANY (v_cn), false)
        GROUP BY c.phone_number_id
      ) b
    ), '[]'::jsonb),
    'contacts_by_source', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('source', s.source, 'contacts', s.n) ORDER BY s.n DESC)
      FROM (
        SELECT source, count(*)::int AS n
        FROM contacts
        WHERE account_id = p_account_id AND created_at >= v_since AND NOT counsellor_number_only
        GROUP BY source
      ) s
    ), '[]'::jsonb)
  );
END;
$function$;

-- 12. what a logged-in member may write -------------------------------------------------------------------------------------
-- /api/whatsapp/media/<id> serves any media id that a message the caller can read points at, so only the webhook (service
-- role) writes that prefix. A member's send stores the uploaded file's own URL.
CREATE OR REPLACE FUNCTION public.refuse_member_media_proxy_url()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('role', true) IN ('authenticated', 'anon')
     AND NEW.media_url LIKE '/api/whatsapp/media/%'
     AND (TG_OP = 'INSERT' OR NEW.media_url IS DISTINCT FROM OLD.media_url) THEN
    RAISE EXCEPTION 'media_url: the media proxy link is written by the webhook only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.refuse_member_media_proxy_url() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS refuse_member_media_proxy_url ON public.messages;
CREATE TRIGGER refuse_member_media_proxy_url
  BEFORE INSERT OR UPDATE OF media_url ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.refuse_member_media_proxy_url();

-- A deal or follow-up entry a member writes may name only a chat that member can see (conversations RLS: the subquery
-- runs as the caller). Checked when the chat is set or changed, not on every edit, so an agent can still move a deal an
-- admin pointed at a counsellor-number chat.
CREATE OR REPLACE FUNCTION public.refuse_hidden_chat_reference()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('role', true) IN ('authenticated', 'anon') AND NEW.conversation_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id)
     AND NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = NEW.conversation_id) THEN
    RAISE EXCEPTION 'conversation_id: no such chat' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.refuse_hidden_chat_reference() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS refuse_hidden_chat_reference ON public.deals;
CREATE TRIGGER refuse_hidden_chat_reference
  BEFORE INSERT OR UPDATE OF conversation_id ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.refuse_hidden_chat_reference();
DROP TRIGGER IF EXISTS refuse_hidden_chat_reference ON public.follow_up_entries;
CREATE TRIGGER refuse_hidden_chat_reference
  BEFORE INSERT OR UPDATE OF conversation_id ON public.follow_up_entries
  FOR EACH ROW EXECUTE FUNCTION public.refuse_hidden_chat_reference();
