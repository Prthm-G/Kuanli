-- 076_message_delivery_errors.sql
-- Upstream: ArnasDon/wacrm#535
--
-- When Meta reports an outbound message as failed, the status webhook carries an
-- errors[] array explaining why. handleStatusUpdate wrote only the status string
-- and discarded it, so every failure landed as a row saying 'failed' with no
-- recorded cause and nothing in the logs. Operators could not tell a per-user
-- marketing cap from an opted-out recipient from a number that was never on
-- WhatsApp, and the three need completely different responses.
--
-- Columns chosen deliberately, and they are not the obvious pair:
--
--   error_code     INTEGER  Meta's numeric code. This is the field to branch on.
--   error_details  TEXT     errors[0].error_data.details.
--
-- No error_title column. Meta's error codes reference states that handling
-- should be built around code and details, and that titles "will eventually be
-- deprecated". The same reference documents errors[0].message as carrying the
-- same value as errors[0].title, so storing either adds a column that duplicates
-- the other and is on a deprecation path. details is the more specific string of
-- the two and is what survives.
--
-- Both columns are nullable with no default, so on Postgres 11+ this is a
-- catalogue-only change. No table rewrite and no long lock on what is the
-- largest table in the schema.
--
-- Schema-qualified deliberately. A Supabase database also has realtime.messages,
-- owned by a different role. An unqualified ALTER resolves by search_path, which
-- happens to be right here and would be wrong for anyone whose search_path
-- differs. Qualifying costs nothing and removes the ambiguity.
--
-- Verified against developers.facebook.com status webhook reference
-- (updated 2026-05-21) and error codes reference (updated 2026-06-18) on
-- 2026-08-31.
--
-- Deliberately out of scope: broadcast_recipients.error_message is still only
-- written from the client-side send path, never from the webhook. That is the
-- same bug on the table where marketing template failures actually land, and it
-- is worth its own change rather than being smuggled into this one.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS error_code INTEGER;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS error_details TEXT;

COMMENT ON COLUMN public.messages.error_code IS
  'Meta error code from the status webhook errors[0].code. Branch on this, not on any title.';
COMMENT ON COLUMN public.messages.error_details IS
  'Meta errors[0].error_data.details. Falls back to errors[0].title when details is absent.';

COMMIT;
