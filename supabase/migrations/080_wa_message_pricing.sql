-- 080_wa_message_pricing.sql  (KB-SP3B-P1-02)
-- Meta's pricing object from status webhooks, one row per sent message, so the
-- month's API usage on each number is countable (1,000 free service messages
-- per number per month since 2026-10-01; delivery stops at the 1,001st without
-- a payment method). Written by the webhook (service role) only.
CREATE TABLE IF NOT EXISTS public.wa_message_pricing (
  message_id      text PRIMARY KEY,
  phone_number_id text NOT NULL,
  billable        boolean,
  category        text,
  pricing_type    text,
  pricing_model   text,
  first_seen_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wa_message_pricing_number_time
  ON public.wa_message_pricing (phone_number_id, first_seen_at);
ALTER TABLE public.wa_message_pricing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wa_message_pricing FROM anon, authenticated;
GRANT SELECT, INSERT ON public.wa_message_pricing TO service_role;

-- Calendar month in UTC. service_non_fep approximates the free-tier count:
-- service messages outside a free entry point window.
CREATE OR REPLACE VIEW public.wa_service_usage_monthly
WITH (security_invoker = true) AS
SELECT phone_number_id,
       date_trunc('month', first_seen_at AT TIME ZONE 'UTC') AS month,
       count(*)                                                AS api_messages,
       count(*) FILTER (WHERE billable)                        AS billable,
       count(*) FILTER (WHERE category = 'service'
                          AND coalesce(pricing_type, '') <> 'free_entry_point') AS service_non_fep
FROM public.wa_message_pricing
GROUP BY 1, 2;
REVOKE ALL ON public.wa_service_usage_monthly FROM anon, authenticated;
GRANT SELECT ON public.wa_service_usage_monthly TO service_role;
