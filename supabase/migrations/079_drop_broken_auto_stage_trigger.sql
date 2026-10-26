-- 079 (KB-HANDOVER-R10): drop the auto-stage trigger that blocks every assignment.
--
-- auto_stage_on_assignment() sets deals.stage, a column deals no longer has
-- (stages live in deals.stage_id). Any UPDATE that sets
-- conversations.assigned_agent_id therefore fails with "column stage does not
-- exist", from the Kuanli inbox and from n8n alike: no conversation has ever
-- been assigned (audit 2026-10-26). It was created outside the repo.
--
-- Nothing is lost: the n8n node "Stage Counselor Active" already moves the
-- deal to Counselor Active on handover, by stage_id. Planned as SP2 A4 (the
-- 078 number went to the growth page instead). Rollback: 079_rollback.sql.

DROP TRIGGER IF EXISTS trg_auto_stage_assignment ON public.conversations;
DROP FUNCTION IF EXISTS public.auto_stage_on_assignment();
