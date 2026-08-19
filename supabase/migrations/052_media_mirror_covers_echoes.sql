-- 052_media_mirror_covers_echoes.sql
-- KB-MEDIAMIRROR-R4-32
--
-- Comment-only correction to migration 051.
--
-- 051 described `messages.media_type` as populated for INBOUND media
-- only, on the reasoning that outbound media is a chat-media object
-- whose path already carries the filename and extension. That holds for
-- the composer, but NOT for a message an agent sends from the WhatsApp
-- Business app on their phone: that arrives back as an echo carrying a
-- Meta media id, is stored as a proxy pointer, and expires on Meta's
-- same ~30-day clock.
--
-- On this deployment that is the majority case, not an edge case.
-- Measured right after 051 shipped: of 125 messages still holding a
-- Meta proxy pointer, 106 were `agent` echoes and only 19 were
-- `customer` inbound — counsellors reply from their phones. Mirroring
-- inbound alone would have covered about 15% of the exposure.
--
-- The mirror now runs on the echo path too, writing under the `echo`
-- subfolder rather than `inbound` so a bucket listing still separates
-- what a customer sent from what an agent sent. No schema change is
-- needed for that; only this comment was inaccurate.
--
-- Idempotent — safe to re-run.
--
-- Rollback: restore the previous COMMENT from migration 051.

COMMENT ON COLUMN messages.media_type IS
  'MIME type of media_url''s content, as reported by Meta. Populated for '
  'any media Meta hosts: customer inbound, and agent messages echoed back '
  'from the WhatsApp Business app. NULL for composer sends (whose '
  'media_url is already a durable chat-media object), for text messages, '
  'and for every row written before migration 051.';
