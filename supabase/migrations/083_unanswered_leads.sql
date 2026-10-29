-- 083_unanswered_leads.sql  (KB-LAUNCHFIX3-20261029)
-- A lead who wrote last and got no reply: the bot failed for that chat, or Meta handed us a message it could not
-- show (131051/131060 after the first contact, which Kuanli never forwards to the bot). The pre-launch audit found
-- 13 of 14 real 79019 messages were unreadable and one lead waited with no reply. 082 only covers chats where the
-- bot spoke last. Same rules as 082 otherwise: same lock, sticky + strict alternation, bot stays on, no message
-- to the lead; the counsellor gets the Telegram ping from n8n `Skeure Silent Leads`.
-- Ad and organic leads alike (an unanswered organic lead is as lost as an ad lead). Rollback: 083_rollback.sql
-- (roll back the n8n side first: devtools/apply-skeure-unanswered-leads.mjs --rollback).

ALTER TABLE public.counsellor_assignments DROP CONSTRAINT IF EXISTS counsellor_assignments_assigned_via_check;
ALTER TABLE public.counsellor_assignments ADD CONSTRAINT counsellor_assignments_assigned_via_check
  CHECK (assigned_via IN ('tap', 'silent', 'unanswered'));

CREATE OR REPLACE FUNCTION public.assign_counsellor_unanswered(p_conversation_id uuid)
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
  PERFORM pg_advisory_xact_lock(hashtext('assign_counsellor:' || v_acc::text));

  -- Re-checked under the lock: still unowned, bot not paused, nobody human replied, and the latest
  -- message is still the lead's (a late bot reply since the finder ran means the bot recovered).
  IF EXISTS (SELECT 1 FROM public.counsellor_assignments a WHERE a.conversation_id = p_conversation_id)
     OR EXISTS (SELECT 1 FROM public.conversations cv WHERE cv.id = p_conversation_id
                  AND (cv.assigned_agent_id IS NOT NULL OR cv.bot_active = false))
     OR EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = p_conversation_id AND m.sender_type = 'agent')
     OR (SELECT m.sender_type FROM public.messages m WHERE m.conversation_id = p_conversation_id
          ORDER BY m.created_at DESC LIMIT 1) IS DISTINCT FROM 'customer' THEN
    RETURN;
  END IF;

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
    IF NOT FOUND THEN RETURN; END IF;
  END IF;

  INSERT INTO public.counsellor_assignments (account_id, conversation_id, contact_id, counsellor_id, assigned_at, assigned_via)
  VALUES (v_acc, p_conversation_id, v_contact, v_c.id, clock_timestamp(), 'unanswered')
  ON CONFLICT (conversation_id, counsellor_id) DO NOTHING;

  RETURN QUERY SELECT v_c.id, v_c.display_name, v_c.wa_number, v_c.telegram_chat_id, v_new;
END $$;

-- Same columns as silent_ad_leads (so one n8n statement can UNION both); last_text is the lead's last message,
-- or a marker when WhatsApp could not show it to us.
CREATE OR REPLACE FUNCTION public.unanswered_leads(p_phone_number_id text, p_quiet_minutes int DEFAULT 15, p_window_hours int DEFAULT 24)
RETURNS TABLE (conversation_id uuid, contact_name text, phone text, interest text, last_text text,
               quiet_since timestamptz, ad_source_id text, ad_name text, ad_headline text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT cv.id, ct.name, ct.phone,
         nullif(concat_ws(' ', cv.interest_university, cv.interest_mode, cv.interest_course), ''),
         CASE WHEN lc.error_code IN (131051, 131060) OR nullif(btrim(lc.content_text), '') IS NULL
              THEN '(a message WhatsApp could not show us)' ELSE lc.content_text END,
         lc.created_at, cv.ad_source_id, ad.name, coalesce(ad.headline, cv.ad_headline)
    FROM public.conversations cv
    JOIN public.contacts ct ON ct.id = cv.contact_id
    CROSS JOIN LATERAL (SELECT m.sender_type, m.content_text, m.error_code, m.created_at FROM public.messages m
                         WHERE m.conversation_id = cv.id ORDER BY m.created_at DESC LIMIT 1) lc
    LEFT JOIN public.ad_catalog ad ON ad.ad_id = cv.ad_source_id AND ad.account_id = cv.account_id
   WHERE cv.phone_number_id = p_phone_number_id
     AND lc.sender_type = 'customer'
     AND lc.created_at < now() - make_interval(mins => p_quiet_minutes)
     AND lc.created_at > now() - make_interval(hours => p_window_hours)
     AND cv.assigned_agent_id IS NULL
     AND cv.bot_active IS DISTINCT FROM false
     AND NOT EXISTS (SELECT 1 FROM public.counsellor_assignments a WHERE a.conversation_id = cv.id)
     AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = cv.id AND m.sender_type = 'agent')
   ORDER BY lc.created_at
   LIMIT 20;
$$;

REVOKE ALL ON FUNCTION public.assign_counsellor_unanswered(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unanswered_leads(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_counsellor_unanswered(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.unanswered_leads(text, int, int) TO service_role;
