-- ============================================================
-- Conversation lifecycle + inbox consistency
--
-- 1. Preserve deals when an agent deletes a conversation.
-- 2. Merge historical duplicate conversations and prevent new races.
-- 3. Make Meta message ids idempotent.
-- 4. Derive conversation previews from messages for every writer,
--    including n8n's direct SQL inserts.
-- 5. Increment unread_count atomically and reopen closed chats on inbound.
-- ============================================================

-- A conversation is disposable message history; the deal/contact is CRM
-- history and must survive. The column is already nullable.
ALTER TABLE deals
  DROP CONSTRAINT IF EXISTS deals_conversation_id_fkey;
ALTER TABLE deals
  ADD CONSTRAINT deals_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;

-- The webhook previously used SELECT-then-INSERT without a uniqueness guard,
-- so simultaneous first messages could create more than one conversation for
-- an account/contact pair. Keep the oldest stable id and move all references.
DO $$
DECLARE
  duplicate_row RECORD;
BEGIN
  FOR duplicate_row IN
    WITH ranked AS (
      SELECT
        id,
        first_value(id) OVER (
          PARTITION BY account_id, contact_id
          ORDER BY created_at ASC, id ASC
        ) AS keep_id,
        row_number() OVER (
          PARTITION BY account_id, contact_id
          ORDER BY created_at ASC, id ASC
        ) AS row_number
      FROM conversations
    )
    SELECT id AS duplicate_id, keep_id
    FROM ranked
    WHERE row_number > 1
  LOOP
    UPDATE conversations AS keeper
    SET
      status = CASE
        WHEN keeper.status = 'open' OR duplicate.status = 'open' THEN 'open'
        WHEN keeper.status = 'pending' OR duplicate.status = 'pending' THEN 'pending'
        ELSE 'closed'
      END,
      assigned_agent_id = COALESCE(keeper.assigned_agent_id, duplicate.assigned_agent_id),
      unread_count = COALESCE(keeper.unread_count, 0) + COALESCE(duplicate.unread_count, 0)
    FROM conversations AS duplicate
    WHERE keeper.id = duplicate_row.keep_id
      AND duplicate.id = duplicate_row.duplicate_id;

    UPDATE deals
    SET conversation_id = duplicate_row.keep_id
    WHERE conversation_id = duplicate_row.duplicate_id;

    UPDATE flow_runs
    SET conversation_id = duplicate_row.keep_id
    WHERE conversation_id = duplicate_row.duplicate_id;

    UPDATE message_reactions
    SET conversation_id = duplicate_row.keep_id
    WHERE conversation_id = duplicate_row.duplicate_id;

    UPDATE messages
    SET conversation_id = duplicate_row.keep_id
    WHERE conversation_id = duplicate_row.duplicate_id;

    DELETE FROM conversations WHERE id = duplicate_row.duplicate_id;
  END LOOP;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_unique
  ON conversations(account_id, contact_id);

-- Empty ids behave like NULL and should not consume a uniqueness slot. If an
-- old import already duplicated a real WAMID, retain the oldest canonical id
-- and clear it on later copies before adding the guard.
UPDATE messages SET message_id = NULL WHERE btrim(message_id) = '';

WITH duplicate_message_ids AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY message_id
      ORDER BY created_at ASC, id ASC
    ) AS row_number
  FROM messages
  WHERE message_id IS NOT NULL
)
UPDATE messages AS message
SET message_id = NULL
FROM duplicate_message_ids AS duplicate
WHERE message.id = duplicate.id
  AND duplicate.row_number > 1;

DROP INDEX IF EXISTS idx_messages_message_id;
CREATE UNIQUE INDEX idx_messages_message_id_unique
  ON messages(message_id)
  WHERE message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION refresh_conversation_summary(
  target_conversation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  latest_message RECORD;
BEGIN
  SELECT
    COALESCE(NULLIF(content_text, ''), '[' || content_type || ']') AS preview,
    created_at
  INTO latest_message
  FROM messages
  WHERE conversation_id = target_conversation_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  UPDATE conversations
  SET
    last_message_text = latest_message.preview,
    last_message_at = latest_message.created_at
  WHERE id = target_conversation_id;
END;
$$;

REVOKE ALL ON FUNCTION refresh_conversation_summary(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION sync_conversation_summary_from_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_conversation_summary(OLD.conversation_id);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.conversation_id IS DISTINCT FROM NEW.conversation_id THEN
    PERFORM refresh_conversation_summary(OLD.conversation_id);
  END IF;

  PERFORM refresh_conversation_summary(NEW.conversation_id);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION sync_conversation_summary_from_message() FROM PUBLIC;

DROP TRIGGER IF EXISTS sync_conversation_summary_on_write ON messages;
CREATE TRIGGER sync_conversation_summary_on_write
AFTER INSERT OR DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION sync_conversation_summary_from_message();

DROP TRIGGER IF EXISTS sync_conversation_summary_on_update ON messages;
CREATE TRIGGER sync_conversation_summary_on_update
AFTER UPDATE OF conversation_id, content_text, content_type, created_at ON messages
FOR EACH ROW EXECUTE FUNCTION sync_conversation_summary_from_message();

-- Repair every stale/null preview before the trigger takes over future writes.
UPDATE conversations
SET last_message_text = NULL, last_message_at = NULL;

WITH latest_messages AS (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    COALESCE(NULLIF(content_text, ''), '[' || content_type || ']') AS preview,
    created_at
  FROM messages
  ORDER BY conversation_id, created_at DESC, id DESC
)
UPDATE conversations AS conversation
SET
  last_message_text = latest.preview,
  last_message_at = latest.created_at
FROM latest_messages AS latest
WHERE conversation.id = latest.conversation_id;

CREATE OR REPLACE FUNCTION mark_conversation_inbound(
  p_conversation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE conversations
  SET
    unread_count = COALESCE(unread_count, 0) + 1,
    status = CASE WHEN status = 'closed' THEN 'open' ELSE status END
  WHERE id = p_conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION mark_conversation_inbound(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_conversation_inbound(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION mark_conversation_inbound(UUID) TO service_role;
