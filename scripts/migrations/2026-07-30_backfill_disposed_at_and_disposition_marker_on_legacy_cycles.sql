-- Fill the remaining blanks on the 118 legacy retired cycles: disposed_at and disposition.
-- Follow-on to 2026-07-30_backfill_connected_no_on_legacy_retired_cycles.sql.
--
-- THIS ONE MOVES REPORTED NUMBERS. The connected=No backfill did not, because those rows had no
-- disposed_at and every disposal-side metric in api/_lib/db.js filters on disposed_at IS NOT
-- NULL. Giving them one brings all 118 into those metrics:
--
--     total_disposed        3368  ->  3486
--     unreachable           1871  ->  1989
--     connected (numerator) 1497  ->  1497   (unchanged - none of these connected)
--     connect rate            44% ->    43%
--     hourly dial series    +29 dials in IST hour 11, +89 in hour 18
--     partner breakdown     +118 under 'Unknown' (these rows carry no awb_code)
--
-- That is arguably the more truthful reading: these were real calls that really failed, and
-- leaving them out of the connect-rate denominator flatters the number. But it is a visible
-- change to a headline KPI produced from an approximate timestamp, so it should be a decision
-- someone made on purpose rather than a side effect - hence its own migration, with the numbers
-- written down above.
--
-- disposed_at = reassigned_away_at
--   Not the real disposal instant, which was never recorded. It is a genuine UPPER BOUND: the
--   agent's Connected=No is what made the lead reassignable, so the call necessarily happened
--   at or before the moment it was handed on. Same-day and same-hour in practice, since
--   assign_leads.py reassigns on the run following the disposal, minutes later.
--
-- disposition = 'Not Recorded (pre-merge)'
--   A SENTINEL, deliberately not a real disposition. Nine distinct dispositions in this table
--   carry Connected=No - 'Ringing / No Answer' (1184), 'Disconnected' (157), 'Switch Off' (126),
--   'Not Reachable' (125), 'Invalid Number' (109), 'Line Busy' (107), and others - so there is
--   no value that can be inferred. Writing the most common one would be wrong for roughly 37%
--   of these rows and would inflate a real category by 10% with fabricated entries no report
--   could tell from genuine ones. This value is self-describing instead: it fills the blank,
--   survives into any breakdown as its own visible bucket, and can never be mistaken for
--   something an agent chose.
--
--   It is also inert against every disposition-matching metric: 'reordered' looks for
--   'Customer Agreed to Accept' / 'Product Issue / Exchange' and 'refunded' for
--   'Refund Requested', none of which this matches. So it adds no reorder or refund.
--
-- attempt and agent_remarks stay NULL - the attempt number and the agent's own free text were
-- never recorded in any system and have no bound or sentinel worth inventing.
--
-- Scoped, as before, by the legacy signature: retired, and assigned_at exactly equal to
-- reassigned_away_at. True of all 118 folded rows and nothing else, since the merge set both
-- fields from the side table's single timestamp while a real cycle has a gap between being
-- assigned and being handed on. Idempotent via disposed_at IS NULL.
--
-- TO REVERSE (the scope guard identifies exactly these rows):
--     UPDATE lead_assignments SET disposed_at = NULL, disposition = NULL
--     WHERE reassigned_away_at IS NOT NULL AND assigned_at = reassigned_away_at
--       AND disposition = 'Not Recorded (pre-merge)';

BEGIN;

DO $$
DECLARE
  eligible INT;
  updated  INT;
  d_before INT;
  d_after  INT;
BEGIN
  SELECT count(*) INTO d_before FROM lead_assignments WHERE disposed_at IS NOT NULL;

  SELECT count(*) INTO eligible FROM lead_assignments
  WHERE reassigned_away_at IS NOT NULL
    AND assigned_at = reassigned_away_at
    AND disposed_at IS NULL;

  IF eligible = 0 THEN
    RAISE NOTICE 'nothing eligible - already applied, or no legacy rows present';
    RETURN;
  END IF;

  UPDATE lead_assignments
     SET disposed_at  = reassigned_away_at,
         disposition  = 'Not Recorded (pre-merge)'
   WHERE reassigned_away_at IS NOT NULL
     AND assigned_at = reassigned_away_at
     AND disposed_at IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;

  IF updated <> eligible THEN
    RAISE EXCEPTION 'expected % row(s), updated % - aborting', eligible, updated;
  END IF;

  -- disposed_at must never land after the lead left the agent.
  IF EXISTS (
    SELECT 1 FROM lead_assignments
    WHERE reassigned_away_at IS NOT NULL AND disposed_at > reassigned_away_at
  ) THEN
    RAISE EXCEPTION 'a retired cycle has disposed_at after reassigned_away_at - aborting';
  END IF;

  SELECT count(*) INTO d_after FROM lead_assignments WHERE disposed_at IS NOT NULL;
  IF d_after <> d_before + updated THEN
    RAISE EXCEPTION 'disposal count moved from % to %, expected % - aborting',
      d_before, d_after, d_before + updated;
  END IF;

  RAISE NOTICE 'filled % legacy cycle(s); disposal-side count % -> % (expected, see header)',
    updated, d_before, d_after;
END $$;

COMMIT;

-- ── Verification (run after committing) ───────────────────────────────────────────────────
-- No blanks left on the legacy rows except attempt/agent_remarks:
-- SELECT connected, disposition, count(*) AS n, count(disposed_at) AS with_disposed_at,
--        count(attempt) AS with_attempt
-- FROM lead_assignments WHERE reassigned_away_at IS NOT NULL GROUP BY 1,2;
--
-- The sentinel is its own bucket and no real category grew:
-- SELECT disposition, count(*) FROM lead_assignments GROUP BY 1 ORDER BY 2 DESC;
--
-- Expect 3486 disposed / 1989 unreachable / 1497 connected -> 43% connect rate:
-- SELECT count(*) FILTER (WHERE disposed_at IS NOT NULL) AS disposed,
--        count(*) FILTER (WHERE connected='Yes' AND disposed_at IS NOT NULL) AS connected,
--        count(*) FILTER (WHERE connected='No'  AND disposed_at IS NOT NULL) AS unreachable
-- FROM lead_assignments;
