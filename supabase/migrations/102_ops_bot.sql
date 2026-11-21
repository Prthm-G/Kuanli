-- 102_ops_bot.sql  (KB-OPSBOT, owner request 2026-11-21: "build me a system on telegram as well to do these things")
-- Pratham switches counsellors on/off and moves leads from his private chat with the Skeure Leads Bot. The n8n
-- workflow "Kuanli Ops Bot" hands every update of that bot to ops_bot() and sends back what it returns. Only the paired
-- chat is obeyed; everything else gets NULL (no reply), so counsellors keep using the join flow as before.
-- Every write is a preview first (ops_actions row, 10 minutes) and runs only on a Confirm tap; the row keeps what it
-- needs to undo. form_lead_counsellor(): form leads go to their configured counsellor while she is on, otherwise to
-- whoever the rotation picks next in her branch (owner decision 2026-11-21).
-- New objects only: no existing function, table or trigger changes. Independent of 099 and 101.
-- Apply with psql -1. Rollback: 102_rollback.sql.

-- 1. tables ------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ops_bot_owner (
  account_id      uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  chat_id         bigint,                 -- the paired private chat; NULL until /pair
  pair_code_hash  text CHECK (pair_code_hash ~ '^[0-9a-f]{64}$'),   -- sha256 of the one-time code, never the code
  pair_expires_at timestamptz,
  paired_at       timestamptz,
  ignored         integer NOT NULL DEFAULT 0,   -- updates from other chats, dropped
  ignored_last_at timestamptz
);
ALTER TABLE public.ops_bot_owner ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_bot_owner FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.ops_actions (
  id           bigserial PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('active', 'move')),
  params       jsonb NOT NULL,
  preview      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  cancelled_at timestamptz,
  applied_at   timestamptz,
  undo         jsonb,
  result       text,
  undone_at    timestamptz,
  undo_result  text
);
CREATE INDEX IF NOT EXISTS ops_actions_last_applied ON public.ops_actions (account_id, applied_at DESC) WHERE applied_at IS NOT NULL;
ALTER TABLE public.ops_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_actions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.ops_actions_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- 2. helpers -----------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_reply(p_chat bigint, p_text text, p_kind text DEFAULT 'plain', p_action bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('chat_id', p_chat, 'text', left(p_text, 3900), 'kind', p_kind, 'action_id', p_action))
$$;

-- One counsellor by display name (any case); NULL when none or more than one match. Returns the id, not the row, so
-- a later column on counsellors never breaks it.
CREATE OR REPLACE FUNCTION public.ops_counsellor_id(p_account uuid, p_name text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id FROM public.counsellors c
   WHERE c.account_id = p_account AND lower(c.display_name) = lower(btrim(p_name))
     AND (SELECT count(*) FROM public.counsellors x WHERE x.account_id = p_account AND lower(x.display_name) = lower(btrim(p_name))) = 1
$$;

CREATE OR REPLACE FUNCTION public.ops_names(p_account uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(string_agg(display_name, ', ' ORDER BY display_name), 'none') FROM public.counsellors WHERE account_id = p_account
$$;

-- Open leads a login owns: not counsellor-number-only, latest deal not Enrolled / Lost / Not Interested (or none).
-- p_since: only leads whose latest owner-log row naming this login is on/after p_since and came from the rotation
-- ('assignment:*') or a form lead ('form_lead'); a move, an admin's reassignment or a chat assign never counts as new.
-- NULL = all open leads.
CREATE OR REPLACE FUNCTION public.ops_open_leads(p_account uuid, p_profile uuid, p_since timestamptz)
RETURNS TABLE (contact_id uuid, stage text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT ct.id, coalesce(ps.name, '(no deal)')
    FROM public.contacts ct
    LEFT JOIN LATERAL (SELECT d.stage_id FROM public.deals d WHERE d.contact_id = ct.id ORDER BY d.updated_at DESC LIMIT 1) d ON true
    LEFT JOIN public.pipeline_stages ps ON ps.id = d.stage_id
   WHERE ct.account_id = p_account AND ct.owner_profile_id = p_profile AND NOT ct.counsellor_number_only
     AND (ps.name IS NULL OR ps.name NOT IN ('Enrolled', 'Lost', 'Not Interested'))
     AND (p_since IS NULL OR EXISTS (
           SELECT 1 FROM (SELECT l.via, l.at FROM public.contact_owner_log l
                           WHERE l.contact_id = ct.id AND l.new_owner = p_profile ORDER BY l.at DESC, l.id DESC LIMIT 1) x
            WHERE x.at >= p_since AND (x.via LIKE 'assignment:%' OR x.via = 'form_lead')))
$$;

-- The chats that move with a lead: ordinary numbers only (as set_contact_owner, 098), not already on p_to.
CREATE OR REPLACE FUNCTION public.ops_lead_chats(p_contacts uuid[], p_to uuid)
RETURNS TABLE (chat_id uuid, prev uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT cv.id, cv.assigned_agent_id FROM public.conversations cv
   WHERE cv.contact_id = ANY (p_contacts) AND cv.assigned_agent_id IS DISTINCT FROM p_to
     AND NOT coalesce(cv.phone_number_id = ANY (public.counsellor_phone_number_ids()), false)
$$;

-- 3. form leads follow who is on --------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.form_lead_counsellor(p_account uuid, p_default uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_c    public.counsellors%ROWTYPE;
  v_pick uuid;
BEGIN
  SELECT * INTO v_c FROM public.counsellors WHERE id = p_default AND account_id = p_account;
  IF NOT FOUND OR v_c.active THEN RETURN p_default; END IF;
  -- Whoever in her branch is on, has a login and got a lead longest ago (WhatsApp assignment in the branch pool or form
  -- lead): form leads write no counsellor_assignments row, so they are counted here or they would all go to one person.
  -- Nobody like that: the configured one keeps it (a form lead never goes to another branch or to nobody).
  SELECT c.id INTO v_pick FROM public.counsellors c
   WHERE c.account_id = p_account AND c.branch_id = v_c.branch_id AND c.active AND c.profile_id IS NOT NULL AND c.id <> v_c.id
   ORDER BY greatest((SELECT max(a.assigned_at) FROM public.counsellor_assignments a WHERE a.counsellor_id = c.id AND a.pool_branch_id = v_c.branch_id),
                     (SELECT max(f.assigned_at) FROM public.meta_form_leads f WHERE f.counsellor_id = c.id)) ASC NULLS FIRST, c.created_at, c.id
   LIMIT 1;
  RETURN coalesce(v_pick, p_default);
END $$;

-- 4. status ------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_status_text(p_account uuid, p_form_default uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_dummy constant uuid := '00000000-0000-4000-8000-000000000000';
  v_day  timestamptz := date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  v_out  text := 'Kuanli rotation, ' || to_char(now() AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST';
  v_next text := '';
  v_new  text;
  v_ign  integer;
  v_ign_at timestamptz;
  r      record;
BEGIN
  FOR r IN SELECT b.id, b.name, string_agg(c.display_name || CASE WHEN c.active THEN ' ON' ELSE ' off' END, ', '
                                           ORDER BY c.active DESC, c.created_at) AS who
             FROM public.branches b LEFT JOIN public.counsellors c ON c.branch_id = b.id AND c.account_id = b.account_id
            WHERE b.account_id = p_account AND b.active
            GROUP BY b.id, b.name, b.code ORDER BY (b.code = 'PTA') DESC, b.code LOOP
    v_out := v_out || E'\n' || r.name || ': ' || coalesce(r.who, 'nobody');
    v_next := v_next || E'\n' || r.name || ' ad -> ' || coalesce((SELECT c.display_name FROM public.pick_counsellor(p_account, v_dummy, r.id) k
                                                                   JOIN public.counsellors c ON c.id = k.counsellor_id), 'nobody');
  END LOOP;
  v_next := v_next || E'\nNo ad -> ' || coalesce((SELECT c.display_name FROM public.pick_counsellor(p_account, v_dummy, NULL) k
                                                  JOIN public.counsellors c ON c.id = k.counsellor_id), 'nobody');
  IF p_form_default IS NOT NULL THEN
    v_next := v_next || E'\nForm lead -> ' || coalesce((SELECT display_name FROM public.counsellors
                                                         WHERE id = public.form_lead_counsellor(p_account, p_form_default)), 'nobody');
  END IF;
  SELECT string_agg(x.display_name || ' ' || x.n, ', ' ORDER BY x.n DESC, x.display_name) INTO v_new
    FROM (SELECT c.display_name, count(DISTINCT l.contact_id) AS n FROM public.counsellors c
            LEFT JOIN public.contact_owner_log l ON l.new_owner = c.profile_id AND l.account_id = p_account
                                                AND l.at >= v_day AND (l.via LIKE 'assignment:%' OR l.via = 'form_lead')
           WHERE c.account_id = p_account AND c.profile_id IS NOT NULL GROUP BY c.id, c.display_name) x;
  v_out := v_out || E'\n\nNext lead:' || v_next || E'\n\nNew leads today: ' || coalesce(v_new, 'none');
  -- Strangers (and counsellors) who wrote to the bot: so a burned pairing code or odd traffic is visible.
  SELECT o.ignored, o.ignored_last_at INTO v_ign, v_ign_at FROM public.ops_bot_owner o WHERE o.account_id = p_account;
  IF coalesce(v_ign, 0) > 0 AND v_ign_at IS NOT NULL THEN
    v_out := v_out || E'\nOther chats that messaged the bot: ' || v_ign || ' (last ' || to_char(v_ign_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST)';
  END IF;
  RETURN v_out;
END $$;

-- 5. previews (each one a row in ops_actions, nothing else written) --------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_preview_active(p_account uuid, p_chat bigint, p_name text, p_on boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_c      public.counsellors%ROWTYPE;
  v_branch text;
  v_others text;
  v_text   text;
  v_id     bigint;
BEGIN
  IF coalesce(btrim(p_name), '') = '' THEN
    RETURN public.ops_reply(p_chat, 'Who? e.g. /' || CASE WHEN p_on THEN 'on' ELSE 'off' END || ' ' || split_part(public.ops_names(p_account), ', ', 1));
  END IF;
  SELECT * INTO v_c FROM public.counsellors WHERE id = public.ops_counsellor_id(p_account, p_name);
  IF v_c.id IS NULL THEN
    RETURN public.ops_reply(p_chat, 'No counsellor called ' || left(p_name, 30) || '. Counsellors: ' || public.ops_names(p_account) || '.');
  END IF;
  SELECT name INTO v_branch FROM public.branches WHERE id = v_c.branch_id;
  IF v_c.active = p_on THEN
    RETURN public.ops_reply(p_chat, v_c.display_name || ' is already ' || CASE WHEN p_on THEN 'on' ELSE 'off' END || '. Nothing to do.');
  END IF;
  IF p_on AND v_c.telegram_chat_id IS NULL THEN
    RETURN public.ops_reply(p_chat, v_c.display_name || ' has not joined Telegram yet, so lead pings would reach nobody. Not turned on.');
  END IF;
  IF p_on AND v_c.profile_id IS NULL THEN
    RETURN public.ops_reply(p_chat, v_c.display_name || ' has no Kuanli login, so leads would have no owner. Not turned on.');
  END IF;
  SELECT string_agg(display_name, ', ' ORDER BY created_at) INTO v_others FROM public.counsellors
   WHERE account_id = p_account AND branch_id = v_c.branch_id AND active AND id <> v_c.id;
  v_text := 'Turn ' || v_c.display_name || ' ' || CASE WHEN p_on THEN 'ON' ELSE 'OFF' END || ' (' || coalesce(v_branch, '?') || ')?'
    || E'\n' || coalesce(v_branch, '?') || ' would have on: '
    || CASE WHEN p_on THEN coalesce(v_others || ', ', '') || v_c.display_name ELSE coalesce(v_others, 'NOBODY') END;
  IF NOT p_on AND v_others IS NULL THEN
    v_text := v_text || E'\nWarning: ' || coalesce(v_branch, 'this branch') || ' ad leads would then rotate over every counsellor who is on.';
  END IF;
  INSERT INTO public.ops_actions (account_id, kind, params, preview, expires_at)
  VALUES (p_account, 'active', jsonb_build_object('counsellor_id', v_c.id, 'name', v_c.display_name, 'on', p_on), v_text, now() + interval '10 minutes')
  RETURNING id INTO v_id;
  RETURN public.ops_reply(p_chat, v_text, 'confirm', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.ops_preview_move(p_account uuid, p_chat bigint, p_from text, p_to text, p_scope text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_from   public.counsellors%ROWTYPE;
  v_to     public.counsellors%ROWTYPE;
  v_scope  text := lower(coalesce(nullif(btrim(p_scope), ''), 'today'));
  v_today  date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_since  timestamptz;
  v_label  text;
  v_ids    uuid[];
  v_stages text;
  v_chats  integer;
  v_text   text;
  v_id     bigint;
BEGIN
  IF coalesce(btrim(p_from), '') = '' OR coalesce(btrim(p_to), '') = '' THEN
    RETURN public.ops_reply(p_chat, 'Usage: /move <from> <to> [today|yesterday|all|YYYY-MM-DD]' || E'\ne.g. /move Jaspreet Aman yesterday');
  END IF;
  SELECT * INTO v_from FROM public.counsellors WHERE id = public.ops_counsellor_id(p_account, p_from);
  SELECT * INTO v_to FROM public.counsellors WHERE id = public.ops_counsellor_id(p_account, p_to);
  IF v_from.id IS NULL OR v_to.id IS NULL THEN
    RETURN public.ops_reply(p_chat, 'No counsellor called ' || left(CASE WHEN v_from.id IS NULL THEN p_from ELSE p_to END, 30)
      || '. Counsellors: ' || public.ops_names(p_account) || '.');
  END IF;
  IF v_from.id = v_to.id THEN RETURN public.ops_reply(p_chat, 'From and to are the same counsellor.'); END IF;
  IF v_from.profile_id IS NULL THEN RETURN public.ops_reply(p_chat, v_from.display_name || ' has no Kuanli login, so owns no leads.'); END IF;
  IF v_to.profile_id IS NULL THEN RETURN public.ops_reply(p_chat, v_to.display_name || ' has no Kuanli login, so cannot own leads.'); END IF;
  IF NOT v_to.active THEN
    RETURN public.ops_reply(p_chat, v_to.display_name || ' is off. Turn them on first: /on ' || v_to.display_name);
  END IF;
  IF v_from.branch_id IS DISTINCT FROM v_to.branch_id THEN
    RETURN public.ops_reply(p_chat, v_from.display_name || ' and ' || v_to.display_name || ' are in different branches. The bot only moves leads inside a branch.');
  END IF;
  IF v_scope = 'all' THEN v_since := NULL; v_label := 'all open';
  ELSIF v_scope = 'today' THEN v_since := v_today::timestamp AT TIME ZONE 'Asia/Kolkata'; v_label := 'new today';
  ELSIF v_scope = 'yesterday' THEN v_since := (v_today - 1)::timestamp AT TIME ZONE 'Asia/Kolkata'; v_label := 'new since yesterday';
  ELSIF v_scope ~ '^\d{4}-\d{2}-\d{2}$' THEN
    BEGIN
      v_since := v_scope::date::timestamp AT TIME ZONE 'Asia/Kolkata';
    EXCEPTION WHEN others THEN
      RETURN public.ops_reply(p_chat, 'Not a date: ' || v_scope || '. Use today, yesterday, all or YYYY-MM-DD.');
    END;
    IF v_since > now() THEN RETURN public.ops_reply(p_chat, 'That date is in the future.'); END IF;
    v_label := 'new since ' || to_char(v_scope::date, 'DD Mon');
  ELSE
    RETURN public.ops_reply(p_chat, 'Scope must be today, yesterday, all or YYYY-MM-DD (not ' || left(v_scope, 20) || ').');
  END IF;

  SELECT array_agg(o.contact_id ORDER BY o.contact_id) INTO v_ids FROM public.ops_open_leads(p_account, v_from.profile_id, v_since) o;
  IF v_ids IS NULL THEN
    RETURN public.ops_reply(p_chat, 'Nothing to move: ' || v_from.display_name || ' has no open leads (' || v_label || ').');
  END IF;
  SELECT string_agg(s.stage || ' ' || s.n, ', ' ORDER BY s.n DESC, s.stage) INTO v_stages
    FROM (SELECT o.stage, count(*) AS n FROM public.ops_open_leads(p_account, v_from.profile_id, v_since) o GROUP BY o.stage) s;
  SELECT count(*) INTO v_chats FROM public.ops_lead_chats(v_ids, v_to.profile_id);
  v_text := 'Move ' || cardinality(v_ids) || ' lead' || CASE WHEN cardinality(v_ids) = 1 THEN '' ELSE 's' END || ' (' || v_label
    || ') from ' || v_from.display_name || ' to ' || v_to.display_name || '?'
    || E'\nBy stage: ' || v_stages || E'\nTheir chats that move: ' || v_chats
    || E'\nOnly open leads; counsellor-number chats stay. No pings.';
  INSERT INTO public.ops_actions (account_id, kind, params, preview, expires_at)
  VALUES (p_account, 'move', jsonb_build_object('from_id', v_from.id, 'from_profile', v_from.profile_id, 'from', v_from.display_name,
            'to_id', v_to.id, 'to_profile', v_to.profile_id, 'to', v_to.display_name, 'scope', v_label, 'since', v_since,
            'leads', to_jsonb(v_ids)), v_text, now() + interval '10 minutes')
  RETURNING id INTO v_id;
  RETURN public.ops_reply(p_chat, v_text, 'confirm', v_id);
END $$;

-- 6. taps: ok (apply), no (cancel), undo ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_apply(p_account uuid, p_chat bigint, p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a       public.ops_actions%ROWTYPE;
  v_c     public.counsellors%ROWTYPE;
  v_to    public.counsellors%ROWTYPE;
  v_on    boolean;
  v_from  uuid;
  v_top   uuid;
  v_ids   uuid[];
  v_chats jsonb;
  v_got   integer;
  v_left  integer;
  v_text  text;
  v_br    text;
BEGIN
  SELECT * INTO a FROM public.ops_actions WHERE id = p_id AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN public.ops_reply(p_chat, 'That action is not here any more.'); END IF;
  IF a.applied_at IS NOT NULL THEN RETURN public.ops_reply(p_chat, 'Already done. ' || coalesce(a.result, '')); END IF;
  IF a.cancelled_at IS NOT NULL THEN RETURN public.ops_reply(p_chat, 'That was cancelled. Send the command again.'); END IF;
  IF a.expires_at < now() THEN RETURN public.ops_reply(p_chat, 'That preview expired (10 minutes). Send the command again.'); END IF;

  IF a.kind = 'active' THEN
    v_on := (a.params->>'on')::boolean;
    SELECT * INTO v_c FROM public.counsellors WHERE id = (a.params->>'counsellor_id')::uuid AND account_id = p_account FOR UPDATE;
    IF NOT FOUND THEN RETURN public.ops_reply(p_chat, 'That counsellor is gone. Nothing changed.'); END IF;
    IF v_on AND (v_c.telegram_chat_id IS NULL OR v_c.profile_id IS NULL) THEN
      RETURN public.ops_reply(p_chat, v_c.display_name || ' cannot be turned on (no Telegram or no login). Nothing changed.');
    END IF;
    UPDATE public.counsellors SET active = v_on WHERE id = v_c.id;
    SELECT name INTO v_br FROM public.branches WHERE id = v_c.branch_id;
    v_text := 'Done: ' || v_c.display_name || ' is ' || CASE WHEN v_on THEN 'ON' ELSE 'OFF' END || '. ' || coalesce(v_br, '?') || ' on now: '
      || coalesce((SELECT string_agg(display_name, ', ' ORDER BY created_at) FROM public.counsellors
                    WHERE account_id = p_account AND branch_id = v_c.branch_id AND active), 'nobody') || '.';
    UPDATE public.ops_actions SET applied_at = now(), undo = jsonb_build_object('counsellor_id', v_c.id, 'was', v_c.active, 'set', v_on), result = v_text
     WHERE id = a.id;
    RETURN public.ops_reply(p_chat, v_text, 'undo', a.id);
  END IF;

  -- move: exactly the previewed leads that are still the sender's and still open
  v_from := (a.params->>'from_profile')::uuid;
  v_top := (a.params->>'to_profile')::uuid;
  SELECT * INTO v_to FROM public.counsellors WHERE id = (a.params->>'to_id')::uuid AND account_id = p_account;
  IF NOT FOUND OR NOT v_to.active OR v_to.profile_id IS DISTINCT FROM v_top THEN
    RETURN public.ops_reply(p_chat, coalesce(a.params->>'to', 'The receiver') || ' is no longer on (or changed login). Nothing moved.');
  END IF;
  -- Lock the previewed leads (id order, so two writers never deadlock), then decide: this next statement sees anything
  -- an admin or the webhook committed meanwhile.
  PERFORM 1 FROM public.contacts WHERE id IN (SELECT (jsonb_array_elements_text(a.params->'leads'))::uuid) ORDER BY id FOR UPDATE;
  SELECT array_agg(o.contact_id ORDER BY o.contact_id) INTO v_ids
    FROM public.ops_open_leads(p_account, v_from, NULL) o
   WHERE o.contact_id IN (SELECT (jsonb_array_elements_text(a.params->'leads'))::uuid);
  IF v_ids IS NULL THEN
    UPDATE public.ops_actions SET cancelled_at = now(), result = 'nothing left to move' WHERE id = a.id;
    RETURN public.ops_reply(p_chat, 'None of those leads are still ' || (a.params->>'from') || '''s and open. Nothing moved.');
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.chat_id, 'prev', x.prev) ORDER BY x.chat_id), '[]'::jsonb) INTO v_chats
    FROM public.ops_lead_chats(v_ids, v_top) x;
  -- Owners first, then chats, so the chat trigger (098) finds the owner already set (as the lead-move script).
  PERFORM public.set_owner_trusted(ct.id, v_top, 'manual_reassign_ops', false)
     FROM public.contacts ct WHERE ct.id = ANY (v_ids) AND ct.owner_profile_id = v_from;
  UPDATE public.conversations SET assigned_agent_id = v_top, updated_at = now()
   WHERE id IN (SELECT (e->>'id')::uuid FROM jsonb_array_elements(v_chats) e) AND assigned_agent_id IS DISTINCT FROM v_top;
  SELECT count(*) INTO v_got FROM public.contacts WHERE id = ANY (v_ids) AND owner_profile_id = v_top;
  SELECT count(*) INTO v_left FROM public.ops_lead_chats(v_ids, v_top);
  IF v_got <> cardinality(v_ids) OR v_left <> 0 THEN
    RAISE EXCEPTION 'move check failed: % of % leads moved, % chats not moved', v_got, cardinality(v_ids), v_left;
  END IF;
  v_text := 'Done: ' || v_got || ' lead' || CASE WHEN v_got = 1 THEN '' ELSE 's' END || ' and ' || jsonb_array_length(v_chats)
    || ' chat' || CASE WHEN jsonb_array_length(v_chats) = 1 THEN '' ELSE 's' END || ' moved from ' || (a.params->>'from') || ' to ' || (a.params->>'to') || '.'
    || CASE WHEN v_got < jsonb_array_length(a.params->'leads')
            THEN ' ' || (jsonb_array_length(a.params->'leads') - v_got) || ' had changed since the preview and were left alone.' ELSE '' END;
  UPDATE public.ops_actions SET applied_at = now(), undo = jsonb_build_object('leads', to_jsonb(v_ids), 'chats', v_chats), result = v_text
   WHERE id = a.id;
  RETURN public.ops_reply(p_chat, v_text, 'undo', a.id);
END $$;

CREATE OR REPLACE FUNCTION public.ops_cancel(p_account uuid, p_chat bigint, p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.ops_actions%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.ops_actions WHERE id = p_id AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN public.ops_reply(p_chat, 'That action is not here any more.'); END IF;
  IF a.applied_at IS NOT NULL THEN RETURN public.ops_reply(p_chat, 'Already done. Use /undo to reverse it.'); END IF;
  IF a.cancelled_at IS NULL THEN UPDATE public.ops_actions SET cancelled_at = now() WHERE id = a.id; END IF;
  RETURN public.ops_reply(p_chat, 'Cancelled. Nothing changed.');
END $$;

-- p_do false: show what the Undo button would reverse (the /undo command); true: reverse it (the button).
CREATE OR REPLACE FUNCTION public.ops_undo(p_account uuid, p_chat bigint, p_id bigint, p_do boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a      public.ops_actions%ROWTYPE;
  v_c    public.counsellors%ROWTYPE;
  v_was  boolean;
  v_back uuid[];
  v_n    integer := 0;
  v_m    integer := 0;
  v_text text;
BEGIN
  IF p_id IS NULL THEN
    SELECT * INTO a FROM public.ops_actions WHERE account_id = p_account AND applied_at IS NOT NULL AND undone_at IS NULL
     ORDER BY applied_at DESC, id DESC LIMIT 1;
    IF NOT FOUND THEN RETURN public.ops_reply(p_chat, 'Nothing to undo.'); END IF;
  ELSE
    SELECT * INTO a FROM public.ops_actions WHERE id = p_id AND account_id = p_account FOR UPDATE;
    IF NOT FOUND THEN RETURN public.ops_reply(p_chat, 'That action is not here any more.'); END IF;
  END IF;
  IF a.applied_at IS NULL THEN RETURN public.ops_reply(p_chat, 'That was never done, so there is nothing to undo.'); END IF;
  IF a.undone_at IS NOT NULL THEN RETURN public.ops_reply(p_chat, 'Already undone. ' || coalesce(a.undo_result, '')); END IF;
  IF NOT p_do THEN
    RETURN public.ops_reply(p_chat, 'Undo this? ' || a.result || E'\n(done ' || to_char(a.applied_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST)', 'undo', a.id);
  END IF;

  IF a.kind = 'active' THEN
    -- Only if nobody changed that switch since (an old Undo button never overrides a newer change), and never turns on
    -- someone who has since lost Telegram or their login.
    v_was := (a.undo->>'was')::boolean;
    SELECT * INTO v_c FROM public.counsellors WHERE id = (a.undo->>'counsellor_id')::uuid AND account_id = p_account FOR UPDATE;
    IF NOT FOUND THEN RETURN public.ops_reply(p_chat, 'That counsellor is gone. Nothing changed.'); END IF;
    IF v_c.active IS DISTINCT FROM (a.undo->>'set')::boolean THEN
      RETURN public.ops_reply(p_chat, v_c.display_name || ' was switched since (now ' || CASE WHEN v_c.active THEN 'ON' ELSE 'OFF' END
        || '). Not undone: use /on or /off.');
    END IF;
    IF v_was AND (v_c.telegram_chat_id IS NULL OR v_c.profile_id IS NULL) THEN
      RETURN public.ops_reply(p_chat, v_c.display_name || ' cannot be turned on any more (no Telegram or no login). Not undone.');
    END IF;
    UPDATE public.counsellors SET active = v_was WHERE id = v_c.id;
    v_text := 'Undone: ' || v_c.display_name || ' is ' || CASE WHEN v_was THEN 'ON' ELSE 'OFF' END || ' again.';
  ELSE
    -- Only leads still exactly as this move left them go back: still the receiver's, still open, and the receiver got
    -- them from this move (latest owner-log row is this action's). Anything changed since stays.
    PERFORM 1 FROM public.contacts WHERE id IN (SELECT (jsonb_array_elements_text(a.undo->'leads'))::uuid) ORDER BY id FOR UPDATE;
    SELECT coalesce(array_agg(o.contact_id), '{}') INTO v_back
      FROM public.ops_open_leads(p_account, (a.params->>'to_profile')::uuid, NULL) o
     WHERE o.contact_id IN (SELECT (jsonb_array_elements_text(a.undo->'leads'))::uuid)
       AND EXISTS (SELECT 1 FROM (SELECT l.via, l.at FROM public.contact_owner_log l WHERE l.contact_id = o.contact_id
                                   ORDER BY l.at DESC, l.id DESC LIMIT 1) x
                    WHERE x.via = 'manual_reassign_ops' AND x.at = a.applied_at);
    -- The call sits in the select list, so it runs only for rows that passed the WHERE (never in a WHERE: no order).
    SELECT count(*) FILTER (WHERE public.set_owner_trusted(ct.id, (a.params->>'from_profile')::uuid, 'manual_reassign_ops_undo', false))
      INTO v_n FROM public.contacts ct WHERE ct.id = ANY (v_back);
    -- A chat goes back only with its lead: a lead that changed hands keeps its chats where they are.
    WITH back AS (
      UPDATE public.conversations cv SET assigned_agent_id = (e->>'prev')::uuid, updated_at = now()
        FROM jsonb_array_elements(a.undo->'chats') e
       WHERE cv.id = (e->>'id')::uuid AND cv.assigned_agent_id = (a.params->>'to_profile')::uuid
         AND EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = cv.contact_id AND ct.owner_profile_id = (a.params->>'from_profile')::uuid)
      RETURNING cv.id)
    SELECT count(*) INTO v_m FROM back;
    v_text := 'Undone: ' || v_n || ' of ' || jsonb_array_length(a.undo->'leads') || ' leads and ' || v_m || ' of '
      || jsonb_array_length(a.undo->'chats') || ' chats back with ' || (a.params->>'from') || '.'
      || CASE WHEN v_n < jsonb_array_length(a.undo->'leads') THEN ' The rest had changed since and stay as they are.' ELSE '' END;
  END IF;
  UPDATE public.ops_actions SET undone_at = now(), undo_result = v_text WHERE id = a.id;
  RETURN public.ops_reply(p_chat, v_text);
END $$;

-- 7. pairing (the apply script's --pair, as the database owner; nobody else can call it) -------------------------------
CREATE OR REPLACE FUNCTION public.ops_pair_start(p_account uuid, p_code_hash text, p_reset boolean)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_chat bigint;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'pair code hash must be sha256 hex' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account) THEN RAISE EXCEPTION 'no such account' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.ops_bot_owner (account_id) VALUES (p_account) ON CONFLICT (account_id) DO NOTHING;
  SELECT chat_id INTO v_chat FROM public.ops_bot_owner WHERE account_id = p_account FOR UPDATE;
  IF v_chat IS NOT NULL AND NOT coalesce(p_reset, false) THEN RETURN 'already paired'; END IF;
  UPDATE public.ops_bot_owner SET chat_id = NULL, paired_at = NULL, pair_code_hash = p_code_hash, pair_expires_at = now() + interval '30 minutes'
   WHERE account_id = p_account;
  RETURN 'ok';
END $$;

-- 8. the bot -----------------------------------------------------------------------------------------------------------
-- p_update: the Telegram update as the bot received it. Returns NULL (no reply) or
-- {chat_id, text, kind: plain|confirm|undo, action_id?, callback_id?}; n8n answers the tap when callback_id is set.
CREATE OR REPLACE FUNCTION public.ops_bot(p_account uuid, p_form_default uuid, p_update jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_owner public.ops_bot_owner%ROWTYPE;
  v_chat  bigint;
  v_text  text;
  v_cbid  text;
  v_data  text;
  v_cmd   text;
  v_args  text[];
  v_m     text[];
  v_r     jsonb;
  v_help  constant text := 'Kuanli ops commands:'
    || E'\n/status - who is on, who gets the next lead'
    || E'\n/off Jaspreet - take a counsellor out of the rotation'
    || E'\n/on Aman - put a counsellor back in'
    || E'\n/move Jaspreet Aman yesterday - move open leads (today | yesterday | all | YYYY-MM-DD)'
    || E'\n/undo - reverse the last change'
    || E'\nEvery change waits for your Confirm tap.';
BEGIN
  -- Who sent it. Only private chats; a tap must come from the chat it was sent to.
  BEGIN
    IF jsonb_typeof(p_update->'message') = 'object' AND p_update#>>'{message,chat,type}' = 'private' THEN
      v_chat := (p_update#>>'{message,chat,id}')::bigint;
      v_text := left(btrim(regexp_replace(coalesce(p_update#>>'{message,text}', ''), '\s+', ' ', 'g')), 300);
    ELSIF jsonb_typeof(p_update->'callback_query') = 'object' AND p_update#>>'{callback_query,message,chat,type}' = 'private'
          AND p_update#>>'{callback_query,from,id}' = p_update#>>'{callback_query,message,chat,id}' THEN
      v_chat := (p_update#>>'{callback_query,message,chat,id}')::bigint;
      v_cbid := left(p_update#>>'{callback_query,id}', 100);
      v_data := left(coalesce(p_update#>>'{callback_query,data}', ''), 64);
    END IF;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF v_chat IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO v_owner FROM public.ops_bot_owner WHERE account_id = p_account;
  IF NOT FOUND THEN RETURN NULL; END IF;   -- pairing never started: the bot stays silent for everyone

  IF v_owner.chat_id IS DISTINCT FROM v_chat THEN
    v_m := regexp_match(coalesce(v_text, ''), '^/pair(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9]{6,40})$');
    IF v_cbid IS NULL AND v_m IS NOT NULL AND v_owner.chat_id IS NULL AND v_owner.pair_code_hash IS NOT NULL THEN
      SELECT * INTO v_owner FROM public.ops_bot_owner WHERE account_id = p_account FOR UPDATE;   -- re-read under the lock
      IF v_owner.chat_id IS NULL AND v_owner.pair_expires_at > now() AND v_owner.pair_code_hash = encode(sha256(convert_to(upper(v_m[1]), 'UTF8')), 'hex') THEN
        UPDATE public.ops_bot_owner SET chat_id = v_chat, paired_at = now(), pair_code_hash = NULL, pair_expires_at = NULL
         WHERE account_id = p_account;
        RETURN public.ops_reply(v_chat, E'Paired. This chat now runs the Kuanli ops commands.\n\n' || v_help);
      END IF;
      -- One try per code: a wrong or late code burns it (run --pair again).
      UPDATE public.ops_bot_owner SET pair_code_hash = NULL, pair_expires_at = NULL, ignored = ignored + 1, ignored_last_at = now()
       WHERE account_id = p_account;
      RETURN public.ops_reply(v_chat, 'That code is not valid or has expired. Run the --pair command again for a new one.');
    END IF;
    UPDATE public.ops_bot_owner SET ignored = ignored + 1, ignored_last_at = now() WHERE account_id = p_account;
    RETURN NULL;
  END IF;

  -- The owner: one call at a time. Any failure rolls back this call's writes and is reported, never half-done.
  PERFORM 1 FROM public.ops_bot_owner WHERE account_id = p_account FOR UPDATE;
  BEGIN
    IF v_cbid IS NOT NULL THEN
      v_m := regexp_match(v_data, '^(ok|no|undo):([0-9]{1,18})$');
      IF v_m IS NULL THEN v_r := public.ops_reply(v_chat, 'Unknown button.');
      ELSIF v_m[1] = 'ok' THEN v_r := public.ops_apply(p_account, v_chat, v_m[2]::bigint);
      ELSIF v_m[1] = 'no' THEN v_r := public.ops_cancel(p_account, v_chat, v_m[2]::bigint);
      ELSE v_r := public.ops_undo(p_account, v_chat, v_m[2]::bigint, true);
      END IF;
      RETURN v_r || jsonb_build_object('callback_id', v_cbid);
    END IF;
    v_cmd := lower(regexp_replace(split_part(v_text, ' ', 1), '@[A-Za-z0-9_]+$', ''));
    v_args := array_remove(regexp_split_to_array(btrim(substr(v_text, length(split_part(v_text, ' ', 1)) + 1)), '\s+'), '');
    v_r := CASE v_cmd
      WHEN '/status' THEN public.ops_reply(v_chat, public.ops_status_text(p_account, p_form_default))
      WHEN '/on'     THEN public.ops_preview_active(p_account, v_chat, v_args[1], true)
      WHEN '/off'    THEN public.ops_preview_active(p_account, v_chat, v_args[1], false)
      WHEN '/move'   THEN public.ops_preview_move(p_account, v_chat, v_args[1], v_args[2], v_args[3])
      WHEN '/undo'   THEN public.ops_undo(p_account, v_chat, NULL, false)
      WHEN '/pair'   THEN public.ops_reply(v_chat, 'This chat is already paired.')
      ELSE public.ops_reply(v_chat, CASE WHEN v_cmd LIKE '/%' AND v_cmd NOT IN ('/help', '/start', '/ops') THEN E'Unknown command.\n\n' ELSE '' END || v_help)
    END;
    RETURN v_r;
  EXCEPTION WHEN others THEN
    RAISE LOG 'ops_bot failed (%): %', SQLSTATE, SQLERRM;
    RETURN public.ops_reply(v_chat, 'Something went wrong, nothing changed (error ' || SQLSTATE || '). The details are in the database log.')
           || CASE WHEN v_cbid IS NOT NULL THEN jsonb_build_object('callback_id', v_cbid) ELSE '{}'::jsonb END;
  END;
END $$;

-- 9. who may call what ---------------------------------------------------------------------------------------------------
-- Supabase's default privileges open new functions to anon/authenticated: close every one. Only ops_bot (n8n's
-- "Kuanli Ops Bot") and form_lead_counsellor (n8n's "Skeure Form Leads") are callable, by service_role. Everything else
-- runs only inside them, or as the database owner (ops_pair_start, ops_status_text from the apply script).
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND (p.proname LIKE 'ops\_%' OR p.proname = 'form_lead_counsellor') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.ops_bot(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.form_lead_counsellor(uuid, uuid) TO service_role;
