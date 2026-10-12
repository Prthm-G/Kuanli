-- 078_rollback.sql · KB-GROWTH-R1
-- Removes the /growth read model and snapshot store. Snapshots are derived
-- data (re-publishable from the scorecard), so dropping them loses nothing.
DROP FUNCTION IF EXISTS public.growth_live(uuid, integer);
DROP TABLE IF EXISTS public.growth_snapshots;
