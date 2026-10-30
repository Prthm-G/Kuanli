-- 088_capi_course_recorded.sql  (KB-CAPI-R8-01)
--
-- LeadSubmitted also fires when the bot records the lead's course.
--
-- Why: 085 made LeadSubmitted "the lead tapped a specific course button"
-- (sel:course:*). That rate (43% of ad chats) was measured on Aug-Sep, when the
-- course picker was in the flow. Since 2026-10-01 no lead has tapped it: ad
-- leads type the course, and the bot classifies it. So from 085 going live
-- (2026-10-30 07:00 UTC) Kuanli sent Meta no lead event at all, where the old
-- Qualified mapping had sent ~3 a day.
--
-- conversations.interest_course is the bot's resolved course, mirrored from
-- bot_conversation_state by the n8n node "Mirror Interest to wacrm" (038). It is
-- set on 54% of ad chats (40 of 74 in the 35 days to 2026-10-30), against 72%
-- for the Qualified regex, and it still means "the lead named a course".
--
-- What this adds:
--   - record_conversion_from_course_recorded(): whenever a write leaves a
--     conversation with a course, call 085's queue_ad_conversion (ad chats only,
--     within 7 days of the click). Its ON CONFLICT keeps one LeadSubmitted per
--     conversation, so rewrites are no-ops; and a returning lead whose course
--     was known before the ad click is queued on the first write after it.
--     Same event_id as the course-tap path: whichever comes first wins.
--   - backfill_course_recorded_conversions(): queues ad chats whose course was
--     recorded before this migration and are still inside the 7-day window.
--     Called once below; event_time = interest_updated_at (the last mirror
--     write, the best time on record), or the click time for a returning lead
--     whose course was recorded before the click.
--
-- Unchanged: 085's course-tap and counsellor-reach triggers, and the deal
-- trigger (Qualified still reports nothing).
--
-- A queue failure is swallowed into a WARNING so the n8n mirror write never
-- fails; apply-kuanli-capi-course-088.mjs --verify counts misses.
--
-- Rollback: 088_rollback.sql (drops the trigger and both functions; queued rows are kept).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.record_conversion_from_course_recorded()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  BEGIN
    PERFORM queue_ad_conversion(NEW.id, 'LeadSubmitted', now());
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[capi] LeadSubmitted (course recorded) not queued for conversation %: % (%)',
      NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_conversion_from_course_recorded() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.backfill_course_recorded_conversions()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT c.id, GREATEST(c.interest_updated_at, COALESCE(c.ad_referral_msg_at, c.ad_referral_at)) AS at
      FROM conversations c
     WHERE c.ctwa_clid IS NOT NULL
       AND c.interest_course IS NOT NULL
       AND c.interest_updated_at IS NOT NULL
       AND COALESCE(c.ad_referral_msg_at, c.ad_referral_at) > now() - interval '7 days'
  LOOP
    IF queue_ad_conversion(r.id, 'LeadSubmitted', r.at) THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.backfill_course_recorded_conversions() FROM PUBLIC, anon, authenticated, service_role;

-- Stamp the apply time: --verify counts misses only from here on.
DO $$ BEGIN
  EXECUTE format('COMMENT ON FUNCTION public.record_conversion_from_course_recorded() IS %L',
                 'KB-CAPI-R8-01 applied ' || now()::text);
END $$;

-- UPDATE OF fires whenever n8n lists the column (every bot step), so organic
-- chats are filtered here rather than inside the function.
CREATE OR REPLACE TRIGGER conversations_record_course_recorded
  AFTER INSERT OR UPDATE OF interest_course ON public.conversations
  FOR EACH ROW
  WHEN (NEW.interest_course IS NOT NULL AND NEW.ctwa_clid IS NOT NULL)
  EXECUTE FUNCTION public.record_conversion_from_course_recorded();

-- The backfill runs after the trigger exists, under its lock, on purpose: a
-- mirror write committing between a backfill-first scan and CREATE TRIGGER
-- would be missed by both. ~a few dozen candidate rows, so the lock is held
-- for milliseconds more.
DO $$ BEGIN
  RAISE NOTICE '088 backfill queued % LeadSubmitted row(s)', public.backfill_course_recorded_conversions();
END $$;

COMMIT;
