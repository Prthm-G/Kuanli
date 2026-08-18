-- 045_application_documents.sql
-- KB-APPDOCS-R4-26
--
-- Document collection + application tracker (roadmap update C). The stretch
-- between Application Started and Enrolled was a black hole: universities
-- need marksheets, ID and photos, all of which arrive as WhatsApp media, and
-- nothing tracked what was received or still missing.
--
-- Model:
--   university_required_docs — per-account checklist per enrollment code
--     (LPU / AMI / DBU, the vocabulary contacts.university holds once a roll
--     number exists). Seeded with the standard six; editable by SQL for now.
--   application_documents — one row per received document. doc_type is NULL
--     until a counsellor classifies it ("unsorted"); resubmissions after a
--     rejection create new rows, the tracker shows the latest per type.
--     status: received -> verified | rejected.
--
-- Capture is a trigger on `messages`: an inbound image/document from a
-- contact whose deal sits at Application Started or Enrolled becomes a
-- `received` row automatically. No Auretris surgery, no webhook surgery —
-- the message row is already the system of record for inbound media.
--
-- Durability: messages.media_url is a proxy over Meta's media store, which
-- expires after ~30 days. Verifying a document archives the bytes into the
-- private `application-docs` bucket (done by the verify API route, which
-- sets storage_path); until then the row serves bytes via the existing
-- media proxy. Marksheets and IDs are PII — the bucket is PRIVATE (unlike
-- chat-media, which must be public for Meta to fetch outbound sends), and
-- reads go through account-scoped storage RLS.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trigger_capture_application_doc ON messages;
--   DROP FUNCTION IF EXISTS capture_application_document();
--   DROP TABLE IF EXISTS application_documents;
--   DROP TABLE IF EXISTS university_required_docs;
--   DELETE FROM storage.buckets WHERE id = 'application-docs';

CREATE TABLE IF NOT EXISTS university_required_docs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL,
  university TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, university, doc_type)
);

CREATE TABLE IF NOT EXISTS application_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  doc_type TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'verified', 'rejected')),
  mime_type TEXT,
  storage_path TEXT,
  note TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_application_documents_contact
  ON application_documents(contact_id, created_at DESC);

ALTER TABLE university_required_docs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members read required docs" ON university_required_docs;
CREATE POLICY "Members read required docs" ON university_required_docs
  FOR SELECT USING (is_account_member(account_id));

ALTER TABLE application_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members read application documents" ON application_documents;
CREATE POLICY "Members read application documents" ON application_documents
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS "Agents update application documents" ON application_documents;
CREATE POLICY "Agents update application documents" ON application_documents
  FOR UPDATE USING (is_account_member(account_id, 'agent'::account_role_enum))
  WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));

GRANT SELECT ON university_required_docs TO authenticated, service_role;
GRANT SELECT, UPDATE ON application_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE ON application_documents TO service_role;

-- Auto-capture inbound media for contacts in the application phase.
CREATE OR REPLACE FUNCTION capture_application_document() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_id uuid;
  v_account_id uuid;
BEGIN
  IF NEW.sender_type <> 'customer'
     OR NEW.content_type NOT IN ('image', 'document') THEN
    RETURN NEW;
  END IF;

  SELECT c.contact_id, c.account_id INTO v_contact_id, v_account_id
  FROM conversations c WHERE c.id = NEW.conversation_id;

  IF v_contact_id IS NULL THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM deals d
    JOIN pipeline_stages ps ON ps.id = d.stage_id
    WHERE d.contact_id = v_contact_id
      AND ps.name IN ('Application Started', 'Enrolled')
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO application_documents (account_id, contact_id, message_id, status)
  VALUES (v_account_id, v_contact_id, NEW.id, 'received');

  RETURN NEW;
END;
$$;

ALTER FUNCTION capture_application_document() OWNER TO postgres;
REVOKE ALL ON FUNCTION capture_application_document() FROM PUBLIC;

DROP TRIGGER IF EXISTS trigger_capture_application_doc ON messages;
CREATE TRIGGER trigger_capture_application_doc
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION capture_application_document();

-- Private storage bucket for archived documents (PII: no public access).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'application-docs',
  'application-docs',
  false,
  16777216,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Account-scoped read for members, same path convention as flow-media (020):
-- application-docs/account-<account_id>/...
DROP POLICY IF EXISTS "Members read application docs" ON storage.objects;
CREATE POLICY "Members read application docs" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'application-docs'
    AND is_account_member(
      NULLIF(replace(split_part(name, '/', 1), 'account-', ''), '')::uuid
    )
  );

-- Seed the standard checklist per account and enrollment code (idempotent).
INSERT INTO university_required_docs (account_id, university, doc_type, label, position)
SELECT a.id, u.university, v.doc_type, v.label, v.position
FROM accounts a
CROSS JOIN (VALUES ('LPU'), ('AMI'), ('DBU')) AS u(university)
CROSS JOIN (VALUES
  ('photo',          'Passport-size photo',        1),
  ('signature',      'Signature (photo/scan)',     2),
  ('id_proof',       'Aadhaar / photo ID',         3),
  ('marksheet_10',   '10th marksheet',             4),
  ('marksheet_12',   '12th marksheet',             5),
  ('grad_marksheet', 'Graduation marksheet (PG)',  6)
) AS v(doc_type, label, position)
WHERE NOT EXISTS (
  SELECT 1 FROM university_required_docs r
  WHERE r.account_id = a.id AND r.university = u.university AND r.doc_type = v.doc_type
);
