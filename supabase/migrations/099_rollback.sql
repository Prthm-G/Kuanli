-- 099_rollback.sql  (KB-AUTHZ-099): puts the grants back as they were before 099. Re-opens both holes.
-- The KB-AUTHZ-099 image works with or without 099 (it reads the token through the service client), so the image
-- does not need to roll back with this.
REVOKE SELECT ON public.whatsapp_config FROM authenticated;   -- clears the column-level grants 099 made
GRANT SELECT ON public.whatsapp_config TO authenticated;
GRANT EXECUTE ON FUNCTION public._bcast_bump(uuid, text, integer) TO PUBLIC, anon, authenticated;
