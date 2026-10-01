-- 077_rollback.sql
-- Reverts 077 by returning the labelled rows to a NULL body.
--
-- Matches on the exact label 077 wrote, which nothing else produces: the
-- webhook's own labels for new messages use different wording. The summary
-- trigger restores each thread's "[text]" preview.

BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE public.messages
SET content_text = NULL
WHERE sender_type = 'customer'
  AND content_type = 'text'
  AND media_url IS NULL
  AND content_text = 'Message content not available in Kuanli (unsupported, edited or deleted on WhatsApp). Check the WhatsApp Business app.';

COMMIT;
