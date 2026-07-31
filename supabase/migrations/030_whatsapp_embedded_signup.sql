-- Metadata needed to operate Meta Embedded Signup connections safely.
-- No tokens or secrets are added here; access_token and verify_token remain
-- encrypted by the existing application encryption layer.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS meta_business_id TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_method TEXT,
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_onboarding_method_check;

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_onboarding_method_check
  CHECK (
    onboarding_method IS NULL OR
    onboarding_method IN ('migration', 'cloud')
  );

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_token_expiry
  ON whatsapp_config (token_expires_at)
  WHERE token_expires_at IS NOT NULL;
