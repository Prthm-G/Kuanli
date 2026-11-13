-- 099_config_secrets.sql  (KB-AUTHZ-099)
-- Two older authorization holes, found in the R2 database review (2026-11-13).
--
-- 1. whatsapp_config.access_token and verify_token were readable by every account member: the SELECT policy is
--    is_account_member (any role) and authenticated held SELECT on every column. access_token is encrypted at rest,
--    verify_token is not always. Both columns are now readable by the service role only. A signed-in member keeps
--    SELECT on every other column (the inbox and settings read them) and keeps INSERT/UPDATE on the table, so an
--    admin can still save new credentials (write-only; RLS still limits writes to admins).
--    Kuanli reads the token through the service client after resolving the caller's own account, so the image that
--    does that (wacrm KB-AUTHZ-099) must be live BEFORE this runs: the old image reads the row with the user's
--    session, and `select *` fails outright once one column is closed (sends, templates, broadcasts, media).
--    Later migrations that ADD COLUMN to whatsapp_config must GRANT SELECT (col) TO authenticated themselves.
-- 2. public._bcast_bump(uuid, text, integer) is SECURITY DEFINER with no authorization check, and anyone (PUBLIC, anon,
--    authenticated) could execute it: any caller could move any account's broadcast counters. Its only caller is the
--    broadcast_recipients_aggregate trigger (SECURITY DEFINER, runs as the owner), so EXECUTE goes to the service role
--    and the owner only. No code or n8n workflow calls it.
-- Idempotent. Rollback: 099_rollback.sql.

-- 1. whatsapp_config: close the two secret columns to signed-in users.
REVOKE SELECT ON public.whatsapp_config FROM authenticated;   -- table-level; also clears any column-level SELECT
DO $grant$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
    FROM pg_attribute
   WHERE attrelid = 'public.whatsapp_config'::regclass AND attnum > 0 AND NOT attisdropped
     AND attname NOT IN ('access_token', 'verify_token');
  EXECUTE format('GRANT SELECT (%s) ON public.whatsapp_config TO authenticated', v_cols);
END $grant$;
REVOKE SELECT (access_token, verify_token) ON public.whatsapp_config FROM PUBLIC, anon;   -- a no-op on prod today; belt and braces

-- 2. _bcast_bump: trigger-only.
REVOKE EXECUTE ON FUNCTION public._bcast_bump(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._bcast_bump(uuid, text, integer) TO service_role;

-- 3. self-check: abort the transaction if the end state is not exactly this.
DO $check$
DECLARE
  t constant regclass := 'public.whatsapp_config'::regclass;
  f constant regprocedure := 'public._bcast_bump(uuid, text, integer)'::regprocedure;
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF has_column_privilege(r, t, 'access_token', 'SELECT') OR has_column_privilege(r, t, 'verify_token', 'SELECT') THEN
      RAISE EXCEPTION '099: % can still read a whatsapp_config secret column', r;
    END IF;
    IF has_function_privilege(r, f, 'EXECUTE') THEN
      RAISE EXCEPTION '099: % can still execute _bcast_bump', r;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = t AND attnum > 0 AND NOT attisdropped AND attname NOT IN ('access_token', 'verify_token')
                AND NOT has_column_privilege('authenticated', t, attnum, 'SELECT')) THEN
    RAISE EXCEPTION '099: authenticated lost SELECT on a non-secret whatsapp_config column';
  END IF;
  IF NOT (has_table_privilege('authenticated', t, 'INSERT') AND has_table_privilege('authenticated', t, 'UPDATE')
          AND has_table_privilege('authenticated', t, 'DELETE')) THEN
    RAISE EXCEPTION '099: authenticated lost a write privilege on whatsapp_config';
  END IF;
  IF NOT (has_column_privilege('service_role', t, 'access_token', 'SELECT')
          AND has_column_privilege('service_role', t, 'verify_token', 'SELECT')
          AND has_function_privilege('service_role', f, 'EXECUTE')) THEN
    RAISE EXCEPTION '099: service_role lost access it needs';
  END IF;
END $check$;
