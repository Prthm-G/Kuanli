-- 090_rollback.sql  (KB-SEND-RECOVERY-20261107): restores the 089 finder and the prior assign_counsellor_silent, removes the new
-- functions. The two new tables are dropped too; they only hold throttle state. The bot messages a resend wrote stay.
CREATE OR REPLACE FUNCTION public.silent_ad_leads(p_phone_number_id text, p_quiet_minutes int DEFAULT 15, p_window_hours int DEFAULT 24)
RETURNS TABLE (conversation_id uuid, contact_name text, phone text, interest text, last_bot_text text,
               quiet_since timestamptz, ad_source_id text, ad_name text, ad_headline text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT cv.id, ct.name, ct.phone,
         nullif(concat_ws(' ', cv.interest_university, cv.interest_mode, cv.interest_course), ''),
         coalesce(lb.content_text, '(a menu or media)'), lm.last_at,
         coalesce(cv.ad_source_id, 'unknown'), ad.name,
         coalesce(ad.headline, cv.ad_headline,
                  CASE WHEN cv.ad_source_id IS NULL THEN 'Meta ad (WhatsApp did not say which one)' END)
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
     AND (cv.ad_source_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM public.messages m
                       JOIN public.wa_message_pricing p ON p.message_id = m.message_id
                      WHERE m.conversation_id = cv.id AND p.category = 'referral_conversion'))
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

CREATE OR REPLACE FUNCTION public.assign_counsellor_silent(p_conversation_id uuid)
 RETURNS TABLE(counsellor_id uuid, display_name text, wa_number text, telegram_chat_id bigint, is_new boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;

DROP FUNCTION IF EXISTS public.claim_post_handover_pings(text, int, int, int);
DROP FUNCTION IF EXISTS public.release_post_handover_ping(uuid);
DROP FUNCTION IF EXISTS public.claim_bot_resends(text, int, int, int);
DROP INDEX IF EXISTS public.webhook_inbox_received_at;
DROP FUNCTION IF EXISTS public.record_bot_resend(uuid, text, text, text);
DROP TABLE IF EXISTS public.counsellor_repings;
DROP TABLE IF EXISTS public.bot_resends;

REVOKE ALL ON FUNCTION public.assign_counsellor_silent(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.silent_ad_leads(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_counsellor_silent(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.silent_ad_leads(text, int, int) TO service_role;
