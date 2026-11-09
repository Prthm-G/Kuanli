-- 090_send_recovery.sql  (KB-SEND-RECOVERY-20261107)
-- From the 6-7 Nov live-ads audit. This box's outbound fails in short bursts, and three first replies failed in 16.
--
-- 1. silent_ad_leads + assign_counsellor_silent skip failed bot rows when deciding who spoke last, as 087 did for
--    unanswered_leads. A lead whose ONLY reply failed now reads "wrote and got no reply" (083), which is true, rather
--    than "went quiet". Both the last-message and last-bot lookups change: filtering last-bot alone would lose a lead
--    whose mid-flow send failed, from both finders.
-- 2. silent_ad_leads also takes a chat whose first inbound WhatsApp could not show us (131051/131060). These often carry no
--    referral, so no finder picked them up once the bot had replied.
-- 3. claim_post_handover_pings: a lead writing after handover (bot off) pings nobody today, because Kuanli stops
--    forwarding to n8n. Throttled per conversation; only messages from the last hour, so applying this sends no backlog.
--    "After handover" counts from the later of the assignment and the bot's ack, so the handover tap itself doesn't
--    ping on a chat that Silent Leads assigned earlier. release_post_handover_ping undoes a claim whose ping failed.
-- 4. claim_bot_resends + record_bot_resend: a failed FIRST reply gets the mode menu again before the 15-minute
--    handover. WhatsApp has no idempotency key, so:
--      connect errors never reached Meta: safe, up to 3 tries.
--      timeouts may have reached Meta: one try, only after 5 min with no status webhook for that recipient.
--      anything else (Meta 4xx/5xx): no resend, the alert and the handover cover it.
--    Never to a chat with any delivered reply, a counsellor, an agent message, or the bot off.
-- Rollback: 090_rollback.sql.

CREATE OR REPLACE FUNCTION public.silent_ad_leads(p_phone_number_id text, p_quiet_minutes integer DEFAULT 15, p_window_hours integer DEFAULT 24)
 RETURNS TABLE(conversation_id uuid, contact_name text, phone text, interest text, last_bot_text text, quiet_since timestamp with time zone, ad_source_id text, ad_name text, ad_headline text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT cv.id, ct.name, ct.phone,
         nullif(concat_ws(' ', cv.interest_university, cv.interest_mode, cv.interest_course), ''),
         coalesce(lb.content_text, '(a menu or media)'), lm.last_at,
         coalesce(cv.ad_source_id, 'unknown'), ad.name,
         coalesce(ad.headline, cv.ad_headline,
                  CASE WHEN cv.ad_source_id IS NOT NULL THEN NULL
                       WHEN src.referral THEN 'Meta ad (WhatsApp did not say which one)'
                       ELSE 'Source unknown (WhatsApp could not show their first message)' END)
    FROM public.conversations cv
    JOIN public.contacts ct ON ct.id = cv.contact_id
    CROSS JOIN LATERAL (SELECT max(m.created_at) AS last_at FROM public.messages m
                         WHERE m.conversation_id = cv.id
                           AND NOT (m.sender_type <> 'customer' AND m.status = 'failed')) lm
    -- inner join + lb.created_at = lm.last_at: the bot spoke last and it arrived. A lead whose message got no
    -- delivered reply belongs to unanswered_leads (083, 087), not here.
    CROSS JOIN LATERAL (SELECT m.content_text, m.created_at FROM public.messages m
                         WHERE m.conversation_id = cv.id AND m.sender_type = 'bot'
                           AND m.status IS DISTINCT FROM 'failed'
                         ORDER BY m.created_at DESC LIMIT 1) lb
    CROSS JOIN LATERAL (SELECT
        EXISTS (SELECT 1 FROM public.messages m
                  JOIN public.wa_message_pricing p ON p.message_id = m.message_id
                 WHERE m.conversation_id = cv.id AND p.category = 'referral_conversion') AS referral,
        (SELECT m.error_code FROM public.messages m WHERE m.conversation_id = cv.id AND m.sender_type = 'customer'
          ORDER BY m.created_at LIMIT 1) IN (131051, 131060) AS unreadable_first) src
    LEFT JOIN public.ad_catalog ad ON ad.ad_id = cv.ad_source_id AND ad.account_id = cv.account_id
   WHERE cv.phone_number_id = p_phone_number_id
     AND (cv.ad_source_id IS NOT NULL OR src.referral OR src.unreadable_first)
     AND greatest(cv.created_at, cv.ad_referral_at) > now() - make_interval(hours => p_window_hours)
     AND cv.assigned_agent_id IS NULL
     AND cv.bot_active IS DISTINCT FROM false
     AND lm.last_at < now() - make_interval(mins => p_quiet_minutes)
     AND lb.created_at = lm.last_at
     AND NOT EXISTS (SELECT 1 FROM public.counsellor_assignments a WHERE a.conversation_id = cv.id)
     AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = cv.id AND m.sender_type = 'agent')
   ORDER BY lm.last_at
   LIMIT 20;
$function$;

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
            AND NOT (m.sender_type <> 'customer' AND m.status = 'failed')
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

-- ---- post-handover pings ------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.counsellor_repings (
  conversation_id uuid PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  last_message_at timestamptz NOT NULL,
  pinged_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.counsellor_repings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.counsellor_repings FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_post_handover_pings(p_phone_number_id text, p_throttle_minutes int DEFAULT 30,
                                                           p_grace_minutes int DEFAULT 2, p_window_minutes int DEFAULT 60)
RETURNS TABLE (conversation_id uuid, contact_name text, phone text, interest text, last_text text, quiet_since timestamptz,
               ad_source_id text, ad_name text, ad_headline text,
               counsellor_id uuid, display_name text, wa_number text, telegram_chat_id bigint, is_new boolean)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT cv.id AS conv, cv.contact_id, cv.interest_university, cv.interest_mode, cv.interest_course,
           cv.ad_source_id, cv.ad_headline, cv.account_id,
           lc.content_text, lc.error_code, lc.created_at AS msg_at, a.counsellor_id
      FROM public.conversations cv
      CROSS JOIN LATERAL (SELECT m.content_text, m.error_code, m.created_at FROM public.messages m
                           WHERE m.conversation_id = cv.id AND m.sender_type = 'customer'
                           ORDER BY m.created_at DESC LIMIT 1) lc
      CROSS JOIN LATERAL (SELECT ca.counsellor_id, ca.assigned_at FROM public.counsellor_assignments ca
                           WHERE ca.conversation_id = cv.id ORDER BY ca.assigned_at DESC LIMIT 1) a
      CROSS JOIN LATERAL (SELECT max(m.created_at) AS at FROM public.messages m
                           WHERE m.conversation_id = cv.id AND m.sender_type = 'bot'
                             AND m.content_text LIKE 'Our counsellor %') ack
      JOIN public.counsellors active_c ON active_c.id = a.counsellor_id AND active_c.active
      LEFT JOIN public.counsellor_repings r ON r.conversation_id = cv.id
     WHERE cv.phone_number_id = p_phone_number_id
       AND cv.bot_active = false
       AND lc.created_at > greatest(a.assigned_at, ack.at) + make_interval(mins => p_grace_minutes)
       AND lc.created_at > now() - make_interval(mins => p_window_minutes)
       AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = cv.id AND m.sender_type = 'agent'
                          AND m.created_at > lc.created_at)
       AND (r.conversation_id IS NULL
            OR (r.last_message_at < lc.created_at AND r.pinged_at < now() - make_interval(mins => p_throttle_minutes)))
     ORDER BY lc.created_at
     LIMIT 20
  ), claimed AS (
    INSERT INTO public.counsellor_repings AS t (conversation_id, last_message_at, pinged_at)
    SELECT conv, msg_at, now() FROM due
    ON CONFLICT (conversation_id) DO UPDATE SET last_message_at = EXCLUDED.last_message_at, pinged_at = EXCLUDED.pinged_at
      -- An overlapping run loses here and returns nothing, so one message pings once.
      WHERE t.last_message_at < EXCLUDED.last_message_at AND t.pinged_at < now() - make_interval(mins => p_throttle_minutes)
    RETURNING t.conversation_id
  )
  SELECT d.conv, ct.name, ct.phone,
         nullif(concat_ws(' ', d.interest_university, d.interest_mode, d.interest_course), ''),
         CASE WHEN d.error_code IN (131051, 131060) OR nullif(btrim(d.content_text), '') IS NULL
              THEN '(a message WhatsApp could not show us)' ELSE d.content_text END,
         d.msg_at, d.ad_source_id, ad.name, coalesce(ad.headline, d.ad_headline),
         c.id, c.display_name, c.wa_number, c.telegram_chat_id, false
    FROM due d
    JOIN claimed cl ON cl.conversation_id = d.conv
    JOIN public.contacts ct ON ct.id = d.contact_id
    JOIN public.counsellors c ON c.id = d.counsellor_id
    LEFT JOIN public.ad_catalog ad ON ad.ad_id = d.ad_source_id AND ad.account_id = d.account_id;
$$;

CREATE OR REPLACE FUNCTION public.release_post_handover_ping(p_conversation_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM public.counsellor_repings WHERE conversation_id = p_conversation_id;
$$;

-- ---- first-reply resend -------------------------------------------------------------------------------------
-- Only the timeout check reads webhook_inbox by time; 7 days of rows are kept, so give it an index.
CREATE INDEX IF NOT EXISTS webhook_inbox_received_at ON public.webhook_inbox (received_at);

CREATE TABLE IF NOT EXISTS public.bot_resends (
  conversation_id   uuid PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  attempts          int NOT NULL DEFAULT 0,
  last_attempt_at   timestamptz,
  sent_at           timestamptz,
  stopped           boolean NOT NULL DEFAULT false,
  last_error        text
);
ALTER TABLE public.bot_resends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bot_resends FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_bot_resends(p_phone_number_id text, p_max_attempts int DEFAULT 3,
                                                   p_gap_minutes int DEFAULT 4, p_window_minutes int DEFAULT 14)
RETURNS TABLE (conversation_id uuid, phone text, phone_number_id text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT cv.id AS conv, ct.phone, cv.phone_number_id AS pnid,
           f.content_text ~ 'EHOSTUNREACH|ECONNREFUSED|ENETUNREACH|ENOTFOUND|EAI_AGAIN' AS is_connect
      FROM public.conversations cv
      JOIN public.contacts ct ON ct.id = cv.contact_id
      CROSS JOIN LATERAL (SELECT m.content_text, m.created_at FROM public.messages m
                           WHERE m.conversation_id = cv.id AND m.sender_type = 'bot'
                             AND m.status = 'failed' AND m.error_code IS NULL
                           ORDER BY m.created_at DESC LIMIT 1) f
      LEFT JOIN public.bot_resends r ON r.conversation_id = cv.id
     WHERE cv.phone_number_id = p_phone_number_id
       AND cv.bot_active IS DISTINCT FROM false
       AND cv.assigned_agent_id IS NULL
       AND f.created_at > now() - make_interval(mins => p_window_minutes)
       AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = cv.id
                          AND m.sender_type IN ('bot', 'agent') AND m.status IS DISTINCT FROM 'failed')
       AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = cv.id AND m.sender_type = 'agent')
       AND NOT EXISTS (SELECT 1 FROM public.counsellor_assignments a WHERE a.conversation_id = cv.id)
       AND coalesce(r.sent_at IS NULL AND NOT r.stopped, true)
       AND coalesce(r.attempts, 0) < p_max_attempts
       AND coalesce(r.last_attempt_at < now() - make_interval(mins => p_gap_minutes), true)
       AND (f.content_text ~ 'EHOSTUNREACH|ECONNREFUSED|ENETUNREACH|ENOTFOUND|EAI_AGAIN'
            OR (f.content_text LIKE '%timeout%'
                AND f.created_at < now() - interval '5 minutes'
                AND NOT EXISTS (SELECT 1 FROM public.webhook_inbox w
                                 WHERE w.received_at > f.created_at - interval '1 minute'
                                   AND w.body @> jsonb_build_object('entry', jsonb_build_array(jsonb_build_object('changes',
                                         jsonb_build_array(jsonb_build_object('value', jsonb_build_object('statuses',
                                         jsonb_build_array(jsonb_build_object('recipient_id', ct.phone)))))))))))
     LIMIT 10
  ), claimed AS (
    INSERT INTO public.bot_resends AS t (conversation_id, attempts, last_attempt_at, stopped)
    SELECT conv, 1, now(), NOT is_connect FROM due
    ON CONFLICT (conversation_id) DO UPDATE SET attempts = t.attempts + 1, last_attempt_at = now(), stopped = EXCLUDED.stopped
      -- An overlapping run loses here and returns nothing, so a timeout really gets one try.
      WHERE NOT t.stopped AND t.sent_at IS NULL AND t.attempts < p_max_attempts
        AND t.last_attempt_at < now() - make_interval(mins => p_gap_minutes)
    RETURNING t.conversation_id
  )
  SELECT d.conv, d.phone, d.pnid FROM due d JOIN claimed c ON c.conversation_id = d.conv;
$$;

-- Records the outcome. Success writes the bot message, so the status webhook and every "did it get a reply" query see it.
-- A timeout on the resend itself stops further tries: it may have reached Meta.
CREATE OR REPLACE FUNCTION public.record_bot_resend(p_conversation_id uuid, p_message_id text, p_text text, p_error text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF nullif(p_message_id, '') IS NOT NULL THEN
    INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, status, created_at, message_id)
    VALUES (p_conversation_id, 'bot', 'text', p_text, 'sent', now(), p_message_id)
    ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING;
    UPDATE public.bot_resends SET sent_at = now(), last_error = NULL WHERE conversation_id = p_conversation_id;
    RETURN true;
  END IF;
  UPDATE public.bot_resends
     SET last_error = left(coalesce(p_error, 'unknown'), 200),
         stopped = stopped OR coalesce(p_error, '') !~ 'EHOSTUNREACH|ECONNREFUSED|ENETUNREACH|ENOTFOUND|EAI_AGAIN'
   WHERE conversation_id = p_conversation_id;
  RETURN false;
END $$;

REVOKE ALL ON FUNCTION public.assign_counsellor_silent(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.silent_ad_leads(text, int, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_post_handover_pings(text, int, int, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_post_handover_ping(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_bot_resends(text, int, int, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_bot_resend(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_counsellor_silent(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.silent_ad_leads(text, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_post_handover_pings(text, int, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_post_handover_ping(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_bot_resends(text, int, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_bot_resend(uuid, text, text, text) TO service_role;
GRANT ALL ON TABLE public.counsellor_repings, public.bot_resends TO service_role;
