-- 062_course_content.sql
-- KB-COURSEINFO-R4-40
--
-- Two tables that let the bot answer "tell me about LPU Distance BA" from data
-- instead of from a language model.
--
-- Why this exists: `Lead Classifier` in `Auretris - Main` ALREADY resolves
-- (university, mode, course) deterministically from the list-reply tokens it
-- sends itself — `sel:course:LPU:Distance:BA`. It then hands those resolved
-- slots to an LLM purely to PHRASE an overview. The model computes nothing it
-- was not already told. On 2026-08-20 that cost 92 of 250 turns: both providers
-- exhausted their daily free-tier quota (Gemini 03:28, Groq 08:18) and every
-- lead after that got "I'm unable to verify that accurately right now" — while
-- click-to-WhatsApp ads kept paying to send them.
--
-- ============================================================
-- WHY PROSE IS COPIED AND FEES ARE NOT
-- ============================================================
--
-- These are deliberately different strategies, for different reasons.
--
-- FEES ARE NEVER COPIED HERE. `fee_templates` (migration 056, corrected by 059
-- and 060) stays the single source and is read live at compose time. It is
-- numeric, correctly keyed, and has already been wrong twice; a second copy
-- would be a drift surface on the highest-liability data in the system. There
-- are deliberately NO fee columns below.
--
-- PROSE IS COPIED, because it has to be. The knowledge tables
-- (`lpu_distance_university_knowledge`, `lpu_university_knowledge`) live in the
-- **n8n_database**, not here. Postgres cannot join across databases — the same
-- wall documented in migration 038, which is why the interest mirror exists at
-- all. Kuanli therefore cannot read them at runtime under any design.
--
-- Copying is also what "staff-editable" requires. If the composer re-read the
-- KB on every request, a counsellor's correction would be silently overwritten
-- by the next read. `course_content` is the source of truth for wording once
-- populated; `kb_synced_at` records when the ETL last touched a row so drift
-- from the KB is visible rather than assumed.
--
-- ============================================================
-- WHY THE TWO TABLES HAVE DIFFERENT TENANCY
-- ============================================================
--
-- This is a deliberate split, not an oversight.
--
-- `program_aliases` is GLOBAL REFERENCE DATA. It records that LPU's fee table
-- spells a subject `Polscience`, its knowledge base spells it
-- `Political Science`, and the brochure on disk is `Ma_Polscience.pdf`. That is
-- a fact about LPU, not about any Skeure account, and every account resolves it
-- identically. Giving it an account_id would mean seeding N identical copies
-- and letting them diverge. Readable by any authenticated member; written only
-- by the service role running the ETL.
--
-- `course_content` is ACCOUNT-SCOPED, like every table since migration 017,
-- because it is editable. Two accounts may legitimately word the same programme
-- differently, and an account must not be able to edit another's copy.
--
-- ============================================================
-- THE draft/approved LIFECYCLE IS A SAFETY MECHANISM
-- ============================================================
--
-- Every ETL'd row lands as `draft`. Only `approved` rows are ever served; an
-- unapproved combination falls through to the LLM path exactly as today.
--
-- This is what makes spot-checking survivable rather than reckless. The
-- operator chose to spot-check the seeded data rather than review all 41
-- reachable combinations. Without this column that would mean unreviewed fee
-- and eligibility claims reaching real admissions leads as authoritative,
-- quotable statements. With it, unreviewed content is UNREACHABLE, not merely
-- unverified, and the review queue drains at whatever pace the business allows.
--
-- The CHECK below enforces the lifecycle in SQL rather than trusting the UI: a
-- row cannot be `approved` without recording who approved it and when.
--
-- ============================================================
-- RLS
-- ============================================================
--
-- `course_content` follows the account-scoped posture established by migration
-- 017 (is_account_member), which superseded the original auth.uid() = user_id
-- policy from migration 001. `program_aliases` is reference data: SELECT for
-- authenticated members, and no INSERT/UPDATE/DELETE policy at all, so only the
-- service role can write it. Neither table widens access and neither disables
-- RLS.
--
-- Rollback:
--   DROP TABLE IF EXISTS course_content;
--   DROP TABLE IF EXISTS program_aliases;

-- ============================================================
-- program_aliases — the crosswalk (global reference data)
-- ============================================================

CREATE TABLE IF NOT EXISTS program_aliases (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  university               TEXT NOT NULL,
  mode                     TEXT NOT NULL CHECK (mode IN ('online', 'distance')),

  -- The spine. Matches fee_templates.program / .specialization exactly, so a
  -- fee lookup is a direct equality join with no normalisation at query time.
  fee_program              TEXT NOT NULL,
  fee_specialization       TEXT NOT NULL DEFAULT '',

  -- One display spelling for a subject, reconciling the five that exist.
  -- fee_templates itself disagrees between modes: `distance` says `Polscience`
  -- where `online` says `Political Science`, for the same subject.
  canonical_specialization TEXT NOT NULL DEFAULT '',

  -- How the knowledge base names the same programme (`BCOM` -> `BCom`,
  -- `BSC`+`It` -> `BSc IT`).
  kb_program               TEXT,
  -- True when KB prose is per-specialization rather than per-programme. For
  -- MA the specialization appears ONLY inside the question text, e.g.
  -- "What is the eligibility for LPU Distance M.A. Political Science?".
  kb_spec_specific         BOOLEAN NOT NULL DEFAULT FALSE,

  -- Repo-relative path under brochures/. Resolved by folder convention, which
  -- differs by mode: distance uses `M.A`, online uses `MA`.
  brochure_path            TEXT,

  -- The token `Build Course List` emits in sel:course:<uni>:<mode>:<token>.
  -- NULL means the course menu cannot produce this combination at all, so it
  -- is unreachable deterministically no matter how complete its content is.
  bot_course_token         TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (university, mode, fee_program, fee_specialization)
);

-- The composer's only lookup: resolve a bot token back to the fee spine.
CREATE INDEX IF NOT EXISTS idx_program_aliases_token
  ON program_aliases(university, mode, bot_course_token)
  WHERE bot_course_token IS NOT NULL;

ALTER TABLE program_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS program_aliases_select ON program_aliases;
CREATE POLICY program_aliases_select ON program_aliases
  FOR SELECT USING (auth.role() = 'authenticated');
-- Deliberately no INSERT/UPDATE/DELETE policy: the ETL writes as service role.

-- ============================================================
-- course_content — curated prose (account-scoped, editable)
-- ============================================================

CREATE TABLE IF NOT EXISTS course_content (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  university     TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('online', 'distance')),
  program        TEXT NOT NULL,
  specialization TEXT NOT NULL DEFAULT '',

  -- Hindi is deferred to v2. The column exists from the start so adding Hindi
  -- later is an INSERT rather than a migration, but only 'en' rows are seeded:
  -- translating the labels while leaving the prose in English produces a sheet
  -- that reads as broken, which is worse than English throughout.
  lang           TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en', 'hi')),

  overview       TEXT,
  duration       TEXT,
  eligibility    TEXT,
  credits        TEXT,
  medium         TEXT,
  careers        TEXT,
  electives      TEXT,

  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  reviewed_by    UUID,
  reviewed_at    TIMESTAMPTZ,

  -- When the ETL last wrote this row from the knowledge base. Lets staff see
  -- that a row predates a KB change instead of assuming it is current.
  kb_synced_at   TIMESTAMPTZ,

  -- Fingerprint of the knowledge-base text this row was built from.
  --
  -- Without it, "ETL'd once" is a one-time migration pretending to be a sync
  -- strategy: a counsellor edits the KB six weeks from now and the approved
  -- copy here goes stale silently, still being quoted to leads as fact. On each
  -- re-run the ETL recomputes this hash; when it differs, the row is returned
  -- to `draft` and re-enters the review queue. Review is therefore re-triggered
  -- exactly when the underlying facts move, and never otherwise.
  kb_source_hash TEXT,

  -- Set when a field deliberately contradicts the knowledge base. First use:
  -- LPU Distance BA duration. The KB says "Minimum 2 years, maximum 4 years";
  -- the brochure says "3 years (Maximum 6 years)". Operator ruled 2026-08-20
  -- that the brochure wins, consistent with the LPU Distance provenance ruling
  -- already recorded in decisions/log.md.
  override_notes TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (account_id, university, mode, program, specialization, lang),

  -- Approval must be attributable. Enforced here rather than in the UI so a
  -- direct UPDATE cannot quietly publish unreviewed content.
  CONSTRAINT course_content_approved_is_attributed CHECK (
    status <> 'approved' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

-- The serve path: one approved row for one course in one language.
CREATE INDEX IF NOT EXISTS idx_course_content_serve
  ON course_content(account_id, university, mode, program, specialization, lang)
  WHERE status = 'approved';

-- The review queue.
CREATE INDEX IF NOT EXISTS idx_course_content_review
  ON course_content(account_id, status);

ALTER TABLE course_content ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS course_content_select ON course_content;
DROP POLICY IF EXISTS course_content_insert ON course_content;
DROP POLICY IF EXISTS course_content_update ON course_content;
DROP POLICY IF EXISTS course_content_delete ON course_content;

CREATE POLICY course_content_select ON course_content
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY course_content_insert ON course_content
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY course_content_update ON course_content
  FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY course_content_delete ON course_content
  FOR DELETE USING (is_account_member(account_id, 'agent'));
