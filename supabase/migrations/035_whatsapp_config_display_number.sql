-- 035_whatsapp_config_display_number.sql
-- KB-MULTINUM-R4-12 (inbox surfacing)
--
-- Store each number's human-readable display number (e.g. +91 95922 00021)
-- alongside its opaque Meta phone_number_id, so the shared inbox can badge each
-- conversation with the number the lead is talking to. Populated by
-- POST /api/whatsapp/config from Meta's verifyPhoneNumber (display_phone_number)
-- whenever a number is saved/re-saved; nullable so existing rows stay valid
-- until then.
--
-- Rollback:
--   ALTER TABLE whatsapp_config DROP COLUMN IF EXISTS display_phone_number;

ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS display_phone_number TEXT;
