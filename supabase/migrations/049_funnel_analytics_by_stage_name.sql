-- 049_funnel_analytics_by_stage_name.sql
-- KB-PIPETABS-R4-28
--
-- Amend funnel_analytics for the per-university pipeline split (migration
-- 047): the account-level funnel section now groups by stage NAME across the
-- cloned ladders instead of listing each pipeline's stages separately, which
-- would have shown every stage once per board on /analytics. Everything else
-- is unchanged from migration 043.
--
-- Rollback: re-run migration 043.

CREATE OR REPLACE FUNCTION public.funnel_analytics(p_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sources jsonb;
  v_funnel jsonb;
  v_interest jsonb;
  v_trend jsonb;
  v_totals jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer'::account_role_enum) THEN
    RAISE EXCEPTION 'This action requires membership in this account'
      USING ERRCODE = '42501';
  END IF;

  -- Per-deal facts shared by totals, sources, and interest.
  CREATE TEMP TABLE _fa_deals ON COMMIT DROP AS
  SELECT
    d.id,
    d.contact_id,
    cur.name AS current_stage,
    GREATEST(
      CASE WHEN cur.name <> 'Lost' THEN cur.position ELSE 0 END,
      COALESCE((
        SELECT max(ps2.position) FROM deal_stage_events e
        JOIN pipeline_stages ps2 ON ps2.id = e.to_stage_id
        WHERE e.deal_id = d.id AND ps2.name <> 'Lost'
      ), 0)
    ) AS reached_pos,
    (SELECT sm.position FROM pipeline_stages sm
      WHERE sm.pipeline_id = d.pipeline_id AND sm.name = 'Qualified') AS qualified_pos,
    (SELECT sm.position FROM pipeline_stages sm
      WHERE sm.pipeline_id = d.pipeline_id AND sm.name = 'Counselor Active') AS counselor_pos,
    (SELECT sm.position FROM pipeline_stages sm
      WHERE sm.pipeline_id = d.pipeline_id AND sm.name = 'Application Started') AS application_pos,
    COALESCE(
      NULLIF(ct.ad_headline, ''),
      NULLIF(left(ct.ad_body, 60), ''),
      'Organic'
    ) AS source,
    intr.interest_university
  FROM deals d
  JOIN pipeline_stages cur ON cur.id = d.stage_id
  JOIN contacts ct ON ct.id = d.contact_id
  LEFT JOIN LATERAL (
    SELECT c.interest_university FROM conversations c
    WHERE c.contact_id = ct.id AND c.interest_updated_at IS NOT NULL
    ORDER BY c.interest_updated_at DESC LIMIT 1
  ) intr ON true
  WHERE d.account_id = p_account_id;

  SELECT jsonb_build_object(
    'leads', count(*),
    'enrolled', count(*) FILTER (WHERE current_stage = 'Enrolled'),
    'lost', count(*) FILTER (WHERE current_stage = 'Lost'),
    'reached_application', count(*) FILTER (WHERE reached_pos >= application_pos)
  ) INTO v_totals FROM _fa_deals;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'leads')::int DESC), '[]'::jsonb)
  INTO v_sources
  FROM (
    SELECT jsonb_build_object(
      'source', source,
      'leads', count(*),
      'qualified', count(*) FILTER (WHERE reached_pos >= qualified_pos),
      'counselor', count(*) FILTER (WHERE reached_pos >= counselor_pos),
      'application', count(*) FILTER (WHERE reached_pos >= application_pos),
      'enrolled', count(*) FILTER (WHERE current_stage = 'Enrolled'),
      'lost', count(*) FILTER (WHERE current_stage = 'Lost')
    ) AS row
    FROM _fa_deals GROUP BY source
  ) s;

  -- Current + ever-reached counts per stage NAME. Migration 047 split deals
  -- across per-university pipelines whose ladders are clones, so the account
  -- funnel groups by name (a per-pipeline row set would list every stage
  -- once per board). Lost keeps its current count only: it is an exit, not
  -- a rung on the ladder.
  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'position')::int), '[]'::jsonb)
  INTO v_funnel
  FROM (
    SELECT jsonb_build_object(
      'stage', ps.name,
      'position', ps.position,
      'current', (SELECT count(*) FROM _fa_deals f WHERE f.current_stage = ps.name),
      'reached', CASE WHEN ps.name = 'Lost' THEN NULL
                      ELSE (SELECT count(*) FROM _fa_deals f WHERE f.reached_pos >= ps.position) END
    ) AS row
    FROM (
      SELECT DISTINCT s.name, s.position FROM pipeline_stages s
      WHERE s.pipeline_id IN (
        SELECT DISTINCT d.pipeline_id FROM deals d WHERE d.account_id = p_account_id
      )
    ) ps
  ) f;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'leads')::int DESC), '[]'::jsonb)
  INTO v_interest
  FROM (
    SELECT jsonb_build_object(
      'university', COALESCE(interest_university, 'Unresolved'),
      'leads', count(*),
      'application', count(*) FILTER (WHERE reached_pos >= application_pos),
      'enrolled', count(*) FILTER (WHERE current_stage = 'Enrolled'),
      'lost', count(*) FILTER (WHERE current_stage = 'Lost')
    ) AS row
    FROM _fa_deals GROUP BY interest_university
  ) i;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'day')), '[]'::jsonb)
  INTO v_trend
  FROM (
    SELECT jsonb_build_object(
      'day', day::text,
      'median_minutes', round(med::numeric, 1),
      'responses', n
    ) AS row
    FROM (
      SELECT (resp_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_minutes) AS med,
             count(*) AS n
      FROM (
        SELECT m.created_at AS resp_at,
               EXTRACT(EPOCH FROM (m.created_at - lag(m.created_at) OVER w)) / 60 AS gap_minutes,
               m.sender_type,
               lag(m.sender_type) OVER w AS prev_type
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.account_id = p_account_id
          AND m.created_at >= now() - INTERVAL '14 days'
        WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.created_at)
      ) pairs
      WHERE sender_type = 'agent' AND prev_type = 'customer'
      GROUP BY 1
    ) days
  ) t;

  DROP TABLE _fa_deals;

  RETURN jsonb_build_object(
    'totals', v_totals,
    'sources', v_sources,
    'funnel', v_funnel,
    'interest', v_interest,
    'response_trend', v_trend
  );
END;
$$;

ALTER FUNCTION public.funnel_analytics(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.funnel_analytics(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.funnel_analytics(uuid) TO authenticated;
