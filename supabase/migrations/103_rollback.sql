-- 103_rollback.sql  (KB-GRANTS-103) - puts back the grants 103 removed, exactly as they were before it, and turns row
-- level security off on admission_import_staging again. Run as the owner or a superuser, with psql -1.
SET LOCAL lock_timeout = '5s';
GRANT EXECUTE ON FUNCTION public.recompute_broadcast_counts(uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_automation_execution_count(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_flow_execution_count(uuid) TO anon, authenticated;
ALTER TABLE public.admission_import_staging DISABLE ROW LEVEL SECURITY;
