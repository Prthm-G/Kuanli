-- 097_branches.sql  (KB-BRANCHES-R1)
-- Branches on one Kuanli account: Patiala (PTA, everything that exists today) and Mohali (MOH).
-- Owner decisions 2026-11-12/13: a lead's branch comes from the ad it clicked (ad account -> branch, stored on
-- ad_catalog). A Patiala ad lead goes to the Patiala rotation, a Mohali ad lead to the Mohali rotation, and a lead with
-- no ad (organic, or an ad chat that came without a referral) alternates across every active counsellor. The lead's
-- branch is then the branch of the counsellor who got it. No city question, no n8n change: the three rotation
-- functions keep their signatures and outputs.
--
-- 1. branches (+ a trigger that seeds PTA and MOH for every new account).
-- 2. branch_id on contacts, deals, counsellors (NOT NULL; defaults to the account's PTA), profiles, ad_catalog
--    (+ ad_account_id, source); counsellor_assignments.pool_branch_id (which pool's turn an assignment used).
-- 3. Backfill: every existing row is Patiala. Runs with session_replication_role = replica so updated_at and the
--    other row triggers do not fire on tens of thousands of rows (no Realtime or wal2json flood).
-- 4. lead_ad_branch(conv), pick_counsellor(account, contact, branch): sticky, then the ad branch's pool, then the
--    all-branch pool. Each pool keeps its own turn order (latest assignment IN THAT POOL), so no-ad leads are a true
--    round robin across both branches however busy one branch's ads are.
-- 5. assign_counsellor (081), assign_counsellor_silent (090), assign_counsellor_unanswered (087): same signatures,
--    outputs, re-checks and side effects; only the rotation block changes, and a new contact takes the branch of the
--    counsellor who got it (its deals follow).
-- Seed data (ad ids, ad accounts) is written by devtools/apply-kuanli-branches-097.mjs, not here: this repo is public.
-- Run with psql -1. Rollback: 097_rollback.sql.

SET LOCAL lock_timeout = '5s';

-- 1. branches ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.branches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  code            text NOT NULL CHECK (code ~ '^[A-Z]{2,5}$'),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  capi_dataset_id text CHECK (capi_dataset_id ~ '^[0-9]{6,20}$'),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, code),
  UNIQUE (account_id, id)
);
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS branches_read ON public.branches;
CREATE POLICY branches_read ON public.branches FOR SELECT TO authenticated
  USING (public.is_account_member(account_id));
REVOKE ALL ON public.branches FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.branches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.branches TO service_role;

INSERT INTO public.branches (account_id, code, name)
SELECT a.id, b.code, b.name
  FROM public.accounts a CROSS JOIN (VALUES ('PTA', 'Patiala'), ('MOH', 'Mohali')) b(code, name)
ON CONFLICT (account_id, code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.seed_account_branches()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.branches (account_id, code, name)
  VALUES (NEW.id, 'PTA', 'Patiala'), (NEW.id, 'MOH', 'Mohali')
  ON CONFLICT (account_id, code) DO NOTHING;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.seed_account_branches() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS seed_account_branches ON public.accounts;
CREATE TRIGGER seed_account_branches AFTER INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.seed_account_branches();

CREATE OR REPLACE FUNCTION public.branch_id_for(p_account uuid, p_code text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT b.id FROM public.branches b WHERE b.account_id = p_account AND b.code = p_code $$;
REVOKE ALL ON FUNCTION public.branch_id_for(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.branch_id_for(uuid, text) TO service_role;

-- 2. branch columns ---------------------------------------------------------------------------------------------------
-- Composite keys keep a row's branch inside its own account. ON DELETE SET NULL (branch_id) clears only the branch.
ALTER TABLE public.contacts    ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.deals       ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.profiles    ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.counsellors ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.ad_catalog  ADD COLUMN IF NOT EXISTS branch_id uuid,
                               ADD COLUMN IF NOT EXISTS ad_account_id text,
                               ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.counsellor_assignments ADD COLUMN IF NOT EXISTS pool_branch_id uuid;

ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_branch_fk;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_branch_fk FOREIGN KEY (account_id, branch_id)
  REFERENCES public.branches (account_id, id) ON DELETE SET NULL (branch_id);
ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_branch_fk;
ALTER TABLE public.deals ADD CONSTRAINT deals_branch_fk FOREIGN KEY (account_id, branch_id)
  REFERENCES public.branches (account_id, id) ON DELETE SET NULL (branch_id);
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_branch_fk;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_branch_fk FOREIGN KEY (account_id, branch_id)
  REFERENCES public.branches (account_id, id) ON DELETE SET NULL (branch_id);
ALTER TABLE public.counsellors DROP CONSTRAINT IF EXISTS counsellors_branch_fk;
ALTER TABLE public.counsellors ADD CONSTRAINT counsellors_branch_fk FOREIGN KEY (account_id, branch_id)
  REFERENCES public.branches (account_id, id) ON DELETE RESTRICT;
ALTER TABLE public.ad_catalog DROP CONSTRAINT IF EXISTS ad_catalog_branch_fk;
ALTER TABLE public.ad_catalog ADD CONSTRAINT ad_catalog_branch_fk FOREIGN KEY (account_id, branch_id)
  REFERENCES public.branches (account_id, id) ON DELETE SET NULL (branch_id);
ALTER TABLE public.counsellor_assignments DROP CONSTRAINT IF EXISTS counsellor_assignments_pool_fk;
ALTER TABLE public.counsellor_assignments ADD CONSTRAINT counsellor_assignments_pool_fk FOREIGN KEY (account_id, pool_branch_id)
  REFERENCES public.branches (account_id, id) ON DELETE SET NULL (pool_branch_id);
ALTER TABLE public.ad_catalog DROP CONSTRAINT IF EXISTS ad_catalog_ad_account_id_check;
ALTER TABLE public.ad_catalog ADD CONSTRAINT ad_catalog_ad_account_id_check CHECK (ad_account_id ~ '^[0-9]{6,20}$');
ALTER TABLE public.ad_catalog DROP CONSTRAINT IF EXISTS ad_catalog_source_check;
ALTER TABLE public.ad_catalog ADD CONSTRAINT ad_catalog_source_check CHECK (length(source) <= 80);

-- A counsellor added without a branch (the SP3b script, older tests) joins the account's Patiala rotation.
CREATE OR REPLACE FUNCTION public.counsellor_default_branch()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.branch_id IS NULL THEN
    NEW.branch_id := public.branch_id_for(NEW.account_id, 'PTA');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.counsellor_default_branch() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS counsellor_default_branch ON public.counsellors;
CREATE TRIGGER counsellor_default_branch BEFORE INSERT ON public.counsellors
  FOR EACH ROW EXECUTE FUNCTION public.counsellor_default_branch();

-- A new deal takes its contact's branch.
CREATE OR REPLACE FUNCTION public.deal_default_branch()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.branch_id IS NULL AND NEW.contact_id IS NOT NULL THEN
    SELECT ct.branch_id INTO NEW.branch_id FROM public.contacts ct
     WHERE ct.id = NEW.contact_id AND ct.account_id = NEW.account_id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.deal_default_branch() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS deal_default_branch ON public.deals;
CREATE TRIGGER deal_default_branch BEFORE INSERT ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deal_default_branch();

-- 3. backfill: everything that exists today is Patiala -----------------------------------------------------------------
-- Owner and admin profiles stay NULL (all branches); counsellors' profiles get Patiala.
SET LOCAL session_replication_role = replica;   -- no updated_at, no row triggers; FKs were validated above (all NULL)
UPDATE public.contacts x SET branch_id = b.id FROM public.branches b
 WHERE b.account_id = x.account_id AND b.code = 'PTA' AND x.branch_id IS NULL;
UPDATE public.deals x SET branch_id = b.id FROM public.branches b
 WHERE b.account_id = x.account_id AND b.code = 'PTA' AND x.branch_id IS NULL;
UPDATE public.counsellors x SET branch_id = b.id FROM public.branches b
 WHERE b.account_id = x.account_id AND b.code = 'PTA' AND x.branch_id IS NULL;
UPDATE public.ad_catalog x SET branch_id = b.id FROM public.branches b
 WHERE b.account_id = x.account_id AND b.code = 'PTA' AND x.branch_id IS NULL;
UPDATE public.profiles x SET branch_id = b.id FROM public.branches b
 WHERE b.account_id = x.account_id AND b.code = 'PTA' AND x.branch_id IS NULL
   AND x.account_role NOT IN ('owner', 'admin')
   AND EXISTS (SELECT 1 FROM public.counsellors c WHERE c.profile_id = x.id);
-- Past assignments: the pool their lead would be in now (ad branch, else the all-branch pool).
UPDATE public.counsellor_assignments a SET pool_branch_id = ad.branch_id
  FROM public.conversations cv JOIN public.ad_catalog ad ON ad.ad_id = cv.ad_source_id AND ad.account_id = cv.account_id
 WHERE cv.id = a.conversation_id AND a.pool_branch_id IS NULL;
SET LOCAL session_replication_role = origin;

ALTER TABLE public.counsellors ALTER COLUMN branch_id SET NOT NULL;

-- The composite keys need these anyway; the pool index serves pick_counsellor's per-pool turn order.
CREATE INDEX IF NOT EXISTS contacts_account_branch ON public.contacts (account_id, branch_id);
CREATE INDEX IF NOT EXISTS deals_account_branch ON public.deals (account_id, branch_id);
CREATE INDEX IF NOT EXISTS profiles_account_branch ON public.profiles (account_id, branch_id);
CREATE INDEX IF NOT EXISTS counsellors_account_branch ON public.counsellors (account_id, branch_id);
CREATE INDEX IF NOT EXISTS ad_catalog_account_branch ON public.ad_catalog (account_id, branch_id);
CREATE INDEX IF NOT EXISTS counsellor_assignments_pool_turn
  ON public.counsellor_assignments (counsellor_id, pool_branch_id, assigned_at DESC);

-- 4. routing core ------------------------------------------------------------------------------------------------------
-- The branch of the ad the chat came from; NULL for organic chats, referral-less ad chats and unmapped ad ids.
CREATE OR REPLACE FUNCTION public.lead_ad_branch(p_conversation_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT ad.branch_id
    FROM public.conversations cv
    JOIN public.ad_catalog ad ON ad.ad_id = cv.ad_source_id AND ad.account_id = cv.account_id
   WHERE cv.id = p_conversation_id
$$;
REVOKE ALL ON FUNCTION public.lead_ad_branch(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_ad_branch(uuid) TO service_role;

-- Who gets the lead. The caller holds the per-account advisory lock (assign_counsellor:<account>).
--   1. sticky: the contact's latest counsellor, if still active (any branch); pool = the lead's own pool
--   2. p_branch set: strict alternation over that branch's active counsellors, by their latest assignment in that pool
--   3. otherwise, or nobody active in that branch: strict alternation over every active counsellor, by their latest
--      assignment in the all-branch pool (pool_branch_id NULL)
--   4. nobody active: no row
CREATE OR REPLACE FUNCTION public.pick_counsellor(p_account uuid, p_contact uuid, p_branch uuid)
RETURNS TABLE (counsellor_id uuid, is_new boolean, pool_branch_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_id     uuid;
  v_active boolean;
BEGIN
  SELECT c.id, c.active INTO v_id, v_active
    FROM public.counsellor_assignments a JOIN public.counsellors c ON c.id = a.counsellor_id
   WHERE a.contact_id = p_contact AND c.account_id = p_account
   ORDER BY a.assigned_at DESC LIMIT 1;
  IF v_id IS NOT NULL AND v_active THEN
    RETURN QUERY SELECT v_id, false, p_branch;
    RETURN;
  END IF;

  IF p_branch IS NOT NULL THEN
    SELECT c.id INTO v_id
      FROM public.counsellors c
      LEFT JOIN LATERAL (SELECT max(a.assigned_at) AS last FROM public.counsellor_assignments a
                          WHERE a.counsellor_id = c.id AND a.pool_branch_id = p_branch) l ON true
     WHERE c.account_id = p_account AND c.active AND c.branch_id = p_branch
     ORDER BY l.last NULLS FIRST, c.created_at, c.id
     LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_id, true, p_branch;
      RETURN;
    END IF;
  END IF;

  SELECT c.id INTO v_id
    FROM public.counsellors c
    LEFT JOIN LATERAL (SELECT max(a.assigned_at) AS last FROM public.counsellor_assignments a
                        WHERE a.counsellor_id = c.id AND a.pool_branch_id IS NULL) l ON true
   WHERE c.account_id = p_account AND c.active
   ORDER BY l.last NULLS FIRST, c.created_at, c.id
   LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_id, true, NULL::uuid;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.pick_counsellor(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pick_counsellor(uuid, uuid, uuid) TO service_role;

-- A contact's branch is set once, by its first counsellor; its deals with no branch follow.
CREATE OR REPLACE FUNCTION public.set_lead_branch(p_contact uuid, p_branch uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.contacts SET branch_id = p_branch WHERE id = p_contact AND branch_id IS NULL;
  UPDATE public.deals d SET branch_id = ct.branch_id
    FROM public.contacts ct
   WHERE ct.id = p_contact AND d.contact_id = ct.id AND d.branch_id IS NULL AND ct.branch_id IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.set_lead_branch(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_lead_branch(uuid, uuid) TO service_role;

-- 5. the three rotation paths ------------------------------------------------------------------------------------------
-- 081 assign_counsellor: the lead asked for a human. Body as in 081 except the rotation block.
CREATE OR REPLACE FUNCTION public.assign_counsellor(p_conversation_id uuid)
RETURNS TABLE (counsellor_id uuid, display_name text, wa_number text, telegram_chat_id bigint, is_new boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_acc     uuid;
  v_contact uuid;
  v_c       public.counsellors%ROWTYPE;
  v_new     boolean := true;
  v_cid     uuid;
  v_pool    uuid;
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

  -- Sticky, then the ad's branch pool, then the all-branch pool (097).
  SELECT p.counsellor_id, p.is_new, p.pool_branch_id INTO v_cid, v_new, v_pool
    FROM public.pick_counsellor(v_acc, v_contact, public.lead_ad_branch(p_conversation_id)) p;
  IF v_cid IS NULL THEN RETURN; END IF;  -- nobody active: no row, the bot is still paused
  SELECT * INTO v_c FROM public.counsellors WHERE id = v_cid;
  PERFORM public.set_lead_branch(v_contact, v_c.branch_id);

  -- clock_timestamp, not now(): now() is the transaction start, so a call that
  -- waited on the lock would stamp itself earlier than the call before it and
  -- break the alternation order.
  INSERT INTO public.counsellor_assignments (account_id, conversation_id, contact_id, counsellor_id, assigned_at, pool_branch_id)
  VALUES (v_acc, p_conversation_id, v_contact, v_c.id, clock_timestamp(), v_pool)
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

-- 090 assign_counsellor_silent: an ad lead went quiet. Body as in 090 except the rotation block.
CREATE OR REPLACE FUNCTION public.assign_counsellor_silent(p_conversation_id uuid)
RETURNS TABLE (counsellor_id uuid, display_name text, wa_number text, telegram_chat_id bigint, is_new boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_acc     uuid;
  v_contact uuid;
  v_c       public.counsellors%ROWTYPE;
  v_new     boolean := true;
  v_cid     uuid;
  v_pool    uuid;
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

  -- Sticky, then the ad's branch pool, then the all-branch pool (097).
  SELECT p.counsellor_id, p.is_new, p.pool_branch_id INTO v_cid, v_new, v_pool
    FROM public.pick_counsellor(v_acc, v_contact, public.lead_ad_branch(p_conversation_id)) p;
  IF v_cid IS NULL THEN RETURN; END IF;  -- nobody active: no row; the finder offers it again next run
  SELECT * INTO v_c FROM public.counsellors WHERE id = v_cid;
  PERFORM public.set_lead_branch(v_contact, v_c.branch_id);

  INSERT INTO public.counsellor_assignments (account_id, conversation_id, contact_id, counsellor_id, assigned_at, assigned_via, pool_branch_id)
  VALUES (v_acc, p_conversation_id, v_contact, v_c.id, clock_timestamp(), 'silent', v_pool)
  ON CONFLICT (conversation_id, counsellor_id) DO NOTHING;

  -- No bot_active change and no assigned_agent_id: the bot keeps answering. If the lead later taps
  -- "Talk to a counsellor", assign_counsellor finds this row (sticky) and hands the chat over then.
  RETURN QUERY SELECT v_c.id, v_c.display_name, v_c.wa_number, v_c.telegram_chat_id, v_new;
END $$;

-- 087 assign_counsellor_unanswered: the lead's message got no reply. Body as in 087 except the rotation block.
CREATE OR REPLACE FUNCTION public.assign_counsellor_unanswered(p_conversation_id uuid)
RETURNS TABLE (counsellor_id uuid, display_name text, wa_number text, telegram_chat_id bigint, is_new boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_acc     uuid;
  v_contact uuid;
  v_c       public.counsellors%ROWTYPE;
  v_new     boolean := true;
  v_cid     uuid;
  v_pool    uuid;
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

  -- Sticky, then the ad's branch pool, then the all-branch pool (097).
  SELECT p.counsellor_id, p.is_new, p.pool_branch_id INTO v_cid, v_new, v_pool
    FROM public.pick_counsellor(v_acc, v_contact, public.lead_ad_branch(p_conversation_id)) p;
  IF v_cid IS NULL THEN RETURN; END IF;
  SELECT * INTO v_c FROM public.counsellors WHERE id = v_cid;
  PERFORM public.set_lead_branch(v_contact, v_c.branch_id);

  INSERT INTO public.counsellor_assignments (account_id, conversation_id, contact_id, counsellor_id, assigned_at, assigned_via, pool_branch_id)
  VALUES (v_acc, p_conversation_id, v_contact, v_c.id, clock_timestamp(), 'unanswered', v_pool)
  ON CONFLICT (conversation_id, counsellor_id) DO NOTHING;

  RETURN QUERY SELECT v_c.id, v_c.display_name, v_c.wa_number, v_c.telegram_chat_id, v_new;
END $$;

REVOKE ALL ON FUNCTION public.assign_counsellor(uuid), public.assign_counsellor_silent(uuid),
                       public.assign_counsellor_unanswered(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_counsellor(uuid), public.assign_counsellor_silent(uuid),
                          public.assign_counsellor_unanswered(uuid) TO service_role;
