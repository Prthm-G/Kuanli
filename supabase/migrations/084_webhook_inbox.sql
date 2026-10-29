-- 084_webhook_inbox.sql  (KB-WEBHOOK-INBOX-084, 2026-10-29)
-- The WhatsApp webhook answered Meta 200 and only then processed the payload in the background, so a crash or a
-- redeploy mid-message lost it for good (Meta does not resend after a 200). The route now stores the raw payload
-- here BEFORE the 200, marks it processed when done, and replays rows left unprocessed (crash, redeploy, error).
-- Replay is safe: inbound messages are deduplicated on Meta's wamid, statuses and echoes are upserts.
-- Service role only (RLS on, no policies). Processed rows are pruned after 7 days by claim_webhook_inbox.

CREATE TABLE IF NOT EXISTS public.webhook_inbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  body         jsonb NOT NULL,
  processed_at timestamptz,
  claimed_at   timestamptz,
  attempts     int NOT NULL DEFAULT 0,
  last_error   text
);
CREATE INDEX IF NOT EXISTS webhook_inbox_pending ON public.webhook_inbox (id) WHERE processed_at IS NULL;
ALTER TABLE public.webhook_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.webhook_inbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhook_inbox TO service_role;

-- Claims up to p_limit unprocessed rows older than p_min_age_seconds (a live request is still working on younger
-- ones), at most 5 attempts each, never a row another replayer claimed in the last 5 minutes. Prunes first.
CREATE OR REPLACE FUNCTION public.claim_webhook_inbox(p_limit int DEFAULT 20, p_min_age_seconds int DEFAULT 120)
RETURNS TABLE (id bigint, body jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  DELETE FROM public.webhook_inbox w WHERE w.processed_at < now() - interval '7 days';
  RETURN QUERY
  UPDATE public.webhook_inbox w SET attempts = w.attempts + 1, claimed_at = now()
   WHERE w.id IN (SELECT i.id FROM public.webhook_inbox i
                   WHERE i.processed_at IS NULL AND i.attempts < 5
                     AND i.received_at < now() - make_interval(secs => p_min_age_seconds)
                     AND (i.claimed_at IS NULL OR i.claimed_at < now() - interval '5 minutes')
                   ORDER BY i.id LIMIT p_limit
                   FOR UPDATE SKIP LOCKED)
  RETURNING w.id, w.body;
END $$;
REVOKE ALL ON FUNCTION public.claim_webhook_inbox(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_webhook_inbox(int, int) TO service_role;
