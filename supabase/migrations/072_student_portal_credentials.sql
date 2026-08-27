-- 072_student_portal_credentials.sql
-- KB-STUPROF-R7-58: saved student portal logins (university UMS/LMS,
-- application portals), so counsellors stop keeping them in chats and
-- notebooks.
--
-- Passwords are AES-256-GCM ciphertext produced by the app's ENCRYPTION_KEY
-- (wacrm/src/lib/whatsapp/encryption.ts — same key and format as the
-- WhatsApp tokens; rotating that key orphans these rows exactly as it
-- orphans the tokens).
--
-- DELIBERATE deviation from the direct-browser-write convention used by
-- contacts: this table has NO PostgREST access for authenticated at all —
-- RLS enabled with zero policies, plus revoked table privileges. Ciphertext
-- must never transit PostgREST, because a `select('*')` anywhere in the
-- client would ship it to the browser. Every read and write goes through
-- /api/contacts/[contactId]/portal-credentials/*, which:
--   1. requires the agent role (requireRole('agent') — 'agent' renders as
--      "Counsellor" in the UI),
--   2. proves account membership by resolving the contact through the
--      CALLER's RLS-scoped client,
--   3. only then touches this table with the service-role client, deriving
--      account_id from the contact row (never from the request body).
--
-- Reveals (decrypt + return plaintext) are audit-logged in
-- student_portal_credential_reveals BEFORE the plaintext leaves the server:
-- the route inserts the audit row first and aborts on failure, so an
-- un-audited reveal is impossible by construction. Same append-only posture
-- as deal_stage_events (migration 042). Label and contact are snapshotted so
-- the audit stays meaningful after the credential (or contact) is deleted.
--
-- Idempotent — safe to run multiple times.

CREATE TABLE IF NOT EXISTS student_portal_credentials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  portal_url TEXT,
  username TEXT,
  password_ciphertext TEXT NOT NULL,
  notes TEXT,
  created_by UUID NOT NULL,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_credentials_contact
  ON student_portal_credentials(contact_id);
CREATE INDEX IF NOT EXISTS idx_portal_credentials_account
  ON student_portal_credentials(account_id);

ALTER TABLE student_portal_credentials ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: deny-all for authenticated (see header).
REVOKE ALL ON student_portal_credentials FROM authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON student_portal_credentials TO service_role;

CREATE TABLE IF NOT EXISTS student_portal_credential_reveals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL,
  contact_id UUID,
  credential_id UUID REFERENCES student_portal_credentials(id) ON DELETE SET NULL,
  credential_label TEXT NOT NULL,
  revealed_by UUID NOT NULL,
  revealed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credential_reveals_account_time
  ON student_portal_credential_reveals(account_id, revealed_at DESC);

ALTER TABLE student_portal_credential_reveals ENABLE ROW LEVEL SECURITY;
-- Admin+ can read the audit trail; nothing writes through PostgREST (the
-- reveal route inserts via service role). No INSERT/UPDATE/DELETE policies.
DROP POLICY IF EXISTS credential_reveals_select ON student_portal_credential_reveals;
CREATE POLICY credential_reveals_select ON student_portal_credential_reveals
  FOR SELECT USING (is_account_member(account_id, 'admin'::account_role_enum));
REVOKE ALL ON student_portal_credential_reveals FROM authenticated, anon;
GRANT SELECT ON student_portal_credential_reveals TO authenticated;
GRANT SELECT, INSERT ON student_portal_credential_reveals TO service_role;

-- Rollback:
--   DROP TABLE IF EXISTS student_portal_credential_reveals;
--   DROP TABLE IF EXISTS student_portal_credentials;
