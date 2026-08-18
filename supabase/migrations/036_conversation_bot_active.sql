-- 036_conversation_bot_active.sql
-- KB-BOTTOGGLE-R4-15
--
-- Per-conversation switch for the Auretris AI agent. The inbox toggle writes
-- this column; POST /api/whatsapp/webhook reads it and skips the n8n forward
-- when it is false, which is what actually silences the bot (that forward is
-- the only call site, and the workflow it triggers exists solely to produce the
-- AI answer). Inbound is still received, stored and shown either way.
--
-- Defaults to true so every existing and future thread keeps replying exactly
-- as before; a human has to switch it off, typically on a personal chat.
--
-- Written retroactively: the column was added by hand on the live database
-- during KB-BOTTOGGLE-R4-15 and never captured as a migration, so a rebuild
-- from migrations alone would have silently dropped it and turned the toggle
-- into a no-op. Every statement below is therefore idempotent and reconciling
-- rather than plain DDL — it is a no-op against the live database and creates
-- the column correctly on a fresh deploy.
--
-- RLS: conversations policies (migration 017) are account-scoped via
-- is_account_member(account_id). Adding a column needs NO policy change —
-- account members already read and update their own conversations.
--
-- Rollback:
--   ALTER TABLE conversations DROP COLUMN IF EXISTS bot_active;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS bot_active BOOLEAN;

-- Reconcile a hand-created column that may lack the default/backfill/NOT NULL.
ALTER TABLE conversations ALTER COLUMN bot_active SET DEFAULT TRUE;
UPDATE conversations SET bot_active = TRUE WHERE bot_active IS NULL;
ALTER TABLE conversations ALTER COLUMN bot_active SET NOT NULL;
