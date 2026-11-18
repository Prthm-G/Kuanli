-- 100_rollback.sql  (KB-FORMLEADS)
-- Undo 100: the form-lead functions and tables go. Contacts, deals and notes it created stay (they are leads now);
-- the apply script saves both tables to CSV first. Run with psql -1.

SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.ingest_form_lead(uuid, uuid, uuid, timestamptz, jsonb);
DROP FUNCTION IF EXISTS public.form_lead_poll_window(text, timestamptz);
DROP FUNCTION IF EXISTS public.form_lead_poll_ok(text);
DROP FUNCTION IF EXISTS public.form_lead_poll_failed(text, text);
DROP FUNCTION IF EXISTS public.form_lead_alerted(uuid);
DROP FUNCTION IF EXISTS public.form_lead_phone(text);
DROP TABLE IF EXISTS public.meta_form_lead_sync;
DROP TABLE IF EXISTS public.meta_form_leads;
