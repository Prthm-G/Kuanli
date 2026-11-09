-- 092_rollback.sql  (KB-FAILED-REPLY-PING-20261108): removes everything 092 added. Nothing else depended on it.
DROP FUNCTION IF EXISTS public.claim_failed_reply_pings(text, int, int, int);
DROP TABLE IF EXISTS public.failed_reply_pings;
