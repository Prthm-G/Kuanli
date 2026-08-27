-- 066_course_content_approval_guard.sql
-- KB-COURSEINFO-R5-46
--
-- Make `status = 'approved'` mean what the rest of the system already assumes it
-- means: an ADMIN read this exact text and is accountable for it.
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
--
-- 1. THE GATE WAS IN THE WRONG PLACE. Migration 062 gates UPDATE on
--    course_content at `is_account_member(account_id, 'agent')`, while the
--    review UI gates its approve buttons at admin. The panel is a `'use client'`
--    component on the BROWSER Supabase client, so RLS is the only real boundary
--    and the UI check is decoration. Any agent-role user could
--    `PATCH /rest/v1/course_content` and publish fee and eligibility claims
--    straight to a student's phone.
--
--    Note `is_account_member(id, min_role)` is a MINIMUM-role test
--    (owner 4 >= admin 3 >= agent 2), so admins and the owner ALREADY satisfy
--    the 'agent' gate. Requiring admin to publish therefore removes a
--    capability agents should not have had and adds no friction whatsoever to
--    the people who actually drain the review queue.
--
-- 2. THE ATTRIBUTION WAS FORGEABLE. `reviewed_by` was required non-null when
--    approved, but never compared to `auth.uid()` and constrained only to exist
--    in `auth.users` - not to be a member of the same account. Any client could
--    name anyone, including another tenant's user, as the reviewer.
--
-- 3. DELETING A DEPARTED REVIEWER'S USER ROW WAS IMPOSSIBLE. 064 made
--    `reviewed_by` FK to auth.users `ON DELETE SET NULL`; 062's CHECK
--    `course_content_approved_is_attributed` requires `reviewed_by IS NOT NULL`
--    whenever status = 'approved'. SET NULL performs an UPDATE and CHECKs are
--    evaluated on UPDATE, so the delete aborted with a check violation on every
--    approved row that person had signed off. 064's own header claims "the
--    CHECK added by 062 then pushes such a row back to draft, which is the
--    right outcome" - it does not; it makes the deletion fail. This migration
--    makes 064's stated behaviour actually happen.
--
-- ============================================================================
-- WHY A TRIGGER AND NOT TWO RLS POLICIES
-- ============================================================================
--
-- The obvious fix is to split the policy: agents may UPDATE while
-- `status = 'draft'`, admins may publish. Three independent reviewers rejected
-- it for the same reason, which is worth recording because it is not obvious:
--
--   `USING (status = 'draft')` restricts agents to rows that are ALREADY draft,
--   so an agent could no longer fix a typo on a LIVE course without first
--   demoting it. Demoting takes that course dark - the bot serves approved rows
--   only, so the next lead asking about it falls through to an LLM tier that is
--   out of free quota most of the day and gets an apology. The save-in-place
--   path in src/lib/courses/review-actions.ts exists precisely to avoid that,
--   and the policy split would have silently broken it.
--
-- A BEFORE UPDATE trigger expresses the real rule directly - "any update that
-- LEAVES this row approved is a publish" - without constraining what agents may
-- do to drafts, and it covers every client rather than only PostgREST.
--
-- The resulting workflow: an agent may edit any draft freely, and may return a
-- live course to draft in order to work on it. Only an admin can put it back in
-- front of students.
--
-- ============================================================================
-- THE ETL PASSTHROUGH IS LOAD-BEARING - DO NOT REMOVE IT
-- ============================================================================
--
-- devtools/course-content.seed.sql upserts with
--   status = CASE WHEN kb_source_hash IS DISTINCT FROM EXCLUDED.kb_source_hash
--                 THEN 'draft' ELSE course_content.status END
-- so it REWRITES 'approved' onto every unchanged approved row on every run. It
-- runs through psql with no JWT, so `auth.uid()` is NULL. Without the NULL
-- passthrough below, the nightly unattended ETL would either be refused for not
-- being an admin, or have `reviewed_by` overwritten with NULL and trip 062's
-- CHECK. Either way the whole run dies. RLS is bypassed for service_role by
-- design; a trigger is not, so this guard is what keeps the two consistent.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS course_content_approval_guard ON course_content;
--   DROP FUNCTION IF EXISTS course_content_approval_guard();

CREATE OR REPLACE FUNCTION course_content_approval_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
-- SECURITY INVOKER (the default) on purpose. This must run with the caller's
-- identity so auth.uid() is theirs; a DEFINER function here would be a
-- cross-tenant write primitive.
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- (3) The reviewer's user row was deleted and the FK set this to NULL. Demote
  -- rather than let 062's CHECK abort the delete. Must come FIRST: once the row
  -- is draft the publish guard below correctly does not apply to it.
  IF NEW.reviewed_by IS NULL
     AND OLD.reviewed_by IS NOT NULL
     AND NEW.status = 'approved' THEN
    NEW.status := 'draft';
    NEW.reviewed_at := NULL;
    RETURN NEW;
  END IF;

  -- No JWT: the ETL, a migration, or any service_role write. See the note above.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- (1) + (2) Any update that leaves the row approved is a publish.
  IF NEW.status = 'approved' THEN
    IF NOT is_account_member(NEW.account_id, 'admin') THEN
      RAISE EXCEPTION
        'only an admin can publish course content (course_content.id=%)', NEW.id
        USING ERRCODE = '42501';
    END IF;

    -- STAMPED, not checked. A WITH CHECK predicate can only compare against a
    -- value the client supplied; replacing it means no client can forge the
    -- attribution, now or in any future caller.
    NEW.reviewed_by := auth.uid();
    NEW.reviewed_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS course_content_approval_guard ON course_content;
CREATE TRIGGER course_content_approval_guard
  BEFORE UPDATE ON course_content
  FOR EACH ROW
  EXECUTE FUNCTION course_content_approval_guard();

-- INSERT is not covered deliberately. Only the ETL inserts, always as draft, and
-- 062's CHECK already refuses an INSERT that claims approved without
-- attribution. Adding a BEFORE INSERT branch would mean the ETL's own inserts
-- pay for a guard that protects against a caller that does not exist.
