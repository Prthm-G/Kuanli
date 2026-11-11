-- 095_admissions_stages.sql  (KB-ADMISSIONS-R0)
-- Admissions Release 0. Idempotent: every statement is safe to run twice.
-- Task 1: three new stages on every admissions board, and a position lookup by stage name.

-- Callers compare stage positions through this helper, never against a literal number.
CREATE OR REPLACE FUNCTION public.stage_position(p_pipeline_id uuid, p_name text)
RETURNS int LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT position FROM public.pipeline_stages WHERE pipeline_id = p_pipeline_id AND name = p_name LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.stage_position(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stage_position(uuid, text) TO authenticated, service_role;

-- Provisional ID, Form & Documents and Fee Submitted go between Application Started and Enrolled on every board that
-- has an Application Started stage. Deals keep their stage rows (they point at stage ids); only positions shift.
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT pipeline_id, position AS app_pos FROM public.pipeline_stages WHERE name = 'Application Started' LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.pipeline_stages WHERE pipeline_id = p.pipeline_id AND name = 'Provisional ID');
    UPDATE public.pipeline_stages SET position = position + 3 WHERE pipeline_id = p.pipeline_id AND position > p.app_pos;
    INSERT INTO public.pipeline_stages (pipeline_id, name, position, color) VALUES
      (p.pipeline_id, 'Provisional ID',   p.app_pos + 1, '#0ea5e9'),
      (p.pipeline_id, 'Form & Documents', p.app_pos + 2, '#6366f1'),
      (p.pipeline_id, 'Fee Submitted',    p.app_pos + 3, '#14b8a6');
  END LOOP;
  IF (SELECT count(DISTINCT m) FROM (SELECT string_agg(name||':'||position, ',' ORDER BY position) m
        FROM public.pipeline_stages WHERE pipeline_id IN (SELECT pipeline_id FROM public.pipeline_stages WHERE name = 'Application Started')
        GROUP BY pipeline_id) x) > 1 THEN
    RAISE EXCEPTION '095: admissions pipelines disagree on stage positions';
  END IF;
END $$;
