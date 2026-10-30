-- 088_rollback.sql  (KB-CAPI-R8-01)
-- Undo 088: LeadSubmitted goes back to course taps only (085). Queued rows are kept.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS conversations_record_course_recorded ON public.conversations;
DROP FUNCTION IF EXISTS public.record_conversion_from_course_recorded();
DROP FUNCTION IF EXISTS public.backfill_course_recorded_conversions();
COMMIT;
