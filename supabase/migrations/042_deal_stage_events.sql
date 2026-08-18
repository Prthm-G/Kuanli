-- 042_deal_stage_events.sql
-- KB-ANALYTICS-R4-24
--
-- Append-only log of every deal stage transition, written by a trigger on
-- `deals` so every path is captured in one place: the lifecycle sweep
-- (migration 039), Auretris's Auto-Stage Pipeline / Stage Counselor Active
-- nodes, and manual drags on the Kanban. Nothing needed changing in any of
-- those writers.
--
-- Why now: funnel analytics (stage-to-stage conversion, time-in-stage,
-- Lost-from-where) need transition history, and history only accrues from
-- the day this table exists. Deals only store their current stage; the
-- lifecycle sweep returns its transitions but nothing recorded them.
--
-- `changed_by` is auth.uid() at the time of the write: a real user id when
-- the change came through PostgREST (a counsellor dragging the Kanban or
-- editing a deal), NULL when it came from automation (the sweep and the n8n
-- nodes connect directly as supabase_admin, where auth.uid() is NULL). That
-- is the only distinction the database can honestly make, so it is the only
-- one recorded.
--
-- No backfilled/seeded events: pre-existing deals simply have no history
-- before today, and the analytics RPC computes "furthest stage reached" as
-- GREATEST(current stage, max event stage) so old deals still count.
--
-- RLS: account members can read (viewer is enough — same posture as the
-- lead_queue RPC in migration 041). No client INSERT/UPDATE/DELETE policies:
-- only the trigger writes, via a SECURITY DEFINER function owned by postgres.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trigger_log_deal_stage ON deals;
--   DROP FUNCTION IF EXISTS log_deal_stage_event();
--   DROP TABLE IF EXISTS deal_stage_events;

CREATE TABLE IF NOT EXISTS deal_stage_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  from_stage_id UUID REFERENCES pipeline_stages(id),
  to_stage_id UUID NOT NULL REFERENCES pipeline_stages(id),
  changed_by UUID,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deal_stage_events_deal
  ON deal_stage_events(deal_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_deal_stage_events_account_time
  ON deal_stage_events(account_id, changed_at DESC);

ALTER TABLE deal_stage_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Account members can read stage events" ON deal_stage_events;
CREATE POLICY "Account members can read stage events" ON deal_stage_events
  FOR SELECT USING (is_account_member(account_id));

CREATE OR REPLACE FUNCTION log_deal_stage_event() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO deal_stage_events (deal_id, account_id, from_stage_id, to_stage_id, changed_by)
    VALUES (NEW.id, NEW.account_id, NULL, NEW.stage_id, auth.uid());
  ELSIF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO deal_stage_events (deal_id, account_id, from_stage_id, to_stage_id, changed_by)
    VALUES (NEW.id, NEW.account_id, OLD.stage_id, NEW.stage_id, auth.uid());
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION log_deal_stage_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION log_deal_stage_event() FROM PUBLIC;

DROP TRIGGER IF EXISTS trigger_log_deal_stage ON deals;
CREATE TRIGGER trigger_log_deal_stage
  AFTER INSERT OR UPDATE OF stage_id ON deals
  FOR EACH ROW EXECUTE FUNCTION log_deal_stage_event();

-- Table-level grants follow the repo convention (RLS does the enforcement;
-- PostgREST roles still need the grant or every read 42501s).
GRANT SELECT ON deal_stage_events TO authenticated, service_role;
