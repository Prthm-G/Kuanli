-- 071_university_roll_number.sql
-- KB-STUPROF-R7-56: the roll/registration number the UNIVERSITY issues after
-- admission. Entirely separate from roll_number (the internal DCId, assigned
-- by triggers from migrations 006/026: LD-YYMM-#### placeholder on insert,
-- D<univ><yy><session>#### on enrollment) — that column and its triggers are
-- untouched. Counsellor-entered free text: universities differ in format
-- (LPU registration numbers, Amity enrollment numbers), so no CHECK.
-- No RLS change needed: contacts UPDATE already requires
-- is_account_member(account_id, 'agent').
-- Idempotent — safe to run multiple times.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS university_roll_number TEXT;

-- Rollback:
--   ALTER TABLE contacts DROP COLUMN IF EXISTS university_roll_number;
