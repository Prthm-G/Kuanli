-- 040_bot_crm_bridge.sql
-- KB-BRIDGE-R4-22
--
-- Finish the bot-to-CRM bridge. Three gaps, one migration:
--
-- 1. `specialization` — computed per turn in the `Lead Classifier` n8n node
--    (list-reply number or free-text match against the per-programme SPEC
--    catalogue) and then dropped: neither `Save Selection State` nor
--    `Mirror Interest to wacrm` persisted it. Adds the column to both the
--    bot state table and the conversations read model (mirror columns from
--    migration 038; same deliberate no-NOT-NULL, no-default posture).
--
-- 2. Ad attribution — `ad_headline` / `ad_body` are parsed from Meta's
--    click-to-WhatsApp referral payload on every inbound message but only
--    survived as `'Source: ' || ad_body` inside the deal notes at deal
--    creation, so campaign performance was unanswerable in the CRM. Stored
--    on `contacts` as FIRST-touch attribution: the n8n write uses
--    COALESCE(existing, new), so the first ad a lead ever arrived from wins
--    and later organic messages never blank it.
--
-- 3. `bot_conversation_state` moves home. It lived in `n8n_database`, which
--    Kuanli cannot join across — that split is why the EOD report needed the
--    mirror in the first place. The table now lives here, with real FK
--    integrity (the 2026-08-18 purge had to clean its orphans by hand; ON
--    DELETE CASCADE makes that automatic). RLS is enabled with NO policies
--    on purpose: this is the bot's private routing state — n8n connects as
--    supabase_admin and bypasses RLS; PostgREST roles cannot see it. Kuanli
--    keeps reading the mirror columns on `conversations`.
--    The old table in `n8n_database` is left in place, dead, as rollback
--    insurance — it simply stops receiving writes when the workflow is
--    repointed.
--
-- Rollback:
--   ALTER TABLE conversations DROP COLUMN IF EXISTS interest_specialization;
--   ALTER TABLE contacts DROP COLUMN IF EXISTS ad_headline,
--                        DROP COLUMN IF EXISTS ad_body;
--   DROP TABLE IF EXISTS bot_conversation_state;
--   (and repoint the two n8n state nodes back to the "Postgres account"
--    credential — see devtools/apply-auretris-bridge-r4-22.mjs)

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS interest_specialization TEXT;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ad_headline TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ad_body TEXT;

CREATE TABLE IF NOT EXISTS bot_conversation_state (
  conversation_id UUID PRIMARY KEY
    REFERENCES conversations(id) ON DELETE CASCADE,
  university TEXT,
  mode TEXT,
  course TEXT,
  specialization TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE bot_conversation_state ENABLE ROW LEVEL SECURITY;
