-- Remove the discontinued WhatsApp Business app coexistence implementation.
-- Standard Cloud API and Solution Partner migration metadata are preserved.

DROP TABLE IF EXISTS whatsapp_coexistence_events;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_history_sync_status_check,
  DROP CONSTRAINT IF EXISTS whatsapp_config_history_sync_progress_check,
  DROP COLUMN IF EXISTS contacts_sync_request_id,
  DROP COLUMN IF EXISTS history_sync_request_id,
  DROP COLUMN IF EXISTS data_sync_started_at,
  DROP COLUMN IF EXISTS history_sync_status,
  DROP COLUMN IF EXISTS history_sync_progress,
  DROP COLUMN IF EXISTS history_sync_phase,
  DROP COLUMN IF EXISTS history_sync_error,
  DROP COLUMN IF EXISTS last_coexistence_event_at;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_onboarding_method_check;

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_onboarding_method_check
  CHECK (
    onboarding_method IS NULL OR
    onboarding_method IN ('migration', 'cloud')
  );
