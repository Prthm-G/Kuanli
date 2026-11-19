-- 101_rollback.sql  (KB-FORMLEADS-101)
-- Undo 101: new form leads are no longer tagged or given a chat. The "Form lead" tag, its tags on contacts and the
-- chats it opened stay (they are ordinary rows now; delete them in Kuanli if wanted). Run with psql -1.

SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS meta_form_leads_surface ON public.meta_form_leads;
DROP FUNCTION IF EXISTS public.meta_form_leads_surface();
DROP FUNCTION IF EXISTS public.form_lead_surface(uuid, uuid, timestamptz, boolean);
DROP FUNCTION IF EXISTS public.form_lead_tag(uuid);
