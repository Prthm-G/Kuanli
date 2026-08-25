-- 061_ctwa_attribution.sql
-- KB-CTWA-R4-39
--
-- Keep the click-to-WhatsApp ad identifiers that the webhook already receives
-- and throws away.
--
-- Meta injects a `referral` object into the FIRST inbound message of every
-- conversation that started from a click-to-WhatsApp ad, and into no later
-- message. POST /api/whatsapp/webhook has always read that object, but only
-- `headline`, `body` and `source_url` — the three human-readable fields it
-- needs to render the "Ad Clicked" banner at the top of the chat. The two
-- fields that actually identify the ad, `ctwa_clid` (the click id Meta mints at
-- the moment of the tap) and `source_id` (the ad id), were parsed and dropped.
--
-- The consequence is that ad spend cannot be joined to admissions. Skeure has
-- spent over Rs 4 lakh on click-to-WhatsApp ads and cannot say which campaign,
-- ad set or ad produced a single enrolment. These columns are what make that
-- join possible: `ad_source_id` resolves to the ad in Meta Ads Manager, and
-- `ctwa_clid` is the click the Conversions API needs in order to report a
-- conversion back against it.
--
-- LAST TOUCH, not history. A new referral on an existing conversation
-- overwrites these columns. A contact who clicks a second ad has genuinely
-- re-entered the funnel from that second ad, and a conversion has to be
-- reported against the click that led to it, so the most recent click is the
-- correct one to keep. A per-click history table would be a different feature
-- with a different shape and is deliberately not built here.
--
-- Deliberately no NOT NULL and no defaults: the overwhelming majority of
-- conversations are organic and legitimately have no ad behind them. NULL here
-- means "not from an ad", which is a real and useful distinction from an empty
-- string, and it is what separates paid from organic in any report built on
-- these columns.
--
-- `ad_referral_at` is the time the referral was RECEIVED, not the time of the
-- click. Meta does not send a click timestamp. It exists so a later Conversions
-- API call can tell a fresh click from a stale one, and so overwrites are
-- auditable.
--
-- Nothing is written here by a user. `supabaseAdmin()` (service role) does the
-- write from the webhook, exactly as it already does for every other inbound
-- column.
--
-- RLS: `conversations` is account-scoped via is_account_member(account_id)
-- since migration 017, which superseded the original auth.uid() = user_id
-- policy from migration 001. Adding columns needs NO policy change — account
-- members already read and update their own conversations, and this migration
-- deliberately adds no policy and disables nothing.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_conversations_ad_source_id;
--   DROP INDEX IF EXISTS idx_conversations_ctwa_clid;
--   ALTER TABLE conversations
--     DROP COLUMN IF EXISTS ctwa_clid,
--     DROP COLUMN IF EXISTS ad_source_id,
--     DROP COLUMN IF EXISTS ad_source_type,
--     DROP COLUMN IF EXISTS ad_headline,
--     DROP COLUMN IF EXISTS ad_source_url,
--     DROP COLUMN IF EXISTS ad_referral_at;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ctwa_clid      TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ad_source_id   TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ad_source_type TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ad_headline    TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ad_source_url  TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ad_referral_at TIMESTAMPTZ;

-- "How did every lead from this ad perform" is the whole point of the feature,
-- so grouping and filtering by ad id has to not be a seq scan over every
-- conversation in the table.
--
-- Both indexes are partial. Only ad-started conversations have these values and
-- they are a small minority of rows, so indexing WHERE NOT NULL keeps the index
-- proportional to the paid traffic rather than to the whole table, and skips
-- the organic majority entirely.
CREATE INDEX IF NOT EXISTS idx_conversations_ad_source_id
  ON conversations(ad_source_id)
  WHERE ad_source_id IS NOT NULL;

-- Looked up by exact click id when reconciling a conversion against the click
-- that produced it.
CREATE INDEX IF NOT EXISTS idx_conversations_ctwa_clid
  ON conversations(ctwa_clid)
  WHERE ctwa_clid IS NOT NULL;
