-- Backfill connected = 'No' on the retired cycles folded in from lead_reassignment_attempts.
--
-- WHY THIS IS AN INFERENCE, AND WHY IT IS A SAFE ONE
--   A lead only ever becomes reassignable by reading Connected=No - see assign_leads.py's
--   module docstring and REASSIGN_RETRY_CAP. So for any row that was reassigned away, "this
--   agent did not reach the customer" is entailed by the reassignment itself, not guessed at.
--   The old lead_reassignment_attempts table simply had nowhere to record it: its whole schema
--   was (order_id, email, assigned_at).
--
-- WHAT IS DELIBERATELY *NOT* BACKFILLED
--   Only `connected` is entailed. Everything else about those attempts is genuinely unknown and
--   stays NULL rather than being invented:
--     - disposition   - 'Customer Not Reachable' is the likely value but several dispositions
--                       carry Connected=No; picking one would fabricate a specific fact.
--     - attempt       - the attempt number was never recorded anywhere.
--     - agent_remarks - free text that only the agent wrote; there is nothing to reconstruct.
--     - awb_code / rto_reason - shipment data these log rows never carried.
--     - disposed_at   - THE IMPORTANT ONE. Every disposal-side KPI in api/_lib/db.js filters on
--                       `disposed_at IS NOT NULL` (total_disposed, connect rate, refunds, the
--                       hourly dial series, the partner breakdown). Setting it would pull 118
--                       rows into all of them on the strength of an invented timestamp and
--                       visibly move numbers that are currently correct. Leaving it NULL is what
--                       makes this backfill legibility-only: it changes what a row SAYS when you
--                       read it, and changes no reported metric. Verified either side of this.
--
-- SCOPE GUARD
--   Restricted to the legacy signature - retired, connected IS NULL, and assigned_at exactly
--   equal to reassigned_away_at, which is true of all 118 folded rows and of nothing else (the
--   merge migration set both fields from the side table's single timestamp; a genuine cycle has
--   a real gap between being assigned and being handed on). So this cannot touch a
--   post-migration retired cycle, which carries its own real disposition already.
--
--   Idempotent: connected IS NULL means a second run matches nothing.

BEGIN;

DO $$
DECLARE
  eligible   INT;
  updated    INT;
  kpi_before INT;
  kpi_after  INT;
BEGIN
  -- Disposal-side KPI count before, to prove this changes no metric.
  SELECT count(*) INTO kpi_before FROM lead_assignments WHERE disposed_at IS NOT NULL;

  SELECT count(*) INTO eligible FROM lead_assignments
  WHERE reassigned_away_at IS NOT NULL
    AND connected IS NULL
    AND assigned_at = reassigned_away_at;

  IF eligible = 0 THEN
    RAISE NOTICE 'nothing eligible - already backfilled, or no legacy rows present';
    RETURN;
  END IF;

  UPDATE lead_assignments SET connected = 'No'
  WHERE reassigned_away_at IS NOT NULL
    AND connected IS NULL
    AND assigned_at = reassigned_away_at;
  GET DIAGNOSTICS updated = ROW_COUNT;

  IF updated <> eligible THEN
    RAISE EXCEPTION 'expected to update % row(s) but updated % - aborting', eligible, updated;
  END IF;

  -- Nothing gained a disposed_at, so the disposal-side denominator must be untouched.
  SELECT count(*) INTO kpi_after FROM lead_assignments WHERE disposed_at IS NOT NULL;
  IF kpi_after <> kpi_before THEN
    RAISE EXCEPTION
      'disposal-side KPI count moved from % to % - this backfill must not affect metrics, aborting',
      kpi_before, kpi_after;
  END IF;

  RAISE NOTICE 'backfilled connected=No on % legacy retired cycle(s); disposal KPI count unchanged at %',
    updated, kpi_after;
END $$;

COMMIT;

-- ── Verification (run after committing) ───────────────────────────────────────────────────
-- Legacy retired cycles now read connected='No', with everything unknown still NULL:
--
-- SELECT connected, count(*) AS n,
--        count(disposition) AS with_disposition,
--        count(disposed_at) AS with_disposed_at,
--        count(attempt)     AS with_attempt
-- FROM lead_assignments WHERE reassigned_away_at IS NOT NULL GROUP BY 1;
--
-- Metrics unmoved (should still be 3368 / 3551 as of this migration):
-- SELECT count(*) FILTER (WHERE disposed_at IS NOT NULL) AS calls_disposed,
--        count(*) FILTER (WHERE reassigned_away_at IS NULL) AS leads
-- FROM lead_assignments;
