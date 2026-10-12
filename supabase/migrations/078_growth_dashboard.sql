-- 078_growth_dashboard.sql
-- KB-GROWTH-R1
--
-- Read model and weekly store for the owner-only /growth page.
--
--   * growth_snapshots — one row per account per scorecard run. The payload is
--     aggregates only (spend, enrolment counts with 1-2 suppressed as "<3",
--     proposals, blockers); no names, phones or message text. Written by
--     POST /api/growth/snapshot through the service role; owners read it.
--   * growth_live(account, days) — live signals from Kuanli's own tables:
--     last captured ad click, daily new conversations and ad clicks, per-ad
--     and per-number counts, new contacts by source. The window is the last
--     `days` whole IST days including today; days bucket in Asia/Kolkata (ops
--     timezone), as in funnel_analytics (043). Ad clicks use the click's own
--     message time (ad_referral_msg_at, 070) where present, else receipt time.
--     Kuanli keeps only the latest ad click per conversation (061/070), so
--     these count conversations by their latest click, not every click.
--
-- Security: owner only on both. SECURITY DEFINER + auth.uid() + owner
-- membership on the RPC (same convention as 043, stricter role), and EXECUTE
-- revoked explicitly from anon and service_role (Supabase default privileges
-- grant it to them; REVOKE FROM PUBLIC alone does not remove that). One SELECT
-- policy for owners on the table and no write policy, so only the service role
-- can write. Apply in one transaction (the apply script uses psql -1), so the
-- table never exists with the default wide grants.
--
-- Rollback: 078_rollback.sql

CREATE TABLE IF NOT EXISTS public.growth_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, snapshot_date)
);

ALTER TABLE public.growth_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS growth_snapshots_owner_select ON public.growth_snapshots;
CREATE POLICY growth_snapshots_owner_select ON public.growth_snapshots
  FOR SELECT USING (is_account_member(account_id, 'owner'::account_role_enum));

REVOKE ALL ON public.growth_snapshots FROM anon, authenticated;
GRANT SELECT ON public.growth_snapshots TO authenticated;
GRANT ALL ON public.growth_snapshots TO service_role;

CREATE OR REPLACE FUNCTION public.growth_live(p_account_id uuid, p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_since timestamptz;
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
        GROUP BY c.phone_number_id
      ) b
    ), '[]'::jsonb),
    'contacts_by_source', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('source', s.source, 'contacts', s.n) ORDER BY s.n DESC)
      FROM (
        SELECT source, count(*)::int AS n
        FROM contacts
        WHERE account_id = p_account_id AND created_at >= v_since
        GROUP BY source
      ) s
    ), '[]'::jsonb)
  );
END;
$$;

ALTER FUNCTION public.growth_live(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.growth_live(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.growth_live(uuid, integer) TO authenticated;
