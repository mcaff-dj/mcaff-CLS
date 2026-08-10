-- Add a partial index on lead_assignments.disposed_at, for rows where it's actually set.
--
-- WHY: `disposed_at IS NOT NULL AND disposed_at >= $from AND disposed_at <= $to` is the
-- filter behind essentially every disposal-side KPI in api/_lib/db.js -
-- getCallingOverviewStats' total_disposed/unreachable/connected/refund breakdowns,
-- getCallingHourlyStats' dial-time histogram, and the partner breakdown query - each hit
-- on every Overview-tab load and every range change. scripts/sync_lead_assignments_to_mysql.py
-- filters the same column for its own yesterday/aged-row sync queries. None of that is
-- covered by any index defined in ensurePgSchema (only lead_assignments_order_id_idx and the
-- two partial order_id/awb_code unique indexes exist) - every one of the above is a
-- sequential scan of the whole table today, and lead_assignments only grows.
--
-- PARTIAL, not a plain index on the whole column: most rows are still-pending/unassigned
-- with disposed_at NULL, and every query above already filters disposed_at IS NOT NULL
-- first - indexing only the rows that filter can ever match keeps the index smaller and
-- keeps a plain INSERT of a fresh pending assignment (disposed_at NULL) from having to
-- update this index at all.
--
-- CONCURRENTLY (needs no transaction block, hence run by hand rather than folded into
-- ensurePgSchema): lead_assignments is smaller than agent_presence_log today, but a bare
-- CREATE INDEX still takes a lock that would block every disposal write
-- (recordLeadDisposition) for the build's duration - not worth risking on a table this
-- migration can't inspect the live size of.
--
-- Verification after running:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'lead_assignments';
--   -- expect lead_assignments_disposed_at_idx alongside the existing order_id/awb_code ones

CREATE INDEX CONCURRENTLY IF NOT EXISTS lead_assignments_disposed_at_idx
  ON lead_assignments (disposed_at)
  WHERE disposed_at IS NOT NULL;
