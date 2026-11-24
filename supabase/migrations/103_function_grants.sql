-- 103_function_grants.sql  (KB-GRANTS-103)
-- Closes what 007 and 012 meant to close. Three SECURITY DEFINER functions write with their owner's rights for any id
-- they are given, and anon and authenticated could still call them through the API: recompute_broadcast_counts
-- (PUBLIC too), increment_automation_execution_count, increment_flow_execution_count. 007/012's REVOKEs did not hold:
-- prod carries anon and authenticated grants made by the owner (how they came back is not known; no migration in this
-- repo grants them). Only the service role needs them: the app
-- calls both counters through its service-role client, and nothing has called recompute_broadcast_counts since 005
-- moved the triggers to _bcast_bump (it stays as a service-role safety net).
-- Also: row level security on for admission_import_staging. It has no grants beyond its owner today; with RLS on and no
-- policy, a later default grant still cannot open it.
-- Not changed: course_fee_fingerprint. It is read-only, and course_content's trigger (security invoker) calls it for
-- every role that writes a course.
-- Run as the owner or a superuser (a superuser's REVOKE acts as the owner), with psql -1. It fails, changing nothing, if
-- a grant survives. Rollback: 103_rollback.sql (puts back exactly what was there). No ids or names here (public repo).

SET LOCAL lock_timeout = '5s';

REVOKE EXECUTE ON FUNCTION public.recompute_broadcast_counts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_automation_execution_count(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_flow_execution_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_broadcast_counts(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_automation_execution_count(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_flow_execution_count(uuid) TO service_role;

ALTER TABLE public.admission_import_staging ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE f regprocedure;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.recompute_broadcast_counts(uuid)', 'public.increment_automation_execution_count(uuid)',
                           'public.increment_flow_execution_count(uuid)']::regprocedure[] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = f AND a.grantee = 0) THEN
      RAISE EXCEPTION '103: % is still open to anon, authenticated or PUBLIC (a grant by another role?)', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION '103: service_role lost %', f;
    END IF;
  END LOOP;
END $$;
