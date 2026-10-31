-- 089_silent_referral_origin.sql  (KB-SILENT-REFERRAL-20261030)
-- An ad lead whose first message carries no `referral` (no ad id, no ctwa_clid) was never tagged
-- (conversations.ad_source_id NULL), so silent_ad_leads skipped it and nobody got the lead.
-- Seen live: d91de55a 30 Oct 18:25 (typed "Hi" on an FAQ-template ad) and 44b8c32b 11:24.
-- WhatsApp still marks those chats as ad-started: every outbound status carries pricing category
-- 'referral_conversion' (free entry point), stored per wamid in wa_message_pricing by the webhook.
-- silent_ad_leads now also takes a conversation with any referral_conversion-priced message.
-- Such a row has no ad id, so it returns ad_source_id 'unknown' + a headline saying so: the n8n
-- pings then print "Ad: Meta ad (WhatsApp did not say which one)" instead of "Ad: none", and the
-- ad-photo step finds no catalog row (it joins on conversations.ad_source_id) and sends no photo.
-- Signature unchanged. Rollback: 089_rollback.sql (restores the 082 body).

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

REVOKE ALL ON FUNCTION public.silent_ad_leads(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.silent_ad_leads(text, int, int) TO service_role;
