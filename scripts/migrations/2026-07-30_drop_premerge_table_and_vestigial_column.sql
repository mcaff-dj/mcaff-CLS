-- Cleanup after 2026-07-30_merge_reassignment_attempts_into_lead_assignments.sql.
--
-- Two things, both verified against production before being written:
--
--   1. lead_reassignment_attempts_premerge_20260730 - the pre-merge side table, kept by the
--      merge migration rather than dropped so the fold could be checked against the original.
--      It has been: 118 rows on both sides, no unmatched row in either direction, and the
--      (order_id, lower(email)) exclusion set that assign_leads.py actually consumes is
--      identical. The guard below re-proves all of that and ABORTS rather than dropping if it
--      no longer holds, so this stays safe to run later or twice.
--
--   2. lead_assignments."Total_attempts" - a smallint that exists in the live database but in
--      no code, no migration, and no ensurePgSchema() definition in this repo; it was added out
--      of band. It is 100% NULL across all 3669 rows, nothing reads or writes it, and its
--      quoted mixed-case name means any SQL touching it must spell it "Total_attempts" - a
--      standing footgun in a schema that is otherwise all snake_case.
--
--      Dropping it costs nothing (there is no data to lose) and is trivially reversible:
--          ALTER TABLE lead_assignments ADD COLUMN "Total_attempts" smallint;
--      It is also redundant now. Per-cycle rows mean the count of attempts on a lead is
--      derivable - count(*) FROM lead_assignments WHERE order_id = ... - so a column that has
--      to be maintained by hand to answer the same question is strictly worse than the query.
--      If the intent was a rollup on the LIVE row specifically, that is
--      lead_assignments_current joined to that count, not a stored smallint nobody updates.
--
--      Note the existing `attempt` TEXT column is unrelated despite the similar name: it holds
--      sheet values like 'Delivered' / 'Already Refunded' / 'To be refunded' - statuses, not
--      counts - so this drop takes nothing that column was standing in for.
--
-- The view has to be rebuilt around the drop: lead_assignments_current is SELECT *, which
-- expands to an explicit column list at creation time, so it holds a real dependency on
-- "Total_attempts" and would block ALTER TABLE ... DROP COLUMN. Dropped and recreated here in
-- the same transaction, with the same definition ensurePgSchema() uses, so a later cold start's
-- CREATE OR REPLACE VIEW is a no-op rather than a conflict.

BEGIN;

-- ── Guard: refuse to drop the side table unless the fold is provably complete ─────────────
DO $$
DECLARE
  preserved_rows INT;
  missing_in_new INT;
  extra_in_new   INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'lead_reassignment_attempts_premerge_20260730'
  ) THEN
    RAISE NOTICE 'premerge table already dropped - skipping that half';
    RETURN;
  END IF;

  SELECT count(*) INTO preserved_rows FROM lead_reassignment_attempts_premerge_20260730;

  SELECT count(*) INTO missing_in_new FROM (
    SELECT DISTINCT order_id, lower(email) AS e FROM lead_reassignment_attempts_premerge_20260730
    EXCEPT
    SELECT DISTINCT order_id, lower(email) AS e FROM lead_assignments WHERE reassigned_away_at IS NOT NULL
  ) x;

  SELECT count(*) INTO extra_in_new FROM (
    SELECT DISTINCT order_id, lower(email) AS e FROM lead_assignments WHERE reassigned_away_at IS NOT NULL
    EXCEPT
    SELECT DISTINCT order_id, lower(email) AS e FROM lead_reassignment_attempts_premerge_20260730
  ) y;

  IF missing_in_new <> 0 OR extra_in_new <> 0 THEN
    RAISE EXCEPTION
      'fold mismatch - refusing to drop: % preserved rows, % missing from lead_assignments, % unexpected extras',
      preserved_rows, missing_in_new, extra_in_new;
  END IF;

  RAISE NOTICE 'fold verified: % rows, exclusion sets identical - safe to drop', preserved_rows;
  DROP TABLE lead_reassignment_attempts_premerge_20260730;
END $$;

-- ── Drop the vestigial column, rebuilding the dependent view around it ────────────────────
DO $$
DECLARE
  non_null_values INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lead_assignments' AND column_name = 'Total_attempts'
  ) THEN
    RAISE NOTICE '"Total_attempts" already dropped - nothing to do';
    RETURN;
  END IF;

  -- Never drop a column that turned out to be carrying data after all.
  EXECUTE 'SELECT count("Total_attempts") FROM lead_assignments' INTO non_null_values;
  IF non_null_values <> 0 THEN
    RAISE EXCEPTION
      '"Total_attempts" holds % non-null value(s) - refusing to drop; investigate what wrote them first',
      non_null_values;
  END IF;

  DROP VIEW IF EXISTS lead_assignments_current;
  ALTER TABLE lead_assignments DROP COLUMN "Total_attempts";
  CREATE VIEW lead_assignments_current AS
    SELECT * FROM lead_assignments WHERE reassigned_away_at IS NULL;
  RAISE NOTICE '"Total_attempts" dropped (was entirely NULL); view rebuilt';
END $$;

COMMIT;

-- ── Verification (run after committing) ───────────────────────────────────────────────────
-- Both must report false, and the view must still return the live-cycle count:
--
-- SELECT EXISTS (SELECT 1 FROM information_schema.tables
--                WHERE table_name='lead_reassignment_attempts_premerge_20260730') AS side_table_still_there,
--        EXISTS (SELECT 1 FROM information_schema.columns
--                WHERE table_name='lead_assignments' AND column_name='Total_attempts') AS column_still_there;
--
-- SELECT count(*) AS live_cycles FROM lead_assignments_current;
--
-- Retired history must be untouched by the drop (still 118):
-- SELECT count(*) AS retired FROM lead_assignments WHERE reassigned_away_at IS NOT NULL;
