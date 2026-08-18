-- 034_multi_number_per_account.sql
-- KB-MULTINUM-R4-12
--
-- Allow one Kuanli account to own MORE THAN ONE WhatsApp business number
-- (shared inbox). Until now migration 017 enforced one-number-per-account via
-- UNIQUE(account_id) on whatsapp_config; its own comment anticipated this
-- change ("If multi-number-per-account is ever wanted, drop the unique and add
-- a 'primary' boolean.").
--
-- Design:
--   * Drop UNIQUE(account_id); KEEP UNIQUE(phone_number_id) (migration 013) —
--     two distinct numbers are simply two rows on the same account.
--   * Add whatsapp_config.is_primary: the account's default number for
--     account/WABA-level operations (template submit/sync, broadcasts) and the
--     fallback when a conversation has no number tag. Enforced <=1 per account.
--   * Add conversations.phone_number_id: the business number a thread belongs
--     to, set on inbound by the webhook. Outbound replies leave from the SAME
--     number the lead is talking to.
--
-- RLS: conversations and whatsapp_config policies (migration 017) are
-- account-scoped via is_account_member(account_id). Adding a column and
-- allowing multiple whatsapp_config rows per account needs NO policy change —
-- every account member already sees/manages all rows for their account.
--
-- Rollback (only safe after removing any extra number rows so each account has
-- exactly one whatsapp_config row again):
--   ALTER TABLE conversations DROP COLUMN IF EXISTS phone_number_id;
--   DROP INDEX IF EXISTS idx_conversations_phone_number_id;
--   DROP INDEX IF EXISTS idx_whatsapp_config_one_primary;
--   ALTER TABLE whatsapp_config DROP COLUMN IF EXISTS is_primary;
--   ALTER TABLE whatsapp_config ADD CONSTRAINT whatsapp_config_account_id_key UNIQUE (account_id);

BEGIN;

-- 1. Drop the one-number-per-account guard. Keep UNIQUE(phone_number_id).
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

-- 2. Primary-number flag.
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;

-- Backfill: promote one row per account to primary, but never override an
-- account that already has a primary (idempotent / re-runnable). Deterministic
-- pick: a connected row first, then the oldest row.
WITH ranked AS (
  SELECT
    id,
    account_id,
    row_number() OVER (
      PARTITION BY account_id
      ORDER BY (status = 'connected') DESC, created_at ASC, id ASC
    ) AS rn
  FROM whatsapp_config
)
UPDATE whatsapp_config w
SET is_primary = true
FROM ranked r
WHERE w.id = r.id
  AND r.rn = 1
  AND NOT EXISTS (
    SELECT 1 FROM whatsapp_config w2
    WHERE w2.account_id = w.account_id AND w2.is_primary = true
  );

-- At most one primary per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_primary
  ON whatsapp_config(account_id)
  WHERE is_primary;

-- 3. Tag conversations with their business number. Plain TEXT tag (matches
-- whatsapp_config.phone_number_id by value, the same way the webhook resolves
-- config) rather than a FK, so removing a number never blocks or cascades into
-- historical threads.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone_number_id TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_phone_number_id
  ON conversations(phone_number_id);

-- Backfill existing threads: every current conversation predates multi-number,
-- so it belongs to its account's only number = the primary config's number.
UPDATE conversations c
SET phone_number_id = w.phone_number_id
FROM whatsapp_config w
WHERE w.account_id = c.account_id
  AND w.is_primary = true
  AND c.phone_number_id IS NULL;

COMMIT;
