-- 081_rollback.sql: undo 081_counsellors.sql. Drops every assignment row; the
-- apply script saves both tables to backups/ before running this.
DROP FUNCTION IF EXISTS public.mark_counsellor_reached(uuid, text);
DROP FUNCTION IF EXISTS public.assign_counsellor(uuid);
DROP TABLE IF EXISTS public.counsellor_assignments;
DROP TABLE IF EXISTS public.counsellors;
