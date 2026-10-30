-- 086_rollback.sql: removes chat links (old links stop working; the /c page then shows "link expired").
DROP FUNCTION IF EXISTS public.create_chat_link(uuid);
DROP TABLE IF EXISTS public.chat_links;
