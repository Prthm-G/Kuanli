-- 097_rollback.sql  (KB-BRANCHES-R1)
-- Undo 097. Order matters (plpgsql bodies record no dependencies): refuse while 098/099 are live, restore the three
-- rotation functions to their pre-097 bodies (verbatim from 081, 090 and 087), take every non-Patiala counsellor out of
-- rotation (one pool again after this), then drop the new functions, triggers, columns and the branches table.
-- devtools/apply-kuanli-branches-097.mjs --rollback saves the branch data to backups/ before running this.
-- Run with psql -1.

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regproc('public.can_see_lead') IS NOT NULL OR to_regproc('public.growth_counsellors') IS NOT NULL THEN
    RAISE EXCEPTION '097 rollback refused: roll back 099 and 098 first';
  END IF;
END $$;

-- 1. the three rotation functions, as before 097 -----------------------------------------------------------------------
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
            AND NOT (m.sender_type <> 'customer' AND m.status = 'failed')
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

REVOKE ALL ON FUNCTION public.assign_counsellor(uuid), public.assign_counsellor_silent(uuid),
                       public.assign_counsellor_unanswered(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_counsellor(uuid), public.assign_counsellor_silent(uuid),
                          public.assign_counsellor_unanswered(uuid) TO service_role;

-- 2. one rotation again: counsellors outside Patiala stop taking leads ----------------------------------------------------
UPDATE public.counsellors c SET active = false
  FROM public.branches b
 WHERE b.id = c.branch_id AND b.code <> 'PTA' AND c.active;

-- 3. new functions and triggers ---------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.set_lead_branch(uuid, uuid);
DROP FUNCTION IF EXISTS public.pick_counsellor(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.lead_ad_branch(uuid);
DROP TRIGGER IF EXISTS deal_default_branch ON public.deals;
DROP FUNCTION IF EXISTS public.deal_default_branch();
DROP TRIGGER IF EXISTS counsellor_default_branch ON public.counsellors;
DROP FUNCTION IF EXISTS public.counsellor_default_branch();
DROP TRIGGER IF EXISTS seed_account_branches ON public.accounts;
DROP FUNCTION IF EXISTS public.seed_account_branches();

-- 4. columns, then the table ------------------------------------------------------------------------------------------
DROP INDEX IF EXISTS public.counsellor_assignments_pool_turn;
ALTER TABLE public.counsellor_assignments DROP COLUMN IF EXISTS pool_branch_id;
ALTER TABLE public.ad_catalog DROP CONSTRAINT IF EXISTS ad_catalog_ad_account_id_check,
                              DROP CONSTRAINT IF EXISTS ad_catalog_source_check,
                              DROP COLUMN IF EXISTS branch_id, DROP COLUMN IF EXISTS ad_account_id, DROP COLUMN IF EXISTS source;
ALTER TABLE public.counsellors DROP COLUMN IF EXISTS branch_id;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS branch_id;
ALTER TABLE public.deals DROP COLUMN IF EXISTS branch_id;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS branch_id;
DROP FUNCTION IF EXISTS public.branch_id_for(uuid, text);
DROP TABLE IF EXISTS public.branches;
