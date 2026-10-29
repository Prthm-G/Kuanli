-- 081_counsellors.sql  (KB-SP3B-P2-01)
-- SP3b three-phone routing: the counsellors who take leads from the bot on 79019,
-- one assignment row per conversation and counsellor, and the two functions n8n
-- and the webhook call.
--
-- assign_counsellor: strict alternation over active counsellors (the one whose
--   latest assignment is oldest goes next); a contact keeps their counsellor
--   while that counsellor is active. Always pauses the bot on the conversation.
-- mark_counsellor_reached: the lead's first message on a counsellor's own number
--   marks the assignment reached and keeps the bot quiet on their other chats.
--
-- Written by service_role (n8n, webhook, apply scripts). Humans in Kuanli can
-- read assignments; the counsellors table (Telegram join codes, chat ids) is
-- admin-only. A join code binds one Telegram chat: the "Skeure Leads" workflow
-- only sets telegram_chat_id while it is empty (or the same chat), so a leaked
-- code cannot redirect pings later; --reset-telegram issues a new one.

CREATE TABLE IF NOT EXISTS public.counsellors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  profile_id          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  display_name        text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  wa_number           text NOT NULL CHECK (wa_number ~ '^[0-9]{10,15}$'),
  phone_number_id     text UNIQUE,
  telegram_chat_id    bigint,
  telegram_start_code text NOT NULL UNIQUE CHECK (telegram_start_code ~ '^[0-9a-f]{12}$'),
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, wa_number)
);

CREATE TABLE IF NOT EXISTS public.counsellor_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  -- NO ACTION (checked at statement end), not RESTRICT: an account delete
  -- cascades to both tables and must not trip over the order of the cascades.
  counsellor_id   uuid NOT NULL REFERENCES public.counsellors(id) ON DELETE NO ACTION,
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  reached_at      timestamptz,
  reached_via     text,
  UNIQUE (conversation_id, counsellor_id)
);
CREATE INDEX IF NOT EXISTS counsellor_assignments_counsellor_time
  ON public.counsellor_assignments (counsellor_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS counsellor_assignments_contact
  ON public.counsellor_assignments (contact_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS counsellor_assignments_account
  ON public.counsellor_assignments (account_id);
CREATE INDEX IF NOT EXISTS counsellors_profile
  ON public.counsellors (profile_id);

ALTER TABLE public.counsellors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.counsellor_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS counsellors_read ON public.counsellors;
CREATE POLICY counsellors_read ON public.counsellors FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'admin'::public.account_role_enum));
DROP POLICY IF EXISTS counsellor_assignments_read ON public.counsellor_assignments;
CREATE POLICY counsellor_assignments_read ON public.counsellor_assignments FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'viewer'::public.account_role_enum));

-- Explicit grants: Supabase default privileges would otherwise give anon and
-- authenticated full DML on new tables.
REVOKE ALL ON public.counsellors, public.counsellor_assignments FROM anon, authenticated;
GRANT SELECT ON public.counsellors, public.counsellor_assignments TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.counsellors, public.counsellor_assignments TO service_role;

CREATE OR REPLACE FUNCTION public.assign_counsellor(p_conversation_id uuid)
RETURNS TABLE (counsellor_id uuid, display_name text, wa_number text, telegram_chat_id bigint, is_new boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_acc     uuid;
  v_contact uuid;
  v_c       public.counsellors%ROWTYPE;
  v_new     boolean := true;
BEGIN
  SELECT cv.account_id, cv.contact_id INTO v_acc, v_contact
    FROM public.conversations cv WHERE cv.id = p_conversation_id;
  IF v_acc IS NULL THEN RETURN; END IF;
  -- One assignment at a time per account, so two leads tapping at once never
  -- both land on the same "next" counsellor.
  PERFORM pg_advisory_xact_lock(hashtext('assign_counsellor:' || v_acc::text));

  -- The lead asked for a human: the bot pauses on this chat whatever happens next.
  UPDATE public.conversations SET bot_active = false, updated_at = now()
   WHERE id = p_conversation_id AND bot_active IS DISTINCT FROM false;

  -- Sticky: the contact's latest counsellor, if that counsellor is still active.
  -- (Latest, not latest active: a lead never drifts back to an older counsellor.)
  SELECT c.* INTO v_c
    FROM public.counsellor_assignments a JOIN public.counsellors c ON c.id = a.counsellor_id
   WHERE a.contact_id = v_contact AND c.account_id = v_acc
   ORDER BY a.assigned_at DESC LIMIT 1;
  IF FOUND AND v_c.active THEN
    v_new := false;
  ELSE
    -- Strict alternation: never-assigned first, then the oldest latest assignment.
    SELECT c.* INTO v_c
      FROM public.counsellors c
      LEFT JOIN LATERAL (SELECT max(a.assigned_at) AS last
                           FROM public.counsellor_assignments a WHERE a.counsellor_id = c.id) l ON true
     WHERE c.account_id = v_acc AND c.active
     ORDER BY l.last NULLS FIRST, c.created_at, c.id
     LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;  -- nobody active: no row, the bot is still paused
  END IF;

  -- clock_timestamp, not now(): now() is the transaction start, so a call that
  -- waited on the lock would stamp itself earlier than the call before it and
  -- break the alternation order.
  INSERT INTO public.counsellor_assignments (account_id, conversation_id, contact_id, counsellor_id, assigned_at)
  VALUES (v_acc, p_conversation_id, v_contact, v_c.id, clock_timestamp())
  ON CONFLICT (conversation_id, counsellor_id) DO NOTHING;

  -- A new assignment hands the chat to the counsellor's Kuanli login; a repeat
  -- only fills an empty owner, so a manual reassignment in Kuanli stays. A
  -- counsellor without a login (no profile) leaves the owner as is.
  UPDATE public.conversations
     SET assigned_agent_id = CASE WHEN v_new THEN COALESCE(v_c.profile_id, assigned_agent_id)
                                  ELSE COALESCE(assigned_agent_id, v_c.profile_id) END,
         updated_at = now()
   WHERE id = p_conversation_id;

  RETURN QUERY SELECT v_c.id, v_c.display_name, v_c.wa_number, v_c.telegram_chat_id, v_new;
END $$;

CREATE OR REPLACE FUNCTION public.mark_counsellor_reached(p_contact_id uuid, p_phone_number_id text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  -- Only a contact assigned to the counsellor who owns this number is linked;
  -- anyone else messaging a counsellor number is stored and left alone.
  -- No retry is needed for ordering: the lead learns the number from the ack,
  -- which n8n sends after assign_counsellor has committed.
  IF NOT EXISTS (SELECT 1 FROM public.counsellor_assignments a JOIN public.counsellors c ON c.id = a.counsellor_id
                  WHERE a.contact_id = p_contact_id AND c.phone_number_id = p_phone_number_id) THEN
    RETURN 0;
  END IF;
  UPDATE public.counsellor_assignments a SET reached_at = now(), reached_via = 'whatsapp'
    FROM public.counsellors c
   WHERE c.id = a.counsellor_id AND c.phone_number_id = p_phone_number_id
     AND a.contact_id = p_contact_id AND a.reached_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- The lead is talking to their counsellor now: keep the bot quiet on 79019.
  UPDATE public.conversations SET bot_active = false, updated_at = now()
   WHERE contact_id = p_contact_id AND phone_number_id IS DISTINCT FROM p_phone_number_id AND bot_active;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.assign_counsellor(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_counsellor_reached(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_counsellor(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_counsellor_reached(uuid, text) TO service_role;
