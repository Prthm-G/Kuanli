-- 063_program_level.sql
-- KB-COURSEINFO-R4-40
--
-- Give `program_aliases` a study level, so the bot can offer every programme
-- instead of the nine it happens to have hardcoded.
--
-- THE PROBLEM THIS SOLVES. A WhatsApp interactive list carries at most TEN rows
-- in total, across all sections (INTERACTIVE_LIMITS.maxListRowsTotal in
-- src/lib/whatsapp/meta-api.ts). `Build Course List` is already at exactly ten:
-- nine hardcoded courses plus "Type it instead". LPU Distance has fifteen
-- programmes with complete fees, prose and brochures.
--
-- So six sellable programmes - BLIS, BSc IT, DBA, DCA, DLIS, MLIS - are
-- unreachable. Not missing data: fully priced, fully described, with brochures
-- on disk, and no way for a lead to ask for them. The only thing in the way is
-- the length of a hardcoded array.
--
-- Asking for the level first splits fifteen into 6 / 6 / 3, all of which fit,
-- and it scales: Amity and DBU can be added later without another redesign.
--
-- WHY A COLUMN AND NOT A CASE EXPRESSION. Level is derivable from the first
-- letter of LPU's programme codes today (B = bachelor, M = master, D = diploma)
-- and that is exactly the kind of coincidence that silently breaks later. DBA
-- here is a Diploma in Business Administration; at another university the same
-- three letters are a doctorate. Storing the level says what we mean instead of
-- inferring it from spelling.
--
-- RLS: `program_aliases` is global reference data with a SELECT-only policy for
-- authenticated members (migration 062). Adding a column needs no policy change.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_program_aliases_level;
--   ALTER TABLE program_aliases DROP COLUMN IF EXISTS level;

ALTER TABLE program_aliases
  ADD COLUMN IF NOT EXISTS level TEXT
  CHECK (level IS NULL OR level IN ('ug', 'pg', 'diploma'));

COMMENT ON COLUMN program_aliases.level IS
  'Study level, used to split the course menu across two WhatsApp lists because one list holds only 10 rows. NULL means "do not offer in the menu".';

-- The step-two lookup: every offerable programme at one level, for one
-- university and mode.
CREATE INDEX IF NOT EXISTS idx_program_aliases_level
  ON program_aliases(university, mode, level)
  WHERE level IS NOT NULL AND bot_course_token IS NOT NULL;
