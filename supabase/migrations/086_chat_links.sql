-- 086_chat_links.sql  (KB-CHATLINK-20261030, 2026-10-30)
-- Pratham: each counsellor should see the 79019 bot chat of their own leads, without a Kuanli login (counsellor
-- logins would see every lead). A chat link is a random 24-char token for one conversation, valid 7 days; the
-- public page /c/<token> shows only that conversation, read-only. Created by n8n at handover (create_chat_link).
-- Service role only (RLS on, no policies); n8n's own DB role executes the function.

CREATE TABLE IF NOT EXISTS public.chat_links (
  token           text PRIMARY KEY CHECK (token ~ '^[A-Za-z0-9_-]{24}$'),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX IF NOT EXISTS chat_links_conversation ON public.chat_links (conversation_id, expires_at DESC);
ALTER TABLE public.chat_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.chat_links TO service_role;

-- One live link per conversation: reuse one with more than a day left, else mint a new 7-day one. NULL in, NULL out.
CREATE OR REPLACE FUNCTION public.create_chat_link(p_conversation uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE t text;
BEGIN
  IF p_conversation IS NULL OR NOT EXISTS (SELECT 1 FROM conversations WHERE id = p_conversation) THEN RETURN NULL; END IF;
  SELECT token INTO t FROM chat_links
   WHERE conversation_id = p_conversation AND expires_at > now() + interval '1 day'
   ORDER BY expires_at DESC LIMIT 1;
  IF t IS NOT NULL THEN RETURN t; END IF;
  t := translate(encode(gen_random_bytes(18), 'base64'), '+/', '-_');
  INSERT INTO chat_links (token, conversation_id) VALUES (t, p_conversation);
  DELETE FROM chat_links WHERE expires_at < now() - interval '30 days';
  RETURN t;
END $$;
REVOKE ALL ON FUNCTION public.create_chat_link(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_chat_link(uuid) TO service_role;
