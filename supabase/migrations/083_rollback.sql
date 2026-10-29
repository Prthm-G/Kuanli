-- 083_rollback.sql: roll back the n8n side first (devtools/apply-skeure-unanswered-leads.mjs --rollback).
-- Assignment rows made by 083 are kept, relabelled 'silent' (the closest 082 meaning), so no history is lost.
DROP FUNCTION IF EXISTS public.unanswered_leads(text, int, int);
DROP FUNCTION IF EXISTS public.assign_counsellor_unanswered(uuid);
UPDATE public.counsellor_assignments SET assigned_via = 'silent' WHERE assigned_via = 'unanswered';
ALTER TABLE public.counsellor_assignments DROP CONSTRAINT IF EXISTS counsellor_assignments_assigned_via_check;
ALTER TABLE public.counsellor_assignments ADD CONSTRAINT counsellor_assignments_assigned_via_check
  CHECK (assigned_via IN ('tap', 'silent'));
