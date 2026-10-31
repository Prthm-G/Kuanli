-- 089_rollback.sql  (KB-SILENT-REFERRAL-20261030): silent_ad_leads back to the 082 body (tagged ad leads only).

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

REVOKE ALL ON FUNCTION public.silent_ad_leads(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.silent_ad_leads(text, int, int) TO service_role;
