-- 067_fee_drift_demotes_course.sql
-- KB-COURSEINFO-R5-47
--
-- Approving a course sheet attests to its FEES as well as its prose. Nothing
-- was re-checking the fees afterwards.
--
-- ============================================================================
-- THE GAP
-- ============================================================================
--
-- `course_content` holds prose only. Fees live in `fee_templates` and are read
-- live at compose time, which is deliberate and right: one price list, no
-- copies to drift.
--
-- The review panel previews the REAL composer against the REAL fee rows, so an
-- admin approving a course genuinely did see the fee block that goes out. The
-- gap is what happens next. `kb_source_hash` returns a row to `draft` the
-- moment the knowledge base moves underneath it - that mechanism exists
-- precisely because approval means "a human read THIS". But it watches only the
-- prose. Someone corrects a fee in Settings > Fee plans and the approved course
-- keeps sending, now quoting a number nobody reviewed, with `reviewed_at` still
-- pointing at the older review.
--
-- Migration 062 calls fee data the highest-liability content in the system, and
-- 059/060 exist because it has already been wrong twice. So the one kind of
-- change most likely to be wrong was the one kind that could not demote a
-- course.
--
-- ============================================================================
-- THE MECHANISM
-- ============================================================================
--
-- Same shape as `kb_source_hash`, one table over. `fee_fingerprint` is a digest
-- of every active fee row that the composer would match for this course. When
-- a fee row is inserted, updated or deleted, any approved course whose
-- fingerprint no longer matches is returned to draft.
--
-- The matching rule is `norm()` - upper-case, strip non-alphanumerics - because
-- that is what `queries.ts` uses to pair a course with its fee rows. A plain
-- UPPER() join would audit a narrower set than the bot actually quotes: an
-- operator typing "Pol Science" where the alias says "Polscience" produces a
-- row the composer matches and a stricter join misses.
--
-- COST OF BEING WRONG IN EACH DIRECTION. Demoting unnecessarily takes a course
-- dark and sends leads to the out-of-quota LLM. Failing to demote quotes an
-- unreviewed price to a student. For an admissions intermediary the second is
-- the one that ends in a refund argument, so this errs toward demoting.
--
-- WHY A STORED COLUMN AND NOT A VIEW. The comparison has to survive across
-- sessions to answer "have the fees moved since approval", which is a question
-- about the past. A view can only ever describe now.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS fee_templates_demote_courses ON fee_templates;
--   DROP FUNCTION IF EXISTS demote_courses_on_fee_drift();
--   DROP FUNCTION IF EXISTS course_fee_fingerprint(UUID, TEXT, TEXT, TEXT, TEXT);
--   ALTER TABLE course_content DROP COLUMN IF EXISTS fee_fingerprint;

ALTER TABLE course_content
  ADD COLUMN IF NOT EXISTS fee_fingerprint TEXT;

COMMENT ON COLUMN course_content.fee_fingerprint IS
  'Digest of the active fee_templates rows this course was approved against. '
  'Compared by the fee_templates trigger; a mismatch returns the row to draft. '
  'The fee-side twin of kb_source_hash.';

-- The digest. STABLE, not IMMUTABLE: it reads another table.
CREATE OR REPLACE FUNCTION course_fee_fingerprint(
  p_account_id UUID, p_university TEXT, p_mode TEXT,
  p_program TEXT, p_specialization TEXT
) RETURNS TEXT
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- ORDER BY is load-bearing: without it the digest depends on heap order and
  -- the fingerprint would change spontaneously, demoting healthy courses.
  SELECT md5(COALESCE(string_agg(
    ft.payment_option || ':' || ft.term_count || ':' || ft.programme_fee || ':' ||
    COALESCE(ft.exam_fee,0) || ':' || ft.total_fee || ':' ||
    COALESCE(ft.application_fee,0) || ':' || COALESCE(ft.study_material_fee,0),
    '|' ORDER BY ft.payment_option, ft.term_count, ft.total_fee
  ), ''))
  FROM fee_templates ft
  WHERE ft.active
    AND ft.account_id = p_account_id
    AND ft.university = p_university
    AND ft.mode       = p_mode
    -- norm(): matches queries.ts, NOT a plain UPPER(). See the header.
    AND regexp_replace(UPPER(ft.program), '[^A-Z0-9]', '', 'g')
      = regexp_replace(UPPER(p_program), '[^A-Z0-9]', '', 'g')
    AND regexp_replace(UPPER(COALESCE(ft.specialization,'')), '[^A-Z0-9]', '', 'g')
      = regexp_replace(UPPER(COALESCE(p_specialization,'')), '[^A-Z0-9]', '', 'g')
$$;

CREATE OR REPLACE FUNCTION demote_courses_on_fee_drift()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r RECORD;
BEGIN
  -- On DELETE only OLD is populated; on INSERT only NEW. Take whichever
  -- identifies the course family whose prices just moved.
  FOR r IN
    SELECT DISTINCT cc.id, cc.account_id, cc.university, cc.mode,
                    cc.program, cc.specialization
    FROM course_content cc
    WHERE cc.status = 'approved'
      AND cc.account_id = COALESCE(NEW.account_id, OLD.account_id)
      AND cc.university  = COALESCE(NEW.university, OLD.university)
      AND cc.mode        = COALESCE(NEW.mode, OLD.mode)
      AND regexp_replace(UPPER(cc.program), '[^A-Z0-9]', '', 'g')
        = regexp_replace(UPPER(COALESCE(NEW.program, OLD.program)), '[^A-Z0-9]', '', 'g')
  LOOP
    IF COALESCE(
         (SELECT fee_fingerprint FROM course_content WHERE id = r.id), ''
       ) IS DISTINCT FROM
       course_fee_fingerprint(r.account_id, r.university, r.mode,
                              r.program, r.specialization)
    THEN
      -- Straight to draft. reviewed_by/reviewed_at are cleared because the
      -- review they record was of a different price, and 062's CHECK only
      -- requires them while approved.
      UPDATE course_content
         SET status = 'draft', reviewed_by = NULL, reviewed_at = NULL,
             updated_at = now()
       WHERE id = r.id;
    END IF;
  END LOOP;
  RETURN NULL;  -- AFTER trigger
END;
$$;

DROP TRIGGER IF EXISTS fee_templates_demote_courses ON fee_templates;
CREATE TRIGGER fee_templates_demote_courses
  AFTER INSERT OR UPDATE OR DELETE ON fee_templates
  FOR EACH ROW
  EXECUTE FUNCTION demote_courses_on_fee_drift();

-- The approval guard from 066 now also records WHICH prices were approved.
-- Without this a course demoted by fee drift would keep its stale fingerprint,
-- and the very next fee trigger would demote it again the instant it was
-- re-approved - an un-approvable course, which is worse than the gap this
-- migration closes.
--
-- Everything else in this function is unchanged from 066; see that file for why
-- the auth.uid() passthrough is load-bearing and why this is a trigger rather
-- than a pair of RLS policies.
CREATE OR REPLACE FUNCTION course_content_approval_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.reviewed_by IS NULL
     AND OLD.reviewed_by IS NOT NULL
     AND NEW.status = 'approved' THEN
    NEW.status := 'draft';
    NEW.reviewed_at := NULL;
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    -- Still fingerprint on the ETL path: it can legitimately leave a row
    -- approved, and an approved row with no fingerprint is the state the
    -- baseline below exists to avoid.
    IF NEW.status = 'approved' AND NEW.fee_fingerprint IS NULL THEN
      NEW.fee_fingerprint := course_fee_fingerprint(
        NEW.account_id, NEW.university, NEW.mode, NEW.program, NEW.specialization);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'approved' THEN
    IF NOT is_account_member(NEW.account_id, 'admin') THEN
      RAISE EXCEPTION
        'only an admin can publish course content (course_content.id=%)', NEW.id
        USING ERRCODE = '42501';
    END IF;
    NEW.reviewed_by := auth.uid();
    NEW.reviewed_at := now();
    -- Attest to the prices as well as the prose.
    NEW.fee_fingerprint := course_fee_fingerprint(
      NEW.account_id, NEW.university, NEW.mode, NEW.program, NEW.specialization);
  END IF;

  RETURN NEW;
END;
$$;

-- Baseline every currently approved course against the prices it is serving
-- TODAY. Without this every approved row has a NULL fingerprint and the first
-- fee edit of any kind demotes the entire catalogue at once.
UPDATE course_content cc
   SET fee_fingerprint = course_fee_fingerprint(
         cc.account_id, cc.university, cc.mode, cc.program, cc.specialization)
 WHERE cc.status = 'approved'
   AND cc.fee_fingerprint IS NULL;
