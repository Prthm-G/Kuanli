-- 070_ad_referral_msg_time.sql
-- KB-CTWA-R5-52
--
-- Last-touch attribution is now ordered by Meta's own message timestamp.
--
-- 061's `ad_referral_at` is the RECEIPT wall-clock: `new Date()` at webhook
-- time, while `message.timestamp` - the second Meta stamped on the message
-- carrying the referral - was in scope at the call site and dropped. Meta
-- retries deliveries and guarantees no ordering across retries, so a delayed
-- retry of ad A's first message landing after ad B's overwrote B's click id
-- AND stamped a later receipt time: the record asserted A was newest. A
-- conversion then reports against the wrong ad, which trains the optimiser
-- toward the wrong creative - strictly worse than not reporting.
--
-- `persistAdReferral` now writes this column from message.timestamp and guards
-- the update with `ad_referral_msg_at IS NULL OR < incoming`, so an
-- out-of-order replay matches zero rows instead of winning.
--
-- ad_referral_at stays: receipt time is still the audit trail for WHEN we
-- learned of the click. This column is the ordering key.
--
-- Rollback:
--   ALTER TABLE conversations DROP COLUMN IF EXISTS ad_referral_msg_at;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ad_referral_msg_at TIMESTAMPTZ;

COMMENT ON COLUMN conversations.ad_referral_msg_at IS
  'Meta message.timestamp of the inbound message carrying the ad referral. '
  'The ordering key for last-touch attribution; ad_referral_at is receipt '
  'time only. Written guarded so an out-of-order webhook replay cannot win.';
