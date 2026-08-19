-- 051_inbound_media_mirror.sql
-- KB-MEDIAMIRROR-R4-31
--
-- Inbound media is never persisted. The webhook verifies the Meta media
-- id and stores a POINTER — `/api/whatsapp/media/<id>` — and that route
-- re-streams the bytes from Meta on every view. Meta deletes media
-- roughly 30 days after receipt, so every inbound photo, voice note and
-- document silently rots into "Photo unavailable". No amount of UI can
-- recover it; the bytes are simply gone.
--
-- Outbound media already survives: the composer uploads to the public
-- `chat-media` bucket (migration 023) and stores a durable URL. This
-- migration is the schema half of doing the same for inbound.
--
-- Narrower than it looks vs. migration 045: that one archives
-- application documents an agent has explicitly VERIFIED into the
-- private `application-docs` bucket. Everything else — photos, voice
-- notes, and documents nobody has verified yet — still points at Meta
-- and still expires. This closes that gap.
--
-- Ported from upstream ArnasDon/wacrm `039_inbound_media_mirror.sql`
-- (issue #466), renumbered to 051 because our 034-050 are unrelated.
--
-- Three changes:
--
--   1. `messages.media_type` — the MIME type the webhook has always had
--      in hand and always discarded (`void mediaType` in
--      `webhook/route.ts`). Without it, a download has to guess the file
--      extension from the fetched blob, which only works once the bytes
--      have already been fetched successfully.
--
--   2. `whatsapp_config.mirror_inbound_media` — the per-account
--      opt-OUT. Mirroring every inbound attachment is unbounded storage
--      growth on a self-hosted Supabase project, so it has to be
--      switchable. It defaults to TRUE because the thing being fixed is
--      silent data loss: an account that never finds the setting should
--      be the one that keeps its attachments, not the one that keeps
--      losing them.
--
--   3. Widens the `chat-media` MIME allow-list with the types Meta can
--      hand us on the way IN but that we never send out — animated
--      GIFs, bare Opus, QuickTime video, and Meta's own `video/3gp`
--      spelling of `video/3gpp`. The bucket's allow-list is enforced by
--      Storage for the service role too, so without this an inbound GIF
--      is rejected at upload and falls back to the proxy (i.e. still
--      expires). Mirrors `EXTENSION_BY_MIME` in
--      `src/lib/media/filename.ts`.
--
-- NO BACKFILL IS POSSIBLE. Media Meta has already expired cannot be
-- recovered, and media still inside the 30-day window would need the
-- account's access token, which is encrypted at rest and only
-- decryptable by the app. Existing rows keep their proxy URL and the
-- proxy route keeps serving them for as long as Meta still has them.
--
-- Idempotent — safe to re-run.
--
-- Rollback:
--   ALTER TABLE messages DROP COLUMN IF EXISTS media_type;
--   ALTER TABLE whatsapp_config DROP COLUMN IF EXISTS mirror_inbound_media;
--   (the MIME allow-list widening is additive and safe to leave)

-- ============================================================
-- 1. messages.media_type
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_type TEXT;

COMMENT ON COLUMN messages.media_type IS
  'MIME type of media_url''s content, as reported by Meta. Populated for '
  'INBOUND media only: an outbound media_url is a chat-media object whose '
  'path already carries the original filename and extension, so the type '
  'adds nothing there. Also NULL for text messages and for every row '
  'written before migration 051.';

-- ============================================================
-- 2. whatsapp_config.mirror_inbound_media
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS mirror_inbound_media BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN whatsapp_config.mirror_inbound_media IS
  'When true (default), the inbound webhook copies received media into '
  'the chat-media bucket so it outlives Meta''s ~30-day retention. Turn '
  'off to keep storage flat and accept that attachments expire.';

-- ============================================================
-- 3. chat-media: allow the inbound-only MIME types
-- ============================================================
-- Additive: keeps every type already on the list and appends only the
-- ones missing, so re-running cannot narrow the allow-list.
UPDATE storage.buckets
SET allowed_mime_types = (
  SELECT array_agg(DISTINCT t ORDER BY t)
  FROM unnest(
    allowed_mime_types || ARRAY[
      'image/gif',
      'audio/opus',
      'video/quicktime',
      'video/3gp'
    ]
  ) AS t
)
WHERE id = 'chat-media';
