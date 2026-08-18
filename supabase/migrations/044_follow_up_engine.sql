-- 044_follow_up_engine.sql
-- KB-FOLLOWUP-R4-25
--
-- Automated re-engagement ladder (roadmap update B). Pre-purge, 50 of 100
-- conversations with inbound died in silence and only ~2% of leads ever
-- replied again after 7 quiet days; today nothing follows up at all and the
-- 14-day sweep just marks them Lost.
--
-- Shape:
--   follow_up_rungs — per-account ladder config. A rung is either free-form
--     `body` (sendable only inside WhatsApp's 24h service window, so its
--     delay must be < 24h) or an approved Meta `template_name` (sendable any
--     time). Editing = SQL or the settings UI; the dispatch route reads it
--     fresh every run.
--   follow_up_log — the once-only ledger. A rung fires at most once per
--     silence spell: a log row newer than the lead's last message blocks the
--     rung; when the lead replies, the clock and the ladder reset naturally
--     because older log rows no longer block anything.
--
-- Eligibility (follow_ups_due) — a lead is due when ALL hold:
--   * their deal sits in New Lead / Engaged / Qualified / Counselor Active
--     (Application Started+ is out of nurture scope; Lost is excluded, and
--     the explicit opt-out regex in Auretris parks leads in Lost);
--   * they have actually written to us at least once (broadcast-only
--     contacts get no follow-up: that would just be more broadcast);
--   * the bot has not been muted by a human takeover (bot_active, mig 036);
--   * the lowest active rung whose delay has elapsed has not fired this
--     spell, no higher rung has fired this spell (no regressions when the
--     engine is deployed into an old silence), and no follow-up of any kind
--     went out in the last 24h (spacing guard against rung pile-up).
--
-- Safety: the dispatch route caps sends per run on top of this; between the
-- cap, the 24h spacing, the 3-rung ladder, and the Lost exit at 14 days, a
-- lead can receive at most 3 follow-ups ever per silence spell. This is
-- deliberate — over-messaging degrades the Meta number's quality rating,
-- which throttles ALL sends including counsellor replies.
--
-- Seeded ladder (per existing account): rung 1 active at 22h (free-form,
-- inside the service window); rungs 2 (72h) and 3 (240h) reference Meta
-- templates that do not exist yet and are seeded INACTIVE — the operator
-- approves template copy before they ever fire.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.follow_ups_due(uuid, integer);
--   DROP TABLE IF EXISTS follow_up_log;
--   DROP TABLE IF EXISTS follow_up_rungs;

CREATE TABLE IF NOT EXISTS follow_up_rungs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL,
  rung_order INTEGER NOT NULL,
  delay_hours INTEGER NOT NULL,
  body TEXT,
  template_name TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (account_id, rung_order),
  CHECK (body IS NOT NULL OR template_name IS NOT NULL),
  CHECK (template_name IS NOT NULL OR delay_hours < 24)
);

CREATE TABLE IF NOT EXISTS follow_up_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  rung_id UUID NOT NULL REFERENCES follow_up_rungs(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_follow_up_log_contact_time
  ON follow_up_log(contact_id, sent_at DESC);

ALTER TABLE follow_up_rungs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Account members can read follow-up rungs" ON follow_up_rungs;
CREATE POLICY "Account members can read follow-up rungs" ON follow_up_rungs
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS "Account admins can update follow-up rungs" ON follow_up_rungs;
CREATE POLICY "Account admins can update follow-up rungs" ON follow_up_rungs
  FOR UPDATE USING (is_account_member(account_id, 'admin'::account_role_enum))
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));

ALTER TABLE follow_up_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Account members can read follow-up log" ON follow_up_log;
CREATE POLICY "Account members can read follow-up log" ON follow_up_log
  FOR SELECT USING (is_account_member(account_id));

-- Candidates for one dispatch run. Called by the dispatch route through the
-- service-role client only; not exposed to browser roles.
CREATE OR REPLACE FUNCTION public.follow_ups_due(
  p_account_id uuid,
  p_limit integer DEFAULT 25
) RETURNS TABLE (
  contact_id uuid,
  conversation_id uuid,
  rung_id uuid,
  rung_order integer,
  body text,
  template_name text,
  contact_name text,
  interest_university text,
  hours_silent numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ct.id,
    conv.id,
    rung.id,
    rung.rung_order,
    rung.body,
    rung.template_name,
    ct.name,
    intr.interest_university,
    round(EXTRACT(EPOCH FROM (now() - m.last_customer_at)) / 3600, 1)
  FROM contacts ct
  JOIN deals d ON d.contact_id = ct.id AND d.account_id = p_account_id
  JOIN pipeline_stages ps ON ps.id = d.stage_id
    AND ps.name IN ('New Lead', 'Engaged', 'Qualified', 'Counselor Active')
  JOIN LATERAL (
    SELECT c.id, c.bot_active FROM conversations c
    WHERE c.contact_id = ct.id
    ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1
  ) conv ON true
  JOIN LATERAL (
    SELECT max(msg.created_at) FILTER (WHERE msg.sender_type = 'customer') AS last_customer_at
    FROM messages msg
    JOIN conversations c2 ON c2.id = msg.conversation_id
    WHERE c2.contact_id = ct.id
  ) m ON m.last_customer_at IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT c.interest_university FROM conversations c
    WHERE c.contact_id = ct.id AND c.interest_updated_at IS NOT NULL
    ORDER BY c.interest_updated_at DESC LIMIT 1
  ) intr ON true
  JOIN LATERAL (
    SELECT r.* FROM follow_up_rungs r
    WHERE r.account_id = p_account_id
      AND r.active
      AND EXTRACT(EPOCH FROM (now() - m.last_customer_at)) / 3600 >= r.delay_hours
      AND (r.template_name IS NOT NULL
           OR EXTRACT(EPOCH FROM (now() - m.last_customer_at)) / 3600 < 24)
      -- this rung has not fired this spell
      AND NOT EXISTS (
        SELECT 1 FROM follow_up_log l
        WHERE l.contact_id = ct.id AND l.rung_id = r.id
          AND l.sent_at > m.last_customer_at)
      -- no higher rung has fired this spell
      AND NOT EXISTS (
        SELECT 1 FROM follow_up_log l
        JOIN follow_up_rungs r2 ON r2.id = l.rung_id
        WHERE l.contact_id = ct.id
          AND l.sent_at > m.last_customer_at
          AND r2.rung_order >= r.rung_order)
    ORDER BY r.rung_order
    LIMIT 1
  ) rung ON true
  WHERE ct.account_id = p_account_id
    AND COALESCE(conv.bot_active, true)
    -- spacing guard: at most one follow-up per contact per 24h
    AND NOT EXISTS (
      SELECT 1 FROM follow_up_log l
      WHERE l.contact_id = ct.id
        AND l.sent_at > now() - INTERVAL '24 hours')
  ORDER BY m.last_customer_at ASC
  LIMIT p_limit;
$$;

ALTER FUNCTION public.follow_ups_due(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.follow_ups_due(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.follow_ups_due(uuid, integer) TO service_role;

-- Seed the default ladder for every existing account (idempotent).
INSERT INTO follow_up_rungs (account_id, rung_order, delay_hours, body, template_name, active)
SELECT a.id, v.rung_order, v.delay_hours, v.body, v.template_name, v.active
FROM accounts a
CROSS JOIN (VALUES
  (1, 22,
   'Hi {{name}}, just checking in from Skeure Education. Happy to help with any questions about courses, fees or admissions. Shall we continue?',
   NULL::text, true),
  (2, 72, NULL, 'skeure_follow_up_3d', false),
  (3, 240, NULL, 'skeure_follow_up_final', false)
) AS v(rung_order, delay_hours, body, template_name, active)
WHERE NOT EXISTS (
  SELECT 1 FROM follow_up_rungs r
  WHERE r.account_id = a.id AND r.rung_order = v.rung_order
);

-- Table-level grants follow the repo convention (RLS does the enforcement;
-- PostgREST roles still need the grant or every access 42501s). The browser
-- roles get only what the RLS policies above allow anyway; service_role is
-- what the dispatch route writes the ledger with.
GRANT SELECT, UPDATE ON follow_up_rungs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON follow_up_rungs TO service_role;
GRANT SELECT ON follow_up_log TO authenticated;
GRANT SELECT, INSERT ON follow_up_log TO service_role;
