-- 050_fix_profiles_update_rls.sql
-- KB-PROFRLS-R4-30
--
-- Locks down the privilege columns on `profiles` (GHSA-fg5p-2qc3-jmxr, C1).
--
-- Ported from upstream ArnasDon/wacrm `034_fix_profiles_update_rls.sql`.
-- Renumbered to 050: our 034-049 are unrelated Kuanli migrations, so the
-- upstream number is already taken here. Content is upstream's, verified
-- against this fork (see "Checked against this fork" below).
--
-- The problem
--
--   `profiles_update` (migration 017) gates on `auth.uid() = user_id` only.
--   That is right for self-service fields (full_name, avatar_url), but
--   `account_role` and `account_id` also live on `profiles` and are the
--   source of truth for `is_account_member()`. RLS constrains which *rows*
--   you may update, not which *columns*, and no column GRANT or trigger
--   guards them. So any authenticated browser client can self-serve a
--   privilege escalation or a tenant move:
--
--     -- counsellor self-promotes to owner
--     UPDATE profiles SET account_role = 'owner' WHERE user_id = auth.uid();
--     -- attacker relocates into a victim tenant
--     UPDATE profiles SET account_id = '<victim>' WHERE user_id = auth.uid();
--
--   Both pass WITH CHECK because `user_id` is unchanged. Confirmed present
--   on this instance before this migration: pg_policies showed both `qual`
--   and `with_check` as `(uid() = user_id)`.
--
-- The fix
--
--   A BEFORE UPDATE trigger rejecting any change to `account_role` /
--   `account_id` when the caller is the `authenticated` role (the browser).
--   Updates that leave both columns untouched pass through untouched, so
--   self-service profile edits are unaffected.
--
-- Checked against this fork before porting
--
--   * Membership writers are all SECURITY DEFINER owned by `postgres`, so
--     `current_user` is `postgres`, not `authenticated`: handle_new_user,
--     redeem_invitation, set_member_role, transfer_account_ownership, and
--     remove_account_member (the last is ours, from migration 027, and is
--     not present upstream).
--   * Every membership route delegates to those RPCs
--     (api/invitations/[token]/redeem, api/account/members/[userId],
--     api/account/transfer-ownership) rather than writing the columns.
--   * The only `profiles` UPDATE in application code is
--     components/settings/profile-form.tsx, which writes `full_name` and
--     `avatar_url` only.
--   * Server-side routes use the service-role client, which is not
--     `authenticated`.
--
--   If a future non-DEFINER RPC or new role must write these columns,
--   extend the role check in the guard below.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS enforce_profile_privilege_columns ON public.profiles;
--   DROP FUNCTION IF EXISTS public.enforce_profile_privilege_columns();

CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role and account_id cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_profile_privilege_columns ON public.profiles;
CREATE TRIGGER enforce_profile_privilege_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_privilege_columns();
