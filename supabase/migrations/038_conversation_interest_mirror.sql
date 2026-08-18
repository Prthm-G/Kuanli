-- 038_conversation_interest_mirror.sql
-- KB-EODREPORT-R4-20
--
-- Mirror the bot's inferred lead interest into the app database so Kuanli can
-- read it.
--
-- Why this exists: `Auretris - Main` keeps what a lead is actually interested in
-- (university, study mode, course) in `bot_conversation_state`, which lives in
-- the **n8n_database**, not here. Kuanli reaches the app database through
-- PostgREST and RLS and cannot join across databases, so none of that data was
-- reachable from the CRM. `contacts.university` is not a substitute: it is
-- agent-entered through update_contact_enrollment at enrollment time and was
-- populated for 2 of 116 contacts, whereas the bot had resolved a university for
-- 34 conversations.
--
-- The n8n workflow already holds a `WACRM Database` credential and writes
-- through it in ten nodes, so the mirror is one extra upsert next to the
-- existing `Save Selection State`, not new infrastructure.
--
-- These columns are a READ MODEL. `bot_conversation_state` stays the source of
-- truth for the bot's own routing; nothing in Kuanli writes here. Treating them
-- as authoritative would put the bot's routing behind RLS, which is not wanted.
--
-- Deliberately no NOT NULL and no defaults: a conversation legitimately has no
-- university until the lead picks one, and the EOD report shows those blanks on
-- purpose — they are where leads stalled.
--
-- RLS: `conversations` policies (migration 017) are account-scoped via
-- is_account_member(account_id). Adding columns needs no policy change.
--
-- Rollback:
--   ALTER TABLE conversations
--     DROP COLUMN IF EXISTS interest_university,
--     DROP COLUMN IF EXISTS interest_mode,
--     DROP COLUMN IF EXISTS interest_course,
--     DROP COLUMN IF EXISTS interest_updated_at;
--   DROP INDEX IF EXISTS idx_conversations_created_at;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS interest_university TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS interest_mode TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS interest_course TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS interest_updated_at TIMESTAMPTZ;

-- The EOD report filters conversations by account and creation date for the
-- day / week / month tabs. Without this the month tab is a seq scan.
CREATE INDEX IF NOT EXISTS idx_conversations_account_created
  ON conversations(account_id, created_at DESC);
