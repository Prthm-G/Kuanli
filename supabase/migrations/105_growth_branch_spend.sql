-- 105_growth_branch_spend.sql  (KB-JOURNEY-R2)
-- Growth by branch + daily Meta spend.
-- 1. meta_ad_daily: one row per Meta account day x ad x region, copied from Meta's insights by the morning fetch
--    (devtools/morning-v2). day = Meta's account day in account_tz, stored as Meta reports it. Region is Meta's state
--    level breakdown for India; Meta gives no chats or leads at region level, so msg_started / leads stay NULL there.
--    The owner reads; only the service role writes, through meta_ad_daily_replace (one ad account day, atomic).
-- 2. growth_ad_branch(account, ad): the ad's branch from ad_catalog, else the branch of its Meta ad account (an ad
--    missing from the catalogue still lands on a branch once Meta reports spend for it).
-- 3. growth_live gains p_branch (NULL = the live 094 output, unchanged). A conversation's branch = its ad's branch, else its
--    contact's branch; contacts by source filter on the contact's branch.
-- 4. growth_branch_funnel(account, days, branch): chats -> qualified -> application started -> provisional -> fee ->
--    enrolled per branch and per ad (organic and "ad, exact ad unknown" kept apart), form leads per branch and form
--    (form leads carry no ad id), spend, spend by state, and which Meta days are stored. Owner only and SECURITY DEFINER
--    like growth_live (it reads meta_form_leads, which is service-role only). Aggregates only, never a row.
-- Chats on counsellor numbers and contacts flagged counsellor_number_only are not leads (094): both functions leave them out.
-- No ids here (this repo is public). Run with psql -1. Needs 106 live (release order 104, 106, 105).
-- Rollback: 105_rollback.sql (restores the live 094 growth_live verbatim).

SET LOCAL lock_timeout = '5s';

-- 1. spend table ------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meta_ad_daily (
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  day           date NOT NULL,
  ad_account_id text NOT NULL CHECK (ad_account_id ~ '^[0-9]{6,20}$'),
  account_tz    text NOT NULL CHECK (account_tz ~ '^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+)+)$'),
  campaign_id   text CHECK (campaign_id ~ '^[0-9]{5,25}$'),
  campaign_name text CHECK (length(campaign_name) <= 300),
  adset_id      text CHECK (adset_id ~ '^[0-9]{5,25}$'),
  adset_name    text CHECK (length(adset_name) <= 300),
  ad_id         text NOT NULL CHECK (ad_id ~ '^[0-9]{5,25}$'),
  ad_name       text CHECK (length(ad_name) <= 300),
  region        text NOT NULL CHECK (length(region) BETWEEN 1 AND 120),
  spend         numeric(12,2) NOT NULL CHECK (spend >= 0),
  impressions   integer CHECK (impressions >= 0),
  clicks        integer CHECK (clicks >= 0),
  msg_started   integer CHECK (msg_started >= 0),
  leads         integer CHECK (leads >= 0),
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, ad_id, region)
);
CREATE INDEX IF NOT EXISTS meta_ad_daily_account_day ON public.meta_ad_daily (account_id, day);
CREATE INDEX IF NOT EXISTS meta_ad_daily_ad ON public.meta_ad_daily (ad_id, day DESC);

ALTER TABLE public.meta_ad_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_ad_daily_owner_select ON public.meta_ad_daily;
CREATE POLICY meta_ad_daily_owner_select ON public.meta_ad_daily FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'owner'::public.account_role_enum));
REVOKE ALL ON public.meta_ad_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.meta_ad_daily TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meta_ad_daily TO service_role;

-- Replaces one ad account's day: Meta revises recent days and can drop a region row, which an upsert would leave.
-- One statement pair in the caller's transaction, so a bad row (duplicate key, negative spend) changes nothing.
CREATE OR REPLACE FUNCTION public.meta_ad_daily_replace(p_account uuid, p_ad_account text, p_day date, p_tz text, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be an array' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.meta_ad_daily WHERE ad_account_id = p_ad_account AND day = p_day;
  INSERT INTO public.meta_ad_daily (account_id, day, ad_account_id, account_tz, campaign_id, campaign_name, adset_id,
                                    adset_name, ad_id, ad_name, region, spend, impressions, clicks, msg_started, leads)
  SELECT p_account, p_day, p_ad_account, p_tz, r->>'campaign_id', r->>'campaign_name', r->>'adset_id', r->>'adset_name',
         r->>'ad_id', r->>'ad_name', r->>'region', (r->>'spend')::numeric, (r->>'impressions')::int, (r->>'clicks')::int,
         (r->>'msg_started')::int, (r->>'leads')::int
    FROM jsonb_array_elements(p_rows) r;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.meta_ad_daily_replace(uuid, text, date, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meta_ad_daily_replace(uuid, text, date, text, jsonb) TO service_role;

-- 2. ad -> branch -----------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_ad_branch(p_account uuid, p_ad_id text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT coalesce(
    (SELECT c.branch_id FROM public.ad_catalog c WHERE c.ad_id = p_ad_id AND c.account_id = p_account),
    (SELECT k.branch_id
       FROM public.meta_ad_daily m
       JOIN public.ad_catalog k ON k.ad_account_id = m.ad_account_id AND k.account_id = p_account AND k.branch_id IS NOT NULL
      WHERE m.ad_id = p_ad_id AND m.account_id = p_account
      ORDER BY m.day DESC LIMIT 1))
   WHERE nullif(p_ad_id, '') IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.growth_ad_branch(uuid, text) FROM PUBLIC, anon, authenticated;

-- 3. growth_live with a branch filter (094's body: counsellor-number chats and flagged contacts stay out of the counts) ---------------------------------------------------------------------------------
-- Same body as 094 (live) over cv (the account's conversations, in the branch when one is given). p_branch NULL: identical
-- output (run-105-sql-tests.sh compares it before and after). The 2-arg signature goes, so PostgREST has one function.
DROP FUNCTION IF EXISTS public.growth_live(uuid, integer);
CREATE OR REPLACE FUNCTION public.growth_live(p_account_id uuid, p_days integer DEFAULT 30, p_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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

  v_since := (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
              - make_interval(days => LEAST(GREATEST(p_days, 1), 120) - 1))
             AT TIME ZONE 'Asia/Kolkata';

  RETURN (
    WITH cv AS (
      SELECT c.account_id, c.created_at, c.ad_referral_at, c.ad_referral_msg_at, c.ad_source_id, c.phone_number_id
        FROM conversations c
        LEFT JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.account_id = p_account_id
         AND (p_branch IS NULL
              OR coalesce(public.growth_ad_branch(p_account_id, c.ad_source_id), ct.branch_id) = p_branch)
    )
    SELECT jsonb_build_object(
      'last_ad_referral_at', (SELECT max(ad_referral_at) FROM cv),
      'daily', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'day', d.day, 'new_conversations', d.new_conversations,
                 'ad_referrals', d.ad_referrals) ORDER BY d.day DESC)
        FROM (
          SELECT day, sum(n_new)::int AS new_conversations, sum(n_ad)::int AS ad_referrals
          FROM (
            SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, 1 AS n_new, 0 AS n_ad
            FROM cv WHERE created_at >= v_since
              AND NOT coalesce(phone_number_id = ANY (v_cn), false)
            UNION ALL
            SELECT (COALESCE(ad_referral_msg_at, ad_referral_at) AT TIME ZONE 'Asia/Kolkata')::date, 0, 1
            FROM cv WHERE COALESCE(ad_referral_msg_at, ad_referral_at) >= v_since
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
          FROM cv
          WHERE COALESCE(ad_referral_msg_at, ad_referral_at) >= v_since
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
          FROM cv c
          LEFT JOIN whatsapp_config w
            ON w.phone_number_id = c.phone_number_id AND w.account_id = c.account_id
          WHERE c.created_at >= v_since
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
            AND (p_branch IS NULL OR branch_id = p_branch)
          GROUP BY source
        ) s
      ), '[]'::jsonb)
    )
  );
END;
$$;
ALTER FUNCTION public.growth_live(uuid, integer, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.growth_live(uuid, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.growth_live(uuid, integer, uuid) TO authenticated;

-- 4. branch funnel ----------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_branch_funnel(p_account_id uuid, p_days integer DEFAULT 30, p_branch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_days  integer := LEAST(GREATEST(coalesce(p_days, 30), 1), 120);
  v_until date;
  v_first date;
  v_since timestamptz;
  v_z     constant uuid := '00000000-0000-0000-0000-000000000000';
  v_cn    text[] := counsellor_phone_number_ids();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF NOT is_account_member(p_account_id, 'owner'::account_role_enum) THEN
    RAISE EXCEPTION 'This page is for the account owner' USING ERRCODE = '42501';
  END IF;
  -- The same `days` whole IST days as growth_live. Spend uses the same date labels as Meta account days.
  v_until := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_first := v_until - (v_days - 1);
  v_since := v_first::timestamp AT TIME ZONE 'Asia/Kolkata';

  RETURN (
    WITH steps(stage, r) AS (VALUES ('Qualified', 1), ('Counselor Active', 1), ('Application Started', 2),
                                    ('Provisional ID', 3), ('Form & Documents', 3), ('Fee Submitted', 4), ('Enrolled', 5)),
    cv0 AS (
      SELECT c.id, c.contact_id, nullif(c.ad_source_id, '') AS ad_id,
             coalesce(public.growth_ad_branch(p_account_id, c.ad_source_id), ct.branch_id) AS branch_id,
             CASE WHEN nullif(c.ad_source_id, '') IS NOT NULL THEN 'ad'
                  WHEN EXISTS (SELECT 1 FROM messages m JOIN wa_message_pricing p ON p.message_id = m.message_id
                                WHERE m.conversation_id = c.id AND p.category = 'referral_conversion') THEN 'ad_unknown'
                  ELSE 'organic' END AS src
        FROM conversations c
        LEFT JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.account_id = p_account_id AND c.created_at >= v_since
         AND NOT coalesce(c.phone_number_id = ANY (v_cn), false)
         AND NOT coalesce(ct.counsellor_number_only, false)),
    cv AS (SELECT * FROM cv0 WHERE p_branch IS NULL OR branch_id = p_branch),
    fl AS (
      SELECT f.contact_id, coalesce(co.branch_id, ct.branch_id) AS branch_id,
             coalesce(nullif(btrim(f.form_name), ''), 'form ' || right(coalesce(f.form_id, ''), 4)) AS form
        FROM meta_form_leads f
        LEFT JOIN counsellors co ON co.id = f.counsellor_id
        LEFT JOIN contacts ct ON ct.id = f.contact_id
       WHERE f.account_id = p_account_id AND f.lead_created_at >= v_since
         AND (p_branch IS NULL OR coalesce(co.branch_id, ct.branch_id) = p_branch)),
    adb AS (
      SELECT a.ad_id, public.growth_ad_branch(p_account_id, a.ad_id) AS branch_id
        FROM (SELECT DISTINCT ad_id FROM meta_ad_daily WHERE account_id = p_account_id AND day BETWEEN v_first AND v_until) a),
    sp AS (
      SELECT m.ad_id, m.ad_name, m.region, m.spend, m.impressions, m.clicks, adb.branch_id
        FROM meta_ad_daily m JOIN adb USING (ad_id)
       WHERE m.account_id = p_account_id AND m.day BETWEEN v_first AND v_until
         AND (p_branch IS NULL OR adb.branch_id = p_branch)),
    reach AS (   -- the furthest funnel step each contact reached on any deal, now or by a past move
      SELECT x.contact_id, max(x.r) AS r FROM (
        SELECT d.contact_id, st.r FROM deals d
          JOIN pipeline_stages s ON s.id = d.stage_id JOIN steps st ON st.stage = s.name
         WHERE d.account_id = p_account_id
        UNION ALL
        SELECT d.contact_id, st.r FROM deal_stage_events e
          JOIN deals d ON d.id = e.deal_id
          JOIN pipeline_stages s ON s.id = e.to_stage_id JOIN steps st ON st.stage = s.name
         WHERE e.account_id = p_account_id) x
       WHERE x.contact_id IN (SELECT contact_id FROM cv UNION SELECT contact_id FROM fl)
       GROUP BY x.contact_id),
    cvr AS (SELECT cv.*, coalesce(reach.r, 0) AS r FROM cv LEFT JOIN reach USING (contact_id)),
    flr AS (SELECT fl.*, coalesce(reach.r, 0) AS r FROM fl LEFT JOIN reach USING (contact_id)),
    cva AS (
      SELECT ad_id, branch_id, count(*)::int AS chats, count(DISTINCT contact_id)::int AS contacts,
             count(DISTINCT contact_id) FILTER (WHERE r >= 1)::int AS qualified,
             count(DISTINCT contact_id) FILTER (WHERE r >= 2)::int AS application_started,
             count(DISTINCT contact_id) FILTER (WHERE r >= 3)::int AS provisional,
             count(DISTINCT contact_id) FILTER (WHERE r >= 4)::int AS fee,
             count(DISTINCT contact_id) FILTER (WHERE r >= 5)::int AS enrolled
        FROM cvr WHERE src = 'ad' GROUP BY ad_id, branch_id),
    spa AS (
      SELECT ad_id, branch_id, max(ad_name) AS meta_name, sum(spend) AS spend,
             sum(impressions)::bigint AS impressions, sum(clicks)::bigint AS clicks
        FROM sp GROUP BY ad_id, branch_id),
    by_ad AS (
      SELECT coalesce(a.ad_id, s.ad_id) AS ad_id, b.code AS branch_code, cat.name AS catalog_name, s.meta_name,
             (cat.ad_id IS NOT NULL) AS in_catalog,
             coalesce(a.chats, 0) AS chats, coalesce(a.contacts, 0) AS contacts, coalesce(a.qualified, 0) AS qualified,
             coalesce(a.application_started, 0) AS application_started, coalesce(a.provisional, 0) AS provisional,
             coalesce(a.fee, 0) AS fee, coalesce(a.enrolled, 0) AS enrolled, s.spend, s.impressions, s.clicks
        FROM cva a
        FULL JOIN spa s ON s.ad_id = a.ad_id AND coalesce(s.branch_id, v_z) = coalesce(a.branch_id, v_z)
        LEFT JOIN ad_catalog cat ON cat.ad_id = coalesce(a.ad_id, s.ad_id) AND cat.account_id = p_account_id
        LEFT JOIN branches b ON b.id = coalesce(a.branch_id, s.branch_id)),
    by_source AS (
      SELECT cvr.src AS source, b.code AS branch_code, count(*)::int AS chats, count(DISTINCT cvr.contact_id)::int AS contacts,
             count(DISTINCT cvr.contact_id) FILTER (WHERE cvr.r >= 1)::int AS qualified,
             count(DISTINCT cvr.contact_id) FILTER (WHERE cvr.r >= 2)::int AS application_started,
             count(DISTINCT cvr.contact_id) FILTER (WHERE cvr.r >= 3)::int AS provisional,
             count(DISTINCT cvr.contact_id) FILTER (WHERE cvr.r >= 4)::int AS fee,
             count(DISTINCT cvr.contact_id) FILTER (WHERE cvr.r >= 5)::int AS enrolled
        FROM cvr LEFT JOIN branches b ON b.id = cvr.branch_id
       WHERE cvr.src <> 'ad' GROUP BY cvr.src, b.code),
    bsum AS (
      SELECT branch_id, count(*)::int AS chats,
             count(*) FILTER (WHERE src = 'ad')::int AS ad_chats,
             count(*) FILTER (WHERE src = 'ad_unknown')::int AS ad_unknown_chats,
             count(*) FILTER (WHERE src = 'organic')::int AS organic_chats,
             count(DISTINCT contact_id)::int AS contacts,
             count(DISTINCT contact_id) FILTER (WHERE r >= 1)::int AS qualified,
             count(DISTINCT contact_id) FILTER (WHERE r >= 2)::int AS application_started,
             count(DISTINCT contact_id) FILTER (WHERE r >= 3)::int AS provisional,
             count(DISTINCT contact_id) FILTER (WHERE r >= 4)::int AS fee,
             count(DISTINCT contact_id) FILTER (WHERE r >= 5)::int AS enrolled
        FROM cvr GROUP BY branch_id),
    bsp AS (SELECT branch_id, sum(spend) AS spend FROM sp GROUP BY branch_id),
    by_branch AS (
      SELECT b.code AS branch_code, b.name AS branch_name, coalesce(x.chats, 0) AS chats, coalesce(x.ad_chats, 0) AS ad_chats,
             coalesce(x.ad_unknown_chats, 0) AS ad_unknown_chats, coalesce(x.organic_chats, 0) AS organic_chats,
             coalesce(x.contacts, 0) AS contacts, coalesce(x.qualified, 0) AS qualified,
             coalesce(x.application_started, 0) AS application_started, coalesce(x.provisional, 0) AS provisional,
             coalesce(x.fee, 0) AS fee, coalesce(x.enrolled, 0) AS enrolled, s.spend
        FROM bsum x
        FULL JOIN bsp s ON coalesce(s.branch_id, v_z) = coalesce(x.branch_id, v_z)
        LEFT JOIN branches b ON b.id = coalesce(x.branch_id, s.branch_id)),
    forms AS (
      SELECT b.code AS branch_code, flr.form, count(*)::int AS leads, count(DISTINCT flr.contact_id)::int AS contacts,
             count(DISTINCT flr.contact_id) FILTER (WHERE flr.r >= 1)::int AS qualified,
             count(DISTINCT flr.contact_id) FILTER (WHERE flr.r >= 2)::int AS application_started,
             count(DISTINCT flr.contact_id) FILTER (WHERE flr.r >= 3)::int AS provisional,
             count(DISTINCT flr.contact_id) FILTER (WHERE flr.r >= 4)::int AS fee,
             count(DISTINCT flr.contact_id) FILTER (WHERE flr.r >= 5)::int AS enrolled
        FROM flr LEFT JOIN branches b ON b.id = flr.branch_id GROUP BY b.code, flr.form),
    states AS (
      SELECT sp.region, b.code AS branch_code, sum(sp.spend) AS spend,
             sum(sp.impressions)::bigint AS impressions, sum(sp.clicks)::bigint AS clicks
        FROM sp LEFT JOIN branches b ON b.id = sp.branch_id GROUP BY sp.region, b.code),
    cov AS (
      SELECT m.ad_account_id, k.branch_id, m.account_tz, max(m.day) AS last_day,
             count(DISTINCT m.day) FILTER (WHERE m.day BETWEEN v_first AND v_until)::int AS days_in_window
        FROM meta_ad_daily m
        LEFT JOIN LATERAL (SELECT c.branch_id FROM ad_catalog c WHERE c.account_id = p_account_id
                             AND c.ad_account_id = m.ad_account_id AND c.branch_id IS NOT NULL LIMIT 1) k ON true
       WHERE m.account_id = p_account_id
       GROUP BY m.ad_account_id, k.branch_id, m.account_tz),
    coverage AS (
      SELECT cov.ad_account_id, b.code AS branch_code, cov.account_tz, cov.last_day, cov.days_in_window
        FROM cov LEFT JOIN branches b ON b.id = cov.branch_id
       WHERE p_branch IS NULL OR cov.branch_id = p_branch)
    SELECT jsonb_build_object(
      'since', v_first, 'until', v_until,
      'branches', coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.chats DESC, t.branch_code) FROM by_branch t), '[]'::jsonb),
      'by_ad', coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.spend DESC NULLS LAST, t.chats DESC, t.ad_id) FROM by_ad t), '[]'::jsonb),
      'by_source', coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.source, t.branch_code) FROM by_source t), '[]'::jsonb),
      'form_leads', coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.leads DESC, t.form) FROM forms t), '[]'::jsonb),
      'spend_by_state', coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.spend DESC, t.region) FROM states t), '[]'::jsonb),
      'coverage', coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.branch_code, t.ad_account_id) FROM coverage t), '[]'::jsonb)
    )
  );
END $$;
ALTER FUNCTION public.growth_branch_funnel(uuid, integer, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.growth_branch_funnel(uuid, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.growth_branch_funnel(uuid, integer, uuid) TO authenticated;
