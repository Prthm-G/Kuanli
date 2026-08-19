-- 053_pgrst_schema_reload_watch.sql
-- KB-PGRSTWATCH-R4-33
--
-- On 2026-08-19 every inbound WhatsApp message stopped persisting for 72
-- minutes and the bot stopped replying. Nothing was wrong with the code or
-- the data: migration 051 added `messages.media_type`, the column landed in
-- Postgres, but PostgREST never learned about it and kept rejecting writes
-- with PGRST204 "Could not find the 'media_type' column ... in the schema
-- cache".
--
-- PostgREST caches the schema at boot and only refreshes when it receives a
-- NOTIFY on the `pgrst` channel. The stock Supabase image ships event
-- triggers that send that NOTIFY after any DDL; this database had none
-- (`select * from pg_event_trigger` returned zero rows), so the cache had
-- been frozen since the container last restarted.
--
-- The failure mode is what makes this worth a migration rather than a
-- one-off NOTIFY: the webhook returns 200 to Meta before it processes, so
-- Meta never retries, and the insert failure aborts the handler before it
-- reaches the n8n forward. A stale cache therefore drops messages silently
-- AND disables auto-replies, with no alert anywhere. Any future migration
-- that adds a column would do it again.
--
-- These are the upstream PostgREST/Supabase watch functions verbatim in
-- behaviour. They only ever send a notification -- they never modify data,
-- and a NOTIFY on a channel nobody listens to is a no-op.

CREATE OR REPLACE FUNCTION extensions.pgrst_ddl_watch() RETURNS event_trigger AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF cmd.command_tag IN (
      'CREATE SCHEMA', 'ALTER SCHEMA'
    , 'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE'
    , 'CREATE FOREIGN TABLE', 'ALTER FOREIGN TABLE'
    , 'CREATE VIEW', 'ALTER VIEW'
    , 'CREATE MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW'
    , 'CREATE FUNCTION', 'ALTER FUNCTION'
    , 'CREATE TRIGGER'
    , 'CREATE TYPE', 'ALTER TYPE'
    , 'CREATE RULE'
    , 'COMMENT'
    )
    -- don't notify in case of CREATE TEMP table or other objects created on pg_temp
    AND cmd.schema_name is distinct from 'pg_temp'
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION extensions.pgrst_drop_watch() RETURNS event_trigger AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects()
  LOOP
    IF obj.object_type IN (
      'schema'
    , 'table'
    , 'foreign table'
    , 'view'
    , 'materialized view'
    , 'function'
    , 'trigger'
    , 'type'
    , 'rule'
    )
    AND obj.is_temporary IS false -- no pg_temp objects
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$ LANGUAGE plpgsql;

DROP EVENT TRIGGER IF EXISTS pgrst_ddl_watch;
CREATE EVENT TRIGGER pgrst_ddl_watch
  ON ddl_command_end
  EXECUTE PROCEDURE extensions.pgrst_ddl_watch();

DROP EVENT TRIGGER IF EXISTS pgrst_drop_watch;
CREATE EVENT TRIGGER pgrst_drop_watch
  ON sql_drop
  EXECUTE PROCEDURE extensions.pgrst_drop_watch();

-- Pick up anything applied while the cache was frozen.
NOTIFY pgrst, 'reload schema';
