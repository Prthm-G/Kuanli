-- 054_manual_followups.sql
-- KB-FOLLOWUP-MANUAL-R4-31
--
-- The human half of follow-up. Migration 044 automated the re-engagement
-- ladder (follow_up_rungs / follow_up_log), but nothing records what a
-- counsellor actually did: a call placed, a callback promised for Friday, the
-- reason a lead went quiet. That lived in the counsellor's head, so nobody
-- could see who was due today and the EOD report could not count follow-up
-- work at all.
--
-- Shape:
--   follow_up_entries — one row per human touch. What happened (method,
--     outcome, free-text summary) and, optionally, what was promised next
--     (next_due_at, next_method).
--
-- Scheduling without a task table
--
--   A contact is "due" when their NEWEST entry carries a next_due_at. There
--   is deliberately no separate task/reminder table and no completed flag:
--   logging a new entry closes the previous commitment automatically, because
--   the older row stops being newest. One write, one source of truth, and the
--   schedule cannot drift out of sync with the log the way a parallel task
--   table would. The cost is that you cannot hold two open commitments for
--   one contact at once, which is the right constraint — a counsellor owes a
--   student one next step, not a backlog.
--
-- Relationship to the automated ladder
--
--   None, on purpose. A human call does NOT suppress the bot ladder, and
--   follow_up_entries is not consulted by follow_ups_due(). Coupling them
--   would make 044's "fires at most once per silence spell" reasoning
--   unreadable, and the two serve different ends: the ladder fights silence,
--   this log records work. They only meet in follow_up_timeline() below,
--   which merges them for display.
--
-- Access: agent and above manage entries (counsellors are the authors);
-- viewer reads. Same convention as contacts/deals under migration 017.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.follow_up_overdue_count(uuid);
--   DROP FUNCTION IF EXISTS public.follow_up_timeline(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.follow_up_worklist(uuid);
--   DROP TABLE IF EXISTS follow_up_entries;
--   DROP TYPE IF EXISTS followup_outcome_enum;
--   DROP TYPE IF EXISTS followup_method_enum;

-- Enums rather than CHECK constraints: these are closed vocabularies the
-- analytics layer will group on, and an enum makes an invalid value
-- impossible to insert from any client, not just the UI.
DO $$ BEGIN
  CREATE TYPE followup_method_enum AS ENUM ('call', 'whatsapp', 'email', 'in_person');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE followup_outcome_enum AS ENUM (
    'connected', 'no_answer', 'callback_requested', 'not_interested', 'converted'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ownership is stated, not inherited. Every other table in this schema is
-- owned by supabase_admin, and an object inherits the DEFAULT PRIVILEGES of
-- whoever created it — so a migration applied as the wrong role silently
-- hands `anon` the grants that role's defaults carry. That is precisely what
-- happened on the first run of this migration. Stating the owner and revoking
-- anon below makes the result identical no matter who applies the file.
ALTER TYPE followup_method_enum OWNER TO supabase_admin;
ALTER TYPE followup_outcome_enum OWNER TO supabase_admin;

CREATE TABLE IF NOT EXISTS follow_up_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Deep-link target for the timeline. SET NULL rather than CASCADE: losing
  -- the conversation must not erase the record that the call happened.
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  -- When the touch happened, not when it was typed up. Counsellors log
  -- yesterday's calls, so this is user-supplied and defaults to now().
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  method followup_method_enum NOT NULL,
  outcome followup_outcome_enum,
  summary TEXT NOT NULL,
  next_due_at TIMESTAMPTZ,
  next_method followup_method_enum,
  logged_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A promised method without a promised date is a half-filled form, and the
  -- worklist keys on the date alone. Reject the combination at the boundary.
  CONSTRAINT followup_next_method_needs_date
    CHECK (next_method IS NULL OR next_due_at IS NOT NULL),
  -- Empty summaries make the log worthless to the next person reading it.
  CONSTRAINT followup_summary_not_blank
    CHECK (length(btrim(summary)) > 0)
);

-- Serves both the per-contact timeline and the "newest entry" lookup the
-- worklist does per contact.
CREATE INDEX IF NOT EXISTS idx_follow_up_entries_contact_time
  ON follow_up_entries(contact_id, occurred_at DESC);

-- Partial: only entries that promised something can ever be due, and those
-- are a small minority of the table over time.
CREATE INDEX IF NOT EXISTS idx_follow_up_entries_due
  ON follow_up_entries(account_id, next_due_at)
  WHERE next_due_at IS NOT NULL;

-- Powers the EOD "follow-ups logged today" count.
CREATE INDEX IF NOT EXISTS idx_follow_up_entries_account_time
  ON follow_up_entries(account_id, occurred_at DESC);

ALTER TABLE follow_up_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Account members can read follow-up entries" ON follow_up_entries;
CREATE POLICY "Account members can read follow-up entries" ON follow_up_entries
  FOR SELECT USING (is_account_member(account_id));

-- Authorship is enforced here, not in the UI: an agent may only file entries
-- under their own user id, so `logged_by` is trustworthy in the timeline.
DROP POLICY IF EXISTS "Counsellors can log follow-up entries" ON follow_up_entries;
CREATE POLICY "Counsellors can log follow-up entries" ON follow_up_entries
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent'::account_role_enum)
    AND logged_by = auth.uid()
  );

-- Correcting your own write-up is normal (a typo, a forgotten next step).
-- Editing someone else's is not: it would silently rewrite the record of what
-- a colleague reported. Admins can, for genuine cleanup.
DROP POLICY IF EXISTS "Authors and admins can amend follow-up entries" ON follow_up_entries;
CREATE POLICY "Authors and admins can amend follow-up entries" ON follow_up_entries
  FOR UPDATE USING (
    is_account_member(account_id, 'agent'::account_role_enum)
    AND (logged_by = auth.uid()
         OR is_account_member(account_id, 'admin'::account_role_enum))
  ) WITH CHECK (
    is_account_member(account_id, 'agent'::account_role_enum)
  );

DROP POLICY IF EXISTS "Authors and admins can delete follow-up entries" ON follow_up_entries;
CREATE POLICY "Authors and admins can delete follow-up entries" ON follow_up_entries
  FOR DELETE USING (
    is_account_member(account_id, 'agent'::account_role_enum)
    AND (logged_by = auth.uid()
         OR is_account_member(account_id, 'admin'::account_role_enum))
  );

-- ============================================================
-- follow_up_worklist(account_id)
--
-- Every contact carrying an open commitment: the newest entry has a
-- next_due_at. Future commitments are returned too — the page buckets them
-- into Overdue / Today / This week / Later, and doing that split in SQL would
-- bake the caller's timezone into the database.
--
-- Same authorization convention as lead_queue (041) and application_tracker
-- (046): auth.uid() required, membership checked, EXECUTE to authenticated.
-- Read-only, so viewer is enough.
-- ============================================================
CREATE OR REPLACE FUNCTION public.follow_up_worklist(p_account_id uuid)
RETURNS TABLE (
  contact_id uuid,
  entry_id uuid,
  conversation_id uuid,
  name text,
  phone text,
  roll_number text,
  university text,
  stage_name text,
  occurred_at timestamptz,
  method followup_method_enum,
  outcome followup_outcome_enum,
  summary text,
  next_due_at timestamptz,
  next_method followup_method_enum,
  logged_by uuid,
  logged_by_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    ct.id,
    e.id,
    e.conversation_id,
    ct.name,
    ct.phone,
    ct.roll_number,
    ct.university,
    ps.name,
    e.occurred_at,
    e.method,
    e.outcome,
    e.summary,
    e.next_due_at,
    e.next_method,
    e.logged_by,
    pr.full_name
  FROM contacts ct
  -- The newest entry only. An older promise that has since been superseded
  -- by a newer log line is settled by definition.
  JOIN LATERAL (
    SELECT fe.* FROM follow_up_entries fe
    WHERE fe.contact_id = ct.id
    ORDER BY fe.occurred_at DESC, fe.created_at DESC
    LIMIT 1
  ) e ON e.next_due_at IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT d.stage_id FROM deals d
    WHERE d.contact_id = ct.id AND d.account_id = p_account_id
    ORDER BY d.updated_at DESC NULLS LAST LIMIT 1
  ) dl ON true
  LEFT JOIN pipeline_stages ps ON ps.id = dl.stage_id
  LEFT JOIN profiles pr ON pr.user_id = e.logged_by
  WHERE ct.account_id = p_account_id
  ORDER BY e.next_due_at ASC;
END;
$$;

ALTER FUNCTION public.follow_up_worklist(uuid) OWNER TO postgres;
-- FROM PUBLIC alone is not enough: an explicit anon grant from the creating
-- role's default privileges survives it. Name anon.
REVOKE ALL ON FUNCTION public.follow_up_worklist(uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.follow_up_worklist(uuid) TO authenticated;

-- ============================================================
-- follow_up_timeline(account_id, contact_id)
--
-- One contact's follow-up history: manual entries UNIONed with the automated
-- ladder's sends from migration 044, tagged by source so the UI can render
-- them differently. This is the only place the two systems meet.
--
-- Automated rows have no outcome and no next step — the ladder does not make
-- promises — so those columns come back NULL for them.
-- ============================================================
CREATE OR REPLACE FUNCTION public.follow_up_timeline(
  p_account_id uuid,
  p_contact_id uuid
)
RETURNS TABLE (
  source text,
  entry_id uuid,
  occurred_at timestamptz,
  method text,
  outcome text,
  summary text,
  next_due_at timestamptz,
  next_method text,
  actor_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    'manual'::text,
    e.id,
    e.occurred_at,
    e.method::text,
    e.outcome::text,
    e.summary,
    e.next_due_at,
    e.next_method::text,
    pr.full_name
  FROM follow_up_entries e
  LEFT JOIN profiles pr ON pr.user_id = e.logged_by
  WHERE e.account_id = p_account_id AND e.contact_id = p_contact_id

  UNION ALL

  SELECT
    'auto'::text,
    l.id,
    l.sent_at,
    'whatsapp'::text,
    NULL::text,
    -- What the ladder actually sent. Template rungs carry no body, so name
    -- the template instead of showing an empty row.
    COALESCE(r.body, 'Template: ' || r.template_name, 'Automated follow-up'),
    NULL::timestamptz,
    NULL::text,
    'Rung ' || r.rung_order::text
  FROM follow_up_log l
  JOIN follow_up_rungs r ON r.id = l.rung_id
  WHERE l.account_id = p_account_id AND l.contact_id = p_contact_id

  ORDER BY 3 DESC;
END;
$$;

ALTER FUNCTION public.follow_up_timeline(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.follow_up_timeline(uuid, uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.follow_up_timeline(uuid, uuid) TO authenticated;

-- ============================================================
-- follow_up_overdue_count(account_id)
--
-- How many commitments are past their date right now. Used by the EOD report,
-- which is rendered on two very different paths:
--
--   the /reports page   — an authenticated member, RLS applies;
--   the nightly email   — /api/reports/eod, triggered by n8n with a shared
--                         secret and NO user session, querying through the
--                         service-role client (see that route's header).
--
-- follow_up_worklist() cannot serve the second path: it requires auth.uid(),
-- which a cron call does not have, so the email would have reported zero
-- overdue every night forever while looking perfectly healthy.
--
-- Hence the two-branch check. A session-bearing caller must be a member of the
-- account, exactly as everywhere else. A caller with no session is only ever
-- reachable here through the service_role grant below, and `auth.role()`
-- confirms it rather than inferring it from the absence of a uid — anon also
-- has no uid, and this must never answer anon.
--
-- The count itself repeats the worklist's rule: only a contact's NEWEST entry
-- is live, because a later log line settles whatever an earlier one promised.
-- A plain `next_due_at < now()` count over the table would include every
-- commitment ever settled and grow without bound.
-- ============================================================
CREATE OR REPLACE FUNCTION public.follow_up_overdue_count(p_account_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
      RAISE EXCEPTION 'This action requires membership in this account'
        USING ERRCODE = '42501';
    END IF;
  ELSIF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_count
  FROM contacts ct
  JOIN LATERAL (
    SELECT fe.next_due_at FROM follow_up_entries fe
    WHERE fe.contact_id = ct.id
    ORDER BY fe.occurred_at DESC, fe.created_at DESC
    LIMIT 1
  ) e ON e.next_due_at IS NOT NULL AND e.next_due_at < now()
  WHERE ct.account_id = p_account_id;

  RETURN v_count;
END;
$$;

ALTER FUNCTION public.follow_up_overdue_count(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.follow_up_overdue_count(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.follow_up_overdue_count(uuid)
  TO authenticated, service_role;

-- Table-level grants follow the repo convention: RLS does the enforcement,
-- but PostgREST roles still need the grant or every access 42501s.
--
-- The blanket REVOKE first is not decoration. Inherited default privileges
-- hand out ALL PRIVILEGES, and two of those are not row-level:
--
--   TRUNCATE bypasses RLS completely — one authenticated user could empty
--            every account's follow-up history with a single statement;
--   anon     is the role behind the public publishable key.
--
-- The older core tables (contacts, deals, contact_notes) still carry both from
-- the Supabase bootstrap. The newer deliberate migrations do not: 044's
-- follow_up_log grants authenticated nothing but SELECT, 045's
-- application_documents only SELECT and UPDATE. This table follows those.
ALTER TABLE follow_up_entries OWNER TO supabase_admin;
REVOKE ALL ON follow_up_entries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON follow_up_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON follow_up_entries TO service_role;
