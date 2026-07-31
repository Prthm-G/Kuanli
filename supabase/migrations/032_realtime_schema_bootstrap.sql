-- Supabase Realtime runs its tenant migrations in this schema on first
-- connection. Self-hosted installs must create the schema before the Realtime
-- service can create realtime.schema_migrations and its helper functions.
CREATE SCHEMA IF NOT EXISTS realtime AUTHORIZATION supabase_admin;
