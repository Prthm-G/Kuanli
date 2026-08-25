-- 064_course_content_hardening.sql
-- KB-COURSEINFO-R4-40
--
-- Close four gaps a database review found in 062/063. None of them is exploitable
-- today; all four are the kind that become exploitable quietly.
--
-- ============================================================
-- 1. OWNERSHIP — the grants currently work by accident
-- ============================================================
--
-- `course_content` and `program_aliases` are owned by `n8n_db_user`, not
-- `supabase_admin` like every other application table. They received grants for
-- `authenticated` and `service_role` only because that role still carries a
-- default-ACL entry left by migration 055. Nothing states it.
--
-- Re-apply 062 as a different role — a hotfix run as `postgres`, a rebuild from
-- migrations — and the tables come back with NO grants at all, and the app fails
-- with "permission denied for table course_content" while the RLS and policies
-- look perfectly correct. Migration 055's own header names this exact scenario:
-- "That is exactly what happened to 054 on its first apply."
--
-- ============================================================
-- 2. GRANTS — `program_aliases` is writable by `authenticated`
-- ============================================================
--
-- 062 deliberately gave `program_aliases` a SELECT policy and NO write policy,
-- because it is global reference data only the ETL should write. But the table
-- GRANTS say `authenticated` holds INSERT, UPDATE and DELETE. RLS blocks them
-- today (deny by default when no policy matches), so this is not a live hole -
-- it is a hole waiting for someone to add a permissive policy, or for RLS to be
-- disabled by a future migration bug.
--
-- Migration 056 explicitly rejected exactly this pattern for `payments`:
-- "withholding the grant means a counsellor's client cannot even attempt it."
-- Same reasoning applies here.
--
-- ============================================================
-- 3. `updated_at` IS DEAD ON BOTH TABLES
-- ============================================================
--
-- Both declare `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` and neither has
-- the `update_updated_at_column()` trigger the rest of the schema uses. Today
-- the value is right only because every writer sets it by hand - the panel, the
-- ETL. Anything that forgets (a direct UPDATE, a future code path) leaves it
-- frozen at creation while the row changes underneath it.
--
-- That is worse than a missing column: a timestamp that looks maintained and is
-- not. It also undercuts 062's own reasoning, which leans on timestamps to show
-- staff how current a row is.
--
-- ============================================================
-- 4. `reviewed_by` HAS NO FOREIGN KEY
-- ============================================================
--
-- Every other "who did this" column since 056 references auth.users:
-- payments.logged_by, payments.verified_by, student_fee_plans.created_by,
-- payment_receipts.uploaded_by. `course_content.reviewed_by` is a bare UUID, so
-- it can hold a dangling id, and PostgREST has no relationship to embed a
-- reviewer's name through - the review UI would need a manual second lookup.
--
-- ON DELETE SET NULL, not CASCADE: losing the person must not delete the
-- approved content they signed off. The CHECK added by 062 then forces such a
-- row back through review, which is the correct outcome.
--
-- RLS: unchanged. No policy is added, removed or widened here.
--
-- Rollback:
--   ALTER TABLE course_content DROP CONSTRAINT IF EXISTS course_content_reviewed_by_fkey;
--   DROP TRIGGER IF EXISTS set_updated_at ON course_content;
--   DROP TRIGGER IF EXISTS set_updated_at ON program_aliases;
--   GRANT INSERT, UPDATE, DELETE ON program_aliases TO authenticated;  -- if you really want it back

-- ---- 1. ownership -------------------------------------------------------
ALTER TABLE program_aliases OWNER TO supabase_admin;
ALTER TABLE course_content  OWNER TO supabase_admin;

-- ---- 2. least privilege -------------------------------------------------
-- Reference data: readable by members, written only by the service role.
REVOKE INSERT, UPDATE, DELETE ON program_aliases FROM authenticated;
GRANT  SELECT                  ON program_aliases TO authenticated;

-- Editable content: members with the agent role edit it through the app, and
-- RLS confines them to their own account.
GRANT SELECT, INSERT, UPDATE, DELETE ON course_content TO authenticated;

-- The ETL and the bot endpoint both run as service_role.
GRANT SELECT, INSERT, UPDATE, DELETE ON program_aliases, course_content TO service_role;

-- Migration 055 took anon off every table; keep it that way.
REVOKE ALL ON program_aliases, course_content FROM anon;

-- ---- 3. updated_at ------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON program_aliases;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON program_aliases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON course_content;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON course_content
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---- 4. reviewer attribution -------------------------------------------
-- Clear any dangling reviewer first, so adding the constraint cannot fail on
-- existing data. The CHECK from 062 then pushes such a row back to draft, which
-- is the right outcome for content whose approver no longer exists.
UPDATE course_content
SET status = 'draft', reviewed_by = NULL, reviewed_at = NULL
WHERE reviewed_by IS NOT NULL
  AND reviewed_by NOT IN (SELECT id FROM auth.users);

ALTER TABLE course_content DROP CONSTRAINT IF EXISTS course_content_reviewed_by_fkey;
ALTER TABLE course_content
  ADD CONSTRAINT course_content_reviewed_by_fkey
  FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;
