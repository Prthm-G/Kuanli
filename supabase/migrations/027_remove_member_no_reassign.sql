-- ============================================================
-- 027_remove_member_no_reassign.sql
--
-- Replaces remove_account_member's behavior. Previously it created a
-- fresh personal account and reassigned the removed member to it,
-- keeping their login usable elsewhere. The product requirement is
-- stricter: a removed member should not be able to sign back in at
-- all without a brand new invite.
--
-- This function now only removes their membership (deletes their
-- profiles row) - it no longer creates or reassigns any account.
-- The route handler (src/app/api/account/members/[userId]/route.ts)
-- is responsible for banning their auth.users row afterward via
-- admin.updateUserById(userId, { ban_duration: ... }).
--
-- Deliberately NOT auth.admin.deleteUser(): contacts/conversations/
-- deals/messages and several other tables still have ON DELETE
-- CASCADE foreign keys to auth.users.id left over from before this
-- app supported shared accounts (see migration 017). Deleting the
-- user outright would cascade-delete every contact/conversation/deal
-- attributed to their user_id - real CRM data, not just their own
-- login. Banning avoids that entirely: the row (and everything
-- correctly attributed to it) stays intact, they just can never
-- authenticate again.
--
-- Idempotent — safe to run multiple times.
-- ============================================================
DROP FUNCTION IF EXISTS public.remove_account_member(UUID);

CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM profiles WHERE user_id = p_user_id;

  RETURN true;
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;
