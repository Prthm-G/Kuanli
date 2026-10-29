-- 082_rollback.sql: undo 082_silent_leads.sql. Roll back the n8n side FIRST
-- (apply-auretris-silent-leads.mjs --rollback): Main's history and hand-over queries read
-- ad_catalog, so dropping it under a live Main breaks every bot reply. Silent assignment rows stay (they are real
-- assignments; with the column gone they read as ordinary ones). The apply script saves
-- ad_catalog to backups/ before running this.
DROP FUNCTION IF EXISTS public.silent_ad_leads(text, int, int);
DROP FUNCTION IF EXISTS public.assign_counsellor_silent(uuid);
ALTER TABLE public.counsellor_assignments DROP CONSTRAINT IF EXISTS counsellor_assignments_assigned_via_check;
ALTER TABLE public.counsellor_assignments DROP COLUMN IF EXISTS assigned_via;
DROP INDEX IF EXISTS public.ad_catalog_account;
DROP TABLE IF EXISTS public.ad_catalog;
