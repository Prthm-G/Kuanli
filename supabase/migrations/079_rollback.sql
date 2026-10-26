-- Rollback for 079: restores the trigger exactly as it was on 2026-10-26
-- (pg_get_functiondef / pg_get_triggerdef), including its owner.
-- Restoring it also restores the bug: assignments fail again.

CREATE OR REPLACE FUNCTION public.auto_stage_on_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF OLD.assigned_agent_id IS NULL AND NEW.assigned_agent_id IS NOT NULL THEN
        UPDATE deals
        SET stage = 'Counselor Active', updated_at = NOW()
        WHERE contact_id = NEW.contact_id
          AND stage IN ('New Lead', 'Engaged', 'Qualified');
    END IF;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.auto_stage_on_assignment() OWNER TO supabase_admin;

DROP TRIGGER IF EXISTS trg_auto_stage_assignment ON public.conversations;
CREATE TRIGGER trg_auto_stage_assignment AFTER UPDATE OF assigned_agent_id ON public.conversations FOR EACH ROW EXECUTE FUNCTION auto_stage_on_assignment();
