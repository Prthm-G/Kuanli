-- 082_silent_leads.sql  (KB-SP3B-SILENT-01)
-- SP3b follow-up: an ad lead who goes quiet in the 79019 bot still reaches a counsellor,
-- and the counsellor (and the bot) know which ad the lead clicked.
--   ad_catalog                            ad id -> name, mode, hook, style, headline, full ad text
--   counsellor_assignments.assigned_via   'tap' (asked for a counsellor) | 'silent' (went quiet)
--   assign_counsellor_silent(conv)        same rotation, lock and stickiness as assign_counsellor, but the
--                                         bot stays on and the Kuanli owner is left alone: the lead never
--                                         asked for a human, so a returning lead still gets the bot
--   silent_ad_leads(pnid, mins, hours)    79019 ad chats that went quiet and have no counsellor yet
-- Rollback: 082_rollback.sql.

CREATE TABLE IF NOT EXISTS public.ad_catalog (
  ad_id      text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name       text NOT NULL,
  mode       text,
  hook       text,
  style      text,
  headline   text,
  body       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ad_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ad_catalog_read ON public.ad_catalog;
CREATE POLICY ad_catalog_read ON public.ad_catalog FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'viewer'::public.account_role_enum));
-- Explicit grants: Supabase default privileges would otherwise give anon and
-- authenticated full DML on new tables.
REVOKE ALL ON public.ad_catalog FROM anon, authenticated;
GRANT SELECT ON public.ad_catalog TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ad_catalog TO service_role;
CREATE INDEX IF NOT EXISTS ad_catalog_account ON public.ad_catalog (account_id);

ALTER TABLE public.counsellor_assignments ADD COLUMN IF NOT EXISTS assigned_via text NOT NULL DEFAULT 'tap';
ALTER TABLE public.counsellor_assignments DROP CONSTRAINT IF EXISTS counsellor_assignments_assigned_via_check;
ALTER TABLE public.counsellor_assignments ADD CONSTRAINT counsellor_assignments_assigned_via_check
  CHECK (assigned_via IN ('tap', 'silent'));

CREATE OR REPLACE FUNCTION public.assign_counsellor_silent(p_conversation_id uuid)
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
  -- The same lock as assign_counsellor, so a tap and a silent pick never race to the same "next".
  PERFORM pg_advisory_xact_lock(hashtext('assign_counsellor:' || v_acc::text));

  -- Re-checked under the lock (the finder's snapshot is older): since it ran, the lead may have
  -- tapped or written again, someone may have taken or answered the chat in Kuanli, or the bot
  -- may have been paused. Still quiet = the latest message is the bot's.
  IF EXISTS (SELECT 1 FROM public.counsellor_assignments a WHERE a.conversation_id = p_conversation_id)
     OR EXISTS (SELECT 1 FROM public.conversations cv WHERE cv.id = p_conversation_id
                  AND (cv.assigned_agent_id IS NOT NULL OR cv.bot_active = false))
     OR EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = p_conversation_id AND m.sender_type = 'agent')
     OR (SELECT m.sender_type FROM public.messages m WHERE m.conversation_id = p_conversation_id
          ORDER BY m.created_at DESC LIMIT 1) IS DISTINCT FROM 'bot' THEN
    RETURN;
  END IF;

  -- Sticky, then strict alternation: identical to assign_counsellor (081).
  SELECT c.* INTO v_c
    FROM public.counsellor_assignments a JOIN public.counsellors c ON c.id = a.counsellor_id
   WHERE a.contact_id = v_contact AND c.account_id = v_acc
   ORDER BY a.assigned_at DESC LIMIT 1;
  IF FOUND AND v_c.active THEN
    v_new := false;
  ELSE
    SELECT c.* INTO v_c
      FROM public.counsellors c
      LEFT JOIN LATERAL (SELECT max(a.assigned_at) AS last
                           FROM public.counsellor_assignments a WHERE a.counsellor_id = c.id) l ON true
     WHERE c.account_id = v_acc AND c.active
     ORDER BY l.last NULLS FIRST, c.created_at, c.id
     LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;  -- nobody active: no row; the finder offers it again next run
  END IF;

  INSERT INTO public.counsellor_assignments (account_id, conversation_id, contact_id, counsellor_id, assigned_at, assigned_via)
  VALUES (v_acc, p_conversation_id, v_contact, v_c.id, clock_timestamp(), 'silent')
  ON CONFLICT (conversation_id, counsellor_id) DO NOTHING;

  -- No bot_active change and no assigned_agent_id: the bot keeps answering. If the lead later taps
  -- "Talk to a counsellor", assign_counsellor finds this row (sticky) and hands the chat over then.
  RETURN QUERY SELECT v_c.id, v_c.display_name, v_c.wa_number, v_c.telegram_chat_id, v_new;
END $$;

CREATE OR REPLACE FUNCTION public.silent_ad_leads(p_phone_number_id text, p_quiet_minutes int DEFAULT 15, p_window_hours int DEFAULT 24)
RETURNS TABLE (conversation_id uuid, contact_name text, phone text, interest text, last_bot_text text,
               quiet_since timestamptz, ad_source_id text, ad_name text, ad_headline text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT cv.id, ct.name, ct.phone,
         nullif(concat_ws(' ', cv.interest_university, cv.interest_mode, cv.interest_course), ''),
         coalesce(lb.content_text, '(a menu or media)'), lm.last_at, cv.ad_source_id, ad.name, coalesce(ad.headline, cv.ad_headline)
    FROM public.conversations cv
    JOIN public.contacts ct ON ct.id = cv.contact_id
    CROSS JOIN LATERAL (SELECT max(m.created_at) AS last_at FROM public.messages m
                         WHERE m.conversation_id = cv.id) lm
    -- inner join + lb.created_at = lm.last_at: the bot spoke last (a lead whose message got no
    -- reply is a bot failure, caught by check-auretris-failures.sh, not a quiet lead)
    CROSS JOIN LATERAL (SELECT m.content_text, m.created_at FROM public.messages m
                         WHERE m.conversation_id = cv.id AND m.sender_type = 'bot'
                         ORDER BY m.created_at DESC LIMIT 1) lb
    LEFT JOIN public.ad_catalog ad ON ad.ad_id = cv.ad_source_id AND ad.account_id = cv.account_id
   WHERE cv.phone_number_id = p_phone_number_id
     AND cv.ad_source_id IS NOT NULL
     AND greatest(cv.created_at, cv.ad_referral_at) > now() - make_interval(hours => p_window_hours)
     AND cv.assigned_agent_id IS NULL
     AND cv.bot_active IS DISTINCT FROM false
     AND lm.last_at < now() - make_interval(mins => p_quiet_minutes)
     AND lb.created_at = lm.last_at
     AND NOT EXISTS (SELECT 1 FROM public.counsellor_assignments a WHERE a.conversation_id = cv.id)
     AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = cv.id AND m.sender_type = 'agent')
   ORDER BY lm.last_at
   LIMIT 20;
$$;

REVOKE ALL ON FUNCTION public.assign_counsellor_silent(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.silent_ad_leads(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_counsellor_silent(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.silent_ad_leads(text, int, int) TO service_role;
