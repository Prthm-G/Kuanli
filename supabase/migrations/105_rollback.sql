-- 105_rollback.sql (KB-JOURNEY-R2): undo 105. Run in one transaction (psql -1). Roll the image back first: the R2 page
-- passes p_branch only on a branch tab, so the R1b image works on either catalogue.
-- Refuses while meta_ad_daily holds rows (re-fetchable, but only D-1/D-2 come back), unless the session first runs:
--   SET k105.drop_values = 'yes';
DO $$
DECLARE v_rows bigint := 0;
BEGIN
  IF to_regclass('public.meta_ad_daily') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.meta_ad_daily' INTO v_rows;
  END IF;
  IF v_rows > 0 AND coalesce(current_setting('k105.drop_values', true), '') <> 'yes' THEN
    RAISE EXCEPTION '105 rollback: % row(s) hold spend rows; back them up, then SET k105.drop_values = ''yes''', v_rows;
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.growth_branch_funnel(uuid, integer, uuid);
DROP FUNCTION IF EXISTS public.growth_live(uuid, integer, uuid);
DROP FUNCTION IF EXISTS public.meta_ad_daily_replace(uuid, text, date, text, jsonb);
DROP FUNCTION IF EXISTS public.growth_ad_branch(uuid, text);
DROP TABLE IF EXISTS public.meta_ad_daily;

-- 094's growth_live (the live one, md5 of pg_get_functiondef a529dab3...), verbatim (KB-GROWTH-R1 / 094)
CREATE OR REPLACE FUNCTION public.growth_live(p_account_id uuid, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_since timestamptz;
  v_cn text[] := counsellor_phone_number_ids();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(p_account_id, 'owner'::account_role_enum) THEN
    RAISE EXCEPTION 'This page is for the account owner'
      USING ERRCODE = '42501';
  END IF;

  -- IST midnight, (days - 1) days ago: exactly `days` whole IST days incl. today.
  v_since := (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
              - make_interval(days => LEAST(GREATEST(p_days, 1), 120) - 1))
             AT TIME ZONE 'Asia/Kolkata';

  RETURN jsonb_build_object(
    'last_ad_referral_at', (
      SELECT max(ad_referral_at) FROM conversations WHERE account_id = p_account_id
    ),
    'daily', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'day', d.day, 'new_conversations', d.new_conversations,
               'ad_referrals', d.ad_referrals) ORDER BY d.day DESC)
      FROM (
        SELECT day, sum(n_new)::int AS new_conversations, sum(n_ad)::int AS ad_referrals
        FROM (
          SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, 1 AS n_new, 0 AS n_ad
          FROM conversations WHERE account_id = p_account_id AND created_at >= v_since
            AND NOT coalesce(phone_number_id = ANY (v_cn), false)
          UNION ALL
          SELECT (COALESCE(ad_referral_msg_at, ad_referral_at) AT TIME ZONE 'Asia/Kolkata')::date, 0, 1
          FROM conversations
          WHERE account_id = p_account_id
            AND COALESCE(ad_referral_msg_at, ad_referral_at) >= v_since
        ) x
        GROUP BY day
      ) d
    ), '[]'::jsonb),
    'by_ad', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ad_source_id', a.ad_source_id, 'conversations', a.n,
               'last_at', a.last_at) ORDER BY a.n DESC, a.last_at DESC)
      FROM (
        SELECT ad_source_id, count(*)::int AS n,
               max(COALESCE(ad_referral_msg_at, ad_referral_at)) AS last_at
        FROM conversations
        WHERE account_id = p_account_id
          AND COALESCE(ad_referral_msg_at, ad_referral_at) >= v_since
          AND ad_source_id IS NOT NULL
        GROUP BY ad_source_id
        ORDER BY count(*) DESC
        LIMIT 25
      ) a
    ), '[]'::jsonb),
    'by_number', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'phone_number_id', b.phone_number_id,
               'display_phone_number', b.display_phone_number,
               'conversations', b.n, 'last_at', b.last_at) ORDER BY b.n DESC)
      FROM (
        SELECT c.phone_number_id, max(w.display_phone_number) AS display_phone_number,
               count(*)::int AS n, max(c.created_at) AS last_at
        FROM conversations c
        LEFT JOIN whatsapp_config w
          ON w.phone_number_id = c.phone_number_id AND w.account_id = c.account_id
        WHERE c.account_id = p_account_id AND c.created_at >= v_since
          AND NOT coalesce(c.phone_number_id = ANY (v_cn), false)
        GROUP BY c.phone_number_id
      ) b
    ), '[]'::jsonb),
    'contacts_by_source', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('source', s.source, 'contacts', s.n) ORDER BY s.n DESC)
      FROM (
        SELECT source, count(*)::int AS n
        FROM contacts
        WHERE account_id = p_account_id AND created_at >= v_since AND NOT counsellor_number_only
        GROUP BY source
      ) s
    ), '[]'::jsonb)
  );
END;
$function$;

ALTER FUNCTION public.growth_live(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.growth_live(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.growth_live(uuid, integer) TO authenticated;
