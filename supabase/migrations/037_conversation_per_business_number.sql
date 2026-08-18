-- 037_conversation_per_business_number.sql
-- KB-CONVKEY-R4-19
--
-- One conversation per (account, contact, business number) instead of one per
-- (account, contact).
--
-- Until now a lead who messaged both of an account's WhatsApp numbers landed in
-- a single thread whose phone_number_id was re-tagged to whichever number they
-- used last, so replies followed the last-used number and the two sides of the
-- relationship were interleaved in one view. Migration 028 encoded the old rule
-- as idx_conversations_account_contact_unique; migration 034 added
-- conversations.phone_number_id but left that uniqueness alone. This makes the
-- number part of a thread's identity.
--
-- NULLS NOT DISTINCT (Postgres 15+) matters: without it every row with a null
-- phone_number_id would occupy its own uniqueness slot, so a contact could
-- accumulate unlimited untagged threads. With it, null behaves as a single
-- value and an untagged thread stays unique per contact, preserving the old
-- guarantee for any legacy row. Migration 034 backfilled the column and the
-- live table currently has no nulls, so this is a guard, not a live case.
--
-- Existing merged threads are NOT split, because the data to split them with
-- does not exist: `messages` records no phone_number_id, so there is no way to
-- attribute a historical message to a business number. Every current thread
-- keeps its present tag and history. The new rule applies going forward — the
-- next time a lead messages a *different* number, that gets its own thread.
--
-- The new index is created before the old one is dropped so there is never a
-- window without a uniqueness guarantee. Creation cannot fail on existing data:
-- the old index enforced uniqueness on a strict subset of these columns.
--
-- Rollback (safe only after merging any threads that now share a contact):
--   CREATE UNIQUE INDEX idx_conversations_account_contact_unique
--     ON conversations(account_id, contact_id);
--   DROP INDEX IF EXISTS idx_conversations_account_contact_number_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_number_unique
  ON conversations(account_id, contact_id, phone_number_id) NULLS NOT DISTINCT;

DROP INDEX IF EXISTS idx_conversations_account_contact_unique;
