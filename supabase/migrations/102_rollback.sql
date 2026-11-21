-- 102_rollback.sql  (KB-OPSBOT) - removes everything 102 added. Revert the n8n side first (Skeure Leads from its
-- backup, Kuanli Ops Bot off, Skeure Form Leads re-applied without form_lead_counsellor), or its calls fail.
-- ops_actions holds the undo data of past bot actions: the apply script saves it to CSV before this runs.
DROP FUNCTION IF EXISTS public.ops_bot(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.ops_pair_start(uuid, text, boolean);
DROP FUNCTION IF EXISTS public.ops_undo(uuid, bigint, bigint, boolean);
DROP FUNCTION IF EXISTS public.ops_cancel(uuid, bigint, bigint);
DROP FUNCTION IF EXISTS public.ops_apply(uuid, bigint, bigint);
DROP FUNCTION IF EXISTS public.ops_preview_move(uuid, bigint, text, text, text);
DROP FUNCTION IF EXISTS public.ops_preview_active(uuid, bigint, text, boolean);
DROP FUNCTION IF EXISTS public.ops_status_text(uuid, uuid);
DROP FUNCTION IF EXISTS public.form_lead_counsellor(uuid, uuid);
DROP FUNCTION IF EXISTS public.ops_lead_chats(uuid[], uuid);
DROP FUNCTION IF EXISTS public.ops_open_leads(uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.ops_names(uuid);
DROP FUNCTION IF EXISTS public.ops_counsellor_id(uuid, text);
DROP FUNCTION IF EXISTS public.ops_counsellor(uuid, text);   -- an early draft's name
DROP FUNCTION IF EXISTS public.ops_reply(bigint, text, text, bigint);
DROP TABLE IF EXISTS public.ops_actions;
DROP TABLE IF EXISTS public.ops_bot_owner;
