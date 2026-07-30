-- Merge lead_reassignment_attempts into lead_assignments.
--
-- WHAT THIS DOES
--   Re-grains lead_assignments from "one row per lead" (PRIMARY KEY (order_id), upserted in
--   place) to "one row per assignment CYCLE" - one row per agent who has held the lead.
--   Reassigning a lead then stamps the outgoing agent's row reassigned_away_at instead of
--   overwriting it, which is what lets this one table hold the history that
--   lead_reassignment_attempts used to hold separately.
--
--   A partial unique index on (order_id) WHERE reassigned_away_at IS NULL preserves the
--   invariant the old primary key gave us - at most ONE live row per lead - so every existing
--   write path keeps working as a single atomic upsert, and the lead_assignments_current view
--   is exactly the set of rows the table used to hold.
--
-- WHY IT IS RUN BY HAND, BEFORE DEPLOYING
--   1. api/_lib/db.js's ensurePgSchema() can perform this same migration automatically on a
--      Lambda cold start, but scripts/assign_leads.py and
--      scripts/sync_lead_assignments_to_mysql.py talk to Postgres directly and never call it.
--      The assign-leads cron runs every 5 minutes, so if the updated Python runs before the
--      Lambda has cold-started and migrated, it references reassigned_away_at /
--      lead_assignments_current before they exist and the run fails. Migrating first removes
--      that window entirely: ensurePgSchema then sees `id` already present and skips.
--   2. ADD COLUMN id BIGSERIAL PRIMARY KEY rewrites the whole table. Doing that inside a live
--      request risks that request's own timeout. Here it is just a slow statement.
--
-- HOW TO RUN
--   Everything below is one transaction. The preflight block RAISEs - aborting and applying
--   nothing - if the table is missing or already migrated, so it is safe to run twice.
--   To inspect before committing, run it with the final COMMIT replaced by ROLLBACK, check the
--   verification queries at the bottom, then run it again for real.
--
--   Nothing here DROPs data: lead_reassignment_attempts is RENAMED, not dropped, after its
--   rows are folded in. Confirm the verification queries look right, then drop it separately
--   whenever you are satisfied:
--       DROP TABLE lead_reassignment_attempts_premerge_20260730;

BEGIN;

-- ── Preflight ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'lead_assignments'
  ) THEN
    RAISE EXCEPTION 'lead_assignments does not exist - wrong database?';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lead_assignments' AND column_name = 'id'
  ) THEN
    RAISE EXCEPTION 'lead_assignments.id already exists - already migrated, nothing to do';
  END IF;
END $$;

-- ── 1. The column that marks a cycle as retired (NULL = this cycle is live) ───────────────
-- A timestamp, not a boolean: it strictly supersedes what the old side-table recorded, whose
-- own assigned_at was stamped now() at reassignment time (i.e. it was really "when this
-- attempt ended"). Keeping both means a row carries the true original assigned_at AND when
-- the lead was handed on.
ALTER TABLE lead_assignments ADD COLUMN IF NOT EXISTS reassigned_away_at TIMESTAMPTZ;

-- ── 2. Surrogate primary key replaces the order_id primary key ────────────────────────────
-- order_id can no longer be unique table-wide; the partial index in step 4 re-establishes
-- uniqueness where it still applies. The ADD COLUMN is the statement that rewrites the table.
--
-- The existing constraint's name is looked up rather than assumed to be the Postgres default
-- 'lead_assignments_pkey' - if it were ever created under another name, a hardcoded DROP would
-- fail here, and the ADD COLUMN below would then fail anyway for having two primary keys.
DO $$
DECLARE
  pk_name TEXT;
BEGIN
  SELECT conname INTO pk_name
  FROM pg_constraint
  WHERE conrelid = 'lead_assignments'::regclass AND contype = 'p';

  IF pk_name IS NULL THEN
    RAISE EXCEPTION 'lead_assignments has no primary key constraint - unexpected shape, aborting';
  END IF;

  EXECUTE format('ALTER TABLE lead_assignments DROP CONSTRAINT %I', pk_name);
END $$;

ALTER TABLE lead_assignments ADD COLUMN id BIGSERIAL PRIMARY KEY;

-- ── 3. Fold lead_reassignment_attempts in, then set it aside ──────────────────────────────
-- Each of its rows is one past failed attempt and knew only (order_id, email, when logged),
-- so assigned_at and reassigned_away_at both take that one timestamp: an honest "this attempt
-- is over", without inventing a start time it never recorded. These rows carry no awb_code and
-- a non-NULL reassigned_away_at, so they sit outside both partial indexes built in step 4.
--
-- Renamed rather than dropped so this migration destroys nothing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'lead_reassignment_attempts'
  ) THEN
    INSERT INTO lead_assignments (order_id, email, assigned_at, reassigned_away_at)
    SELECT order_id, email, assigned_at, assigned_at FROM lead_reassignment_attempts;

    ALTER TABLE lead_reassignment_attempts
      RENAME TO lead_reassignment_attempts_premerge_20260730;
  END IF;
END $$;

-- ── 4. Indexes ───────────────────────────────────────────────────────────────────────────
-- At most one LIVE row per lead - the invariant the old primary key provided, re-expressed so
-- retired cycles can coexist. Both write paths target this index with ON CONFLICT, so each
-- stays a single atomic upsert with no read-then-write race.
CREATE UNIQUE INDEX lead_assignments_order_id_current_key
  ON lead_assignments (order_id) WHERE reassigned_away_at IS NULL;

-- awb_code's uniqueness becomes partial for the same reason: a lead's successive cycles share
-- one AWB (one physical shipment, successive agents), which a table-wide unique index would
-- reject. Restricted to live rows it still enforces what it is actually for - one AWB never
-- belonging to two different live leads at once.
DROP INDEX IF EXISTS lead_assignments_awb_code_key;
CREATE UNIQUE INDEX lead_assignments_awb_code_key
  ON lead_assignments (awb_code) WHERE reassigned_away_at IS NULL;

-- Plain index for whole-history lookups: assign_leads.py's fetch_reassignment_attempts scans
-- every retired row to build its "this agent already failed on this lead" exclusion set.
CREATE INDEX IF NOT EXISTS lead_assignments_order_id_idx ON lead_assignments (order_id);

-- ── 5. The live-cycle view every current-state reader selects from ────────────────────────
-- No DISTINCT ON needed to pick a winner: step 4's unique index already guarantees at most one
-- row per order_id here.
CREATE OR REPLACE VIEW lead_assignments_current AS
  SELECT * FROM lead_assignments WHERE reassigned_away_at IS NULL;

COMMIT;

-- ── Verification (run after committing) ───────────────────────────────────────────────────
-- 1. Every lead has exactly one live cycle, and retired rows carry the folded-in history.
--    live_rows should equal the row count lead_assignments had before this migration;
--    retired_rows should equal lead_reassignment_attempts' old row count.
--
-- SELECT count(*) FILTER (WHERE reassigned_away_at IS NULL) AS live_rows,
--        count(*) FILTER (WHERE reassigned_away_at IS NOT NULL) AS retired_rows,
--        count(*) AS total_rows
-- FROM lead_assignments;
--
-- 2. Confirms retired_rows above matches what was folded in (0 rows = they match).
--
-- SELECT count(*) AS folded_in_count FROM lead_reassignment_attempts_premerge_20260730;
--
-- 3. The live-cycle invariant holds - MUST return zero rows.
--
-- SELECT order_id, count(*) FROM lead_assignments_current GROUP BY 1 HAVING count(*) > 1;
--
-- 4. The view is readable and matches the live-row count from query 1.
--
-- SELECT count(*) FROM lead_assignments_current;
--
-- 5. Both partial indexes exist with their predicates.
--
-- SELECT indexname, indexdef FROM pg_indexes
-- WHERE tablename = 'lead_assignments' ORDER BY indexname;
