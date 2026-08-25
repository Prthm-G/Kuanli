-- 069_offerable_programmes.sql
-- KB-COURSEINFO-R5-51
--
-- The menu can no longer offer what the endpoint cannot answer.
--
-- ============================================================================
-- THE ROOT CAUSE THIS CLOSES
-- ============================================================================
--
-- On 2026-08-20 a lead tapped LPU distance BLIS. The menu offered it because a
-- `program_aliases` row existed; the endpoint 404'd because no APPROVED
-- `course_content` row existed yet; the turn degraded to the quota-dead LLM and
-- the lead got an apology. `program_aliases` decides what is OFFERED,
-- `course_content` decides what can be ANSWERED, and nothing enforced that the
-- first is a subset of the second.
--
-- The n8n menu query (`Load Programmes For Level`) read program_aliases alone.
-- The comment on its builder node claims "a programme appears the moment it has
-- content and stays hidden while it does not" - false until now. This view
-- makes it true by construction: the menu query moves onto the view, and a
-- token simply does not exist for an account+language until an approved row
-- backs it.
--
-- WHY A VIEW AND NOT A CONSTRAINT. Three reviewers converged on the same
-- reasons: a trigger enforcing "every offered programme has approved content"
-- would BLOCK the ETL's safety demotion (approved -> draft on KB drift),
-- turning the drift detector into a constraint violation; the invariant is
-- quantified over accounts x languages while an FK is a single-row reference
-- with no key to point at; and the crosswalk is seeded before any content
-- exists, so a hard dependency breaks seeding order.
--
-- security_invoker is LOAD-BEARING. Without it the view runs as its owner
-- (postgres) and leaks every account's coverage to any authenticated member.
-- PG15 supports it; this stack runs postgres:15.
--
-- Rollback:
--   DROP VIEW IF EXISTS offerable_programmes;
--   DROP INDEX IF EXISTS idx_course_content_coverage;
--   DROP INDEX IF EXISTS uq_program_aliases_token_general;

CREATE OR REPLACE VIEW offerable_programmes
WITH (security_invoker = true) AS
SELECT cc.account_id,
       pa.university,
       pa.mode,
       pa.level,
       cc.lang,
       pa.bot_course_token,
       pa.fee_program,
       pa.fee_specialization,
       pa.canonical_specialization,
       pa.brochure_path
FROM program_aliases pa
JOIN course_content cc
  ON  cc.university     = pa.university
  AND cc.mode           = pa.mode
  AND cc.program        = pa.fee_program
  AND cc.specialization = pa.fee_specialization
  -- The invariant itself. Never relax: it is the whole point of the view.
  AND cc.status         = 'approved'
WHERE pa.level IS NOT NULL
  AND pa.bot_course_token IS NOT NULL;

GRANT SELECT ON offerable_programmes TO authenticated, service_role;

-- The join above has no account_id on the pa side, so idx_course_content_serve
-- (which leads with account_id then equality on all six) serves the endpoint
-- but not this coverage shape. Small table today; correct shape for when it
-- is not.
CREATE INDEX IF NOT EXISTS idx_course_content_coverage
  ON course_content (university, mode, program, specialization, lang, account_id)
  WHERE status = 'approved';

-- Latent coin flip, closed while the table is clean (verified zero
-- collisions): two alias rows sharing (university, mode, token) with an empty
-- specialization would make resolveAlias's general-row pick order-dependent,
-- and it has no ORDER BY.
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_aliases_token_general
  ON program_aliases (university, mode, bot_course_token)
  WHERE bot_course_token IS NOT NULL
    AND (fee_specialization IS NULL OR fee_specialization = '');
