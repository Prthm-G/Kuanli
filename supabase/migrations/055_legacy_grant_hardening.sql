-- 055_legacy_grant_hardening.sql
-- KB-GRANTS-R4-35
--
-- Takes `anon` off every table in the public schema, and takes the three
-- non-row-level privileges off `authenticated`.
--
-- Where this came from
--
--   Supabase's bootstrap sets ALTER DEFAULT PRIVILEGES so that tables created
--   in `public` are granted ALL PRIVILEGES to anon, authenticated and
--   service_role. Migrations 001-030 inherited that silently. The later,
--   hand-written migrations do not: 044's follow_up_log grants authenticated
--   only SELECT, 045's application_documents only SELECT and UPDATE. This
--   migration brings the older 28 tables in line with the newer convention.
--
-- What was verified before writing this, against the live database
--
--   anon reads ZERO rows from all 28 tables today: every RLS policy routes
--   through is_account_member() or auth.uid(), and anon has neither. The
--   logged-out /join flow does not touch tables at all — it calls
--   peek_invitation / redeem_invitation, which hold their own EXECUTE grant
--   to anon (migration 019) and are unaffected by anything here.
--
--   So this is behaviour-preserving for the application. It is not cosmetic:
--
--     TRUNCATE is not row-level. Demonstrated on a scratch table with a
--     deny-all policy: the role saw 0 rows through RLS and still truncated
--     the table completely. Every one of the 28 tables grants TRUNCATE to
--     both anon and authenticated today, so RLS is not what stands between a
--     logged-in user and the whole tenant's data — the fact that PostgREST
--     never emits a TRUNCATE is. That is a property of the client, not a
--     guarantee of the database, and it is the only thing holding.
--
--     REFERENCES and TRIGGER are likewise DDL-adjacent and are not something
--     an application role ever needs.
--
--   SELECT / INSERT / UPDATE / DELETE stay with authenticated, because those
--   are the operations RLS actually governs and the app depends on them.
--   service_role keeps everything: it is the trusted server-side key, it
--   already bypasses RLS by design, and the webhook, cron and dispatch routes
--   run through it.
--
-- The default privileges are corrected too, or the next migration applied by
-- the wrong role re-creates the problem one table at a time. That is exactly
-- what happened to 054 on its first apply.
--
-- Idempotent, and safe to re-run. Rollback (should something unforeseen need
-- anon back, which nothing in this codebase does):
--   GRANT ALL ON ALL TABLES IN SCHEMA public TO anon;

-- ============================================================
-- 1. Existing tables
-- ============================================================
DO $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', r.relname);
    EXECUTE format(
      'REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM authenticated',
      r.relname);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'Hardened grants on % tables in public', n;
END $$;

-- ============================================================
-- 2. Sequences
--
-- The same default privileges handed anon USAGE on every sequence. A sequence
-- grant is only reachable by a role that can also INSERT into the owning
-- table, which anon now cannot, but leaving it would be leaving half the job.
-- ============================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind = 'S'
  LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM anon', r.relname);
  END LOOP;
END $$;

-- ============================================================
-- 3. The root cause: default privileges
--
-- Written for every role that has a default-privilege entry in `public`, so
-- it does not matter which of them applies a future migration. Postgres has
-- no "ALTER DEFAULT PRIVILEGES FOR ALL ROLES", hence the loop.
--
-- Note this cannot be expressed as a REVOKE of a subset for anon — the entry
-- is dropped outright, which is the intent: new tables should grant anon
-- nothing at all.
-- ============================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT pg_get_userbyid(defaclrole) AS role_name
    FROM pg_default_acl d
    JOIN pg_namespace ns ON ns.oid = d.defaclnamespace
    WHERE ns.nspname = 'public'
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
      'REVOKE ALL ON TABLES FROM anon', r.role_name);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
      'REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM authenticated',
      r.role_name);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
      'REVOKE ALL ON SEQUENCES FROM anon', r.role_name);
    RAISE NOTICE 'Corrected default privileges for role %', r.role_name;
  END LOOP;
END $$;

-- ============================================================
-- 4. Assert the result, so a partial apply fails loudly here rather than
--    looking fine and leaving a hole.
-- ============================================================
DO $$
DECLARE
  v_anon integer;
  v_trunc integer;
BEGIN
  SELECT count(*) INTO v_anon
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee = 'anon';

  SELECT count(*) INTO v_trunc
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee = 'authenticated'
    AND privilege_type = 'TRUNCATE';

  IF v_anon <> 0 OR v_trunc <> 0 THEN
    RAISE EXCEPTION
      'Grant hardening incomplete: % anon table grants, % authenticated TRUNCATE grants remain',
      v_anon, v_trunc;
  END IF;

  RAISE NOTICE 'Verified: no anon table grants, no authenticated TRUNCATE in public';
END $$;
