-- 077_label_blank_inbound.sql
--
-- Inbound webhook types the content parser did not read (unsupported, revoke,
-- edit, button) were stored as customer `text` messages with a NULL body. The
-- inbox showed them as blank threads that exist nowhere in the WhatsApp
-- Business app. Most are Meta error 131060 ("message currently unavailable"),
-- fired when someone first messages a coexistence number and the content never
-- arrives. The webhook now labels these at insert time
-- (src/lib/whatsapp/inbound-classification.ts).
--
-- This labels the rows stored before that change. Their raw type is gone (n8n
-- keeps a week of executions and only for bot-active threads), so they all get
-- one neutral label, identical to BACKFILL_LABEL in inbound-classification.ts.
-- That exact string is also how 077_rollback.sql finds them again.
--
-- The UPDATE fires sync_conversation_summary_on_update (migration 028), which
-- recomputes each thread's last_message_text, so previews that read "[text]"
-- pick up the label without touching conversations here.
--
-- Nothing is deleted: each row is a real event Meta sent, and a 131060 is a
-- person who tried to reach us.

BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE public.messages
SET content_text = 'Message content not available in Kuanli (unsupported, edited or deleted on WhatsApp). Check the WhatsApp Business app.'
WHERE sender_type = 'customer'
  AND content_type = 'text'
  AND COALESCE(content_text, '') = ''
  AND media_url IS NULL;

COMMIT;
