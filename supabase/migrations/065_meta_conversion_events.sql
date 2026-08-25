-- 065_meta_conversion_events.sql
-- KB-CAPI-R5-41
--
-- Report admissions back to Meta so the ad algorithm can optimise, and keep a
-- durable record of every attempt.
--
-- Migration 061 captured `ctwa_clid` on the conversation. That is the half that
-- makes attribution POSSIBLE. This is the half that makes it PAY: until a
-- conversion is reported back against the click, Meta's optimiser is bidding
-- blind and Skeure's Rs 4 lakh of click-to-WhatsApp spend is buying clicks
-- rather than admissions.
--
-- WHY A TABLE AND NOT A FIRE-AND-FORGET CALL.
--
-- Every previous audit round of this project found the same shape of bug: a
-- failure that produced no message to the lead AND no record anywhere staff
-- would see. A conversion report is exactly that shape and worse, because it is
-- invisible on BOTH sides - the lead never knows, and Meta's UI shows only an
-- absence. A dropped conversion looks identical to a lead who never converted.
-- So every attempt gets a row here BEFORE the network call, and the row is
-- updated with the outcome. An unsent conversion is then a query, not an
-- archaeology dig through logs.
--
-- IDEMPOTENCY. `event_id` is deterministic - see buildEventId() in
-- src/lib/meta/conversions.ts - and UNIQUE here. Two things depend on that:
--   1. Meta deduplicates server events by `event_id`, so a retry after a
--      timeout cannot double-count an admission and inflate reported ROAS.
--   2. The unique violation is how this code knows a conversion was already
--      reported, without needing a separate read-then-write race.
-- The rule "one conversion per (conversation, event_name)" therefore lives in
-- exactly ONE place: this constraint. It is deliberately NOT also re-derived in
-- application code. This project's recurring defect is a rule enforced in two
-- places and kept in sync by eyeball; this migration refuses to add another.
--
-- WHY `waba_id` IS STORED PER ROW AND NOT LOOKED UP AT READ TIME.
--
-- A `ctwa_clid` is only meaningful against the WhatsApp Business Account that
-- minted it. This account owns two connected `whatsapp_config` rows on two
-- different WABAs, and the row flagged `is_primary` is NOT the one currently
-- receiving live traffic. Resolving the WABA later, from whatever happens to be
-- primary at that moment, would silently report conversions against the wrong
-- business account - which Meta does not error on, it simply attributes them
-- nowhere. Freezing the WABA at report time makes a mis-send auditable instead
-- of invisible.
--
-- Rollback:
--   DROP TABLE IF EXISTS meta_conversion_events;

CREATE TABLE IF NOT EXISTS meta_conversion_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

  -- Meta's event taxonomy. Free text rather than an enum: Meta adds standard
  -- events without warning and a custom event name is legal, so a CHECK here
  -- would reject valid payloads Meta accepts. The application types the set it
  -- actually sends.
  event_name      TEXT NOT NULL,

  -- Deterministic. See the IDEMPOTENCY note above; this is the ONLY place the
  -- one-conversion-per-kind rule is enforced.
  event_id        TEXT NOT NULL UNIQUE,

  -- The conversion's own time, not the send time. Meta rejects the ENTIRE
  -- request if any event_time is more than 7 days old, so this is checked
  -- before the call and recorded for the audit trail.
  event_time      TIMESTAMPTZ NOT NULL,

  -- Frozen at report time. See the WABA note above.
  waba_id         TEXT,
  dataset_id      TEXT,
  ctwa_clid       TEXT,

  -- Money. NUMERIC, never float: these are rupee amounts that get summed into
  -- reported revenue, and binary floating point cannot represent them exactly.
  -- The same reasoning as fee_templates.
  value           NUMERIC(12, 2),
  currency        TEXT,

  -- 'pending'  - row written, network call not yet resolved
  -- 'sent'     - Meta accepted it
  -- 'failed'   - Meta rejected it, or the call errored. Retryable.
  -- 'skipped'  - deliberately not sent (organic lead, outside the 7-day
  --              window, no resolvable WABA). NOT a failure, but recorded so
  --              "why was this not reported" is answerable.
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),

  -- Populated for 'failed' and 'skipped'. A status with no reason is the thing
  -- that makes an incident unexplainable a week later.
  reason          TEXT,
  -- Meta's fbtrace_id. The only handle their support will act on.
  fbtrace_id      TEXT,
  attempts        INT NOT NULL DEFAULT 0,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The retry sweep's only query: everything still owed to Meta, oldest first.
-- Partial so it stays proportional to the backlog rather than to all history -
-- the overwhelming majority of rows reach 'sent' and never need scanning again.
CREATE INDEX IF NOT EXISTS idx_meta_conversion_events_retry
  ON meta_conversion_events(created_at)
  WHERE status IN ('pending', 'failed');

-- "How did this lead's conversions get reported" during an investigation.
CREATE INDEX IF NOT EXISTS idx_meta_conversion_events_conversation
  ON meta_conversion_events(conversation_id);

-- Reporting: conversions per account per day.
CREATE INDEX IF NOT EXISTS idx_meta_conversion_events_account_time
  ON meta_conversion_events(account_id, event_time DESC);

ALTER TABLE meta_conversion_events ENABLE ROW LEVEL SECURITY;

-- Read-only to account members. Nothing in the product writes these from a
-- user session - the service role does, from the server - so there is
-- deliberately no INSERT/UPDATE policy. Adding one later should require
-- justifying who, other than the server, needs to forge a conversion record.
DROP POLICY IF EXISTS meta_conversion_events_select ON meta_conversion_events;
CREATE POLICY meta_conversion_events_select ON meta_conversion_events
  FOR SELECT USING (is_account_member(account_id));

-- The CAPI dataset id, resolved once from the WABA and cached. Nullable
-- because it is discovered lazily: an account that has never reported a
-- conversion has no dataset yet, and that is a normal state, not an error.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS capi_dataset_id TEXT;
