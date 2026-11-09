-- 092_failed_reply_pings.sql  (KB-FAILED-REPLY-PING-20261108)
-- From the 8 Nov audit. A counsellor already owns a lead (a quiet or unanswered handover, bot still on), the bot
-- answers the lead's next message, and that reply fails to send. Nobody tells the counsellor: the unanswered finder
-- skips chats that already have a counsellor, the resend sweep only takes first replies, and the wrote-again ping
-- only runs once the bot is off. 2 of 16 chats with a failed send in the 7 days to 8 Nov.
--
-- claim_failed_reply_pings: the counsellor gets one ping per failure, when
--   - their assignment is older than the failure (a failure before it is the unanswered handover's job),
--   - the bot is still on for the chat (bot off = they have the chat already and the bot isn't talking),
--   - nothing from the bot or a human has gone through since, and nothing human was sent after it,
--   - the failure is 5 to 60 minutes old (5 lets a following reply recover it; 60 means applying this sends no backlog).
-- A second failure in the same chat pings again only after 30 minutes. Each claim gets one Telegram try (with n8n's
-- own 3 retries) and one ntfy: no release-and-retry, so a counsellor who blocked the bot can't make ntfy repeat.
-- Rollback: 092_rollback.sql.

CREATE TABLE IF NOT EXISTS public.failed_reply_pings (
  conversation_id uuid PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  failed_at       timestamptz NOT NULL,
  pinged_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.failed_reply_pings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.failed_reply_pings FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_failed_reply_pings(p_phone_number_id text, p_grace_minutes int DEFAULT 5,
                                                          p_window_minutes int DEFAULT 60, p_throttle_minutes int DEFAULT 30)
RETURNS TABLE (conversation_id uuid, contact_name text, phone text, interest text, last_text text, failed_at timestamptz,
               ad_source_id text, ad_name text, ad_headline text,
               counsellor_id uuid, display_name text, wa_number text, telegram_chat_id bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT cv.id AS conv, cv.contact_id, cv.interest_university, cv.interest_mode, cv.interest_course,
           cv.ad_source_id, cv.ad_headline, cv.account_id, f.created_at AS fail_at, a.counsellor_id,
           lc.content_text, lc.error_code
      FROM public.conversations cv
      CROSS JOIN LATERAL (SELECT m.created_at FROM public.messages m
                           WHERE m.conversation_id = cv.id AND m.sender_type = 'bot' AND m.status = 'failed'
                           ORDER BY m.created_at DESC LIMIT 1) f
      CROSS JOIN LATERAL (SELECT ca.counsellor_id, ca.assigned_at FROM public.counsellor_assignments ca
                           WHERE ca.conversation_id = cv.id ORDER BY ca.assigned_at DESC LIMIT 1) a
      JOIN public.counsellors active_c ON active_c.id = a.counsellor_id AND active_c.active
      LEFT JOIN LATERAL (SELECT m.content_text, m.error_code FROM public.messages m
                          WHERE m.conversation_id = cv.id AND m.sender_type = 'customer' AND m.created_at <= f.created_at
                          ORDER BY m.created_at DESC LIMIT 1) lc ON true
      LEFT JOIN public.failed_reply_pings r ON r.conversation_id = cv.id
     WHERE cv.phone_number_id = p_phone_number_id
       AND cv.bot_active IS DISTINCT FROM false
       AND f.created_at > a.assigned_at
       AND f.created_at < now() - make_interval(mins => p_grace_minutes)
       AND f.created_at > now() - make_interval(mins => p_window_minutes)
       AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = cv.id
                          AND m.sender_type IN ('bot', 'agent') AND m.status IS DISTINCT FROM 'failed'
                          AND m.created_at > f.created_at)
       AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = cv.id AND m.sender_type = 'agent'
                          AND m.created_at > f.created_at)
       AND (r.conversation_id IS NULL
            OR (r.failed_at < f.created_at AND r.pinged_at < now() - make_interval(mins => p_throttle_minutes)))
     ORDER BY f.created_at
     LIMIT 20
  ), claimed AS (
    INSERT INTO public.failed_reply_pings AS t (conversation_id, failed_at, pinged_at)
    SELECT conv, fail_at, now() FROM due
    ON CONFLICT (conversation_id) DO UPDATE SET failed_at = EXCLUDED.failed_at, pinged_at = EXCLUDED.pinged_at
      -- An overlapping run loses here and returns nothing, so one failure pings once.
      WHERE t.failed_at < EXCLUDED.failed_at AND t.pinged_at < now() - make_interval(mins => p_throttle_minutes)
    RETURNING t.conversation_id
  )
  SELECT d.conv, ct.name, ct.phone,
         nullif(concat_ws(' ', d.interest_university, d.interest_mode, d.interest_course), ''),
         CASE WHEN d.error_code IN (131051, 131060) THEN '(a message WhatsApp could not show us)'
              WHEN nullif(btrim(d.content_text), '') IS NULL THEN '(a button tap or media)'
              ELSE d.content_text END,
         d.fail_at, d.ad_source_id, ad.name, coalesce(ad.headline, d.ad_headline),
         c.id, c.display_name, c.wa_number, c.telegram_chat_id
    FROM due d
    JOIN claimed cl ON cl.conversation_id = d.conv
    JOIN public.contacts ct ON ct.id = d.contact_id
    JOIN public.counsellors c ON c.id = d.counsellor_id
    LEFT JOIN public.ad_catalog ad ON ad.ad_id = d.ad_source_id AND ad.account_id = d.account_id;
$$;

REVOKE ALL ON FUNCTION public.claim_failed_reply_pings(text, int, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_failed_reply_pings(text, int, int, int) TO service_role;
GRANT ALL ON TABLE public.failed_reply_pings TO service_role;
