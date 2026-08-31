-- 076_rollback.sql
-- Reverts 076 by dropping the two columns it added.
--
-- Destructive in the sense that any recorded failure reasons are lost, but 076
-- added no constraint, no index and no trigger, so nothing else depends on them.
-- Dropping a column is catalogue-only, same as adding one was.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE messages DROP COLUMN IF EXISTS error_code;
ALTER TABLE messages DROP COLUMN IF EXISTS error_details;

COMMIT;
