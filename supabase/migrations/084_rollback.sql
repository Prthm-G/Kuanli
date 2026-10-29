-- 084_rollback.sql: deploy the previous wacrm image first (the route tolerates a missing table: it falls back to
-- process-then-forget, but logs an error per webhook).
DROP FUNCTION IF EXISTS public.claim_webhook_inbox(int, int);
DROP TABLE IF EXISTS public.webhook_inbox;
