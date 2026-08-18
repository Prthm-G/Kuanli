-- 048_pipeline_funnel.sql
-- KB-PIPETABS-R4-28
--
-- Read model for the Funnel tab on /pipelines: one pipeline's stage ladder
-- with, per stage: how many deals sit there now, how many ever reached it
-- (current position or any deal_stage_events entry in THIS pipeline — deals
-- routed across pipelines by migration 047 count in each board they actually
-- entered), and the median hours deals spent in the stage (completed spells
-- only, from the event log; young history returns null and fills in as
-- events accrue). Lost is an exit, not a rung: current count only.
--
-- Same security convention as lead_queue / funnel_analytics.
--
-- Rollback: DROP FUNCTION IF EXISTS public.pipeline_funnel(uuid, uuid);

CREATE OR REPLACE FUNCTION public.pipeline_funnel(
  p_account_id uuid,
  p_pipeline_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pipelines p
    WHERE p.id = p_pipeline_id AND p.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'Pipeline not found in this account' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'position')::int), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'stage', ps.name,
      'position', ps.position,
      'color', ps.color,
      'current', (
        SELECT count(*) FROM deals d WHERE d.stage_id = ps.id
      ),
      'reached', CASE WHEN ps.name = 'Lost' THEN NULL ELSE (
        SELECT count(DISTINCT x.deal_id) FROM (
          SELECT d.id AS deal_id FROM deals d
          JOIN pipeline_stages cur ON cur.id = d.stage_id
          WHERE d.pipeline_id = p_pipeline_id
            AND cur.name <> 'Lost'
            AND cur.position >= ps.position
          UNION
          SELECT e.deal_id FROM deal_stage_events e
          JOIN pipeline_stages es ON es.id = e.to_stage_id
          WHERE es.pipeline_id = p_pipeline_id
            AND es.name <> 'Lost'
            AND es.position >= ps.position
        ) x
      ) END,
      'median_hours', (
        SELECT round(percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (sp.left_at - sp.entered_at)) / 3600
               )::numeric, 1)
        FROM (
          SELECT e.changed_at AS entered_at,
                 lead(e.changed_at) OVER (PARTITION BY e.deal_id ORDER BY e.changed_at) AS left_at,
                 e.to_stage_id
          FROM deal_stage_events e
          WHERE e.account_id = p_account_id
        ) sp
        WHERE sp.to_stage_id = ps.id AND sp.left_at IS NOT NULL
      )
    ) AS row
    FROM pipeline_stages ps
    WHERE ps.pipeline_id = p_pipeline_id
  ) f;

  RETURN v_result;
END;
$$;

ALTER FUNCTION public.pipeline_funnel(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.pipeline_funnel(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pipeline_funnel(uuid, uuid) TO authenticated;
