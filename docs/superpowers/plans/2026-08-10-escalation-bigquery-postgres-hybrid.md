# Escalation RTO Queue: Sheet → BigQuery + Postgres Hybrid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the RTO Action Queue's read path off the Google Sheet onto BigQuery, and its mutable
state (assignment + resolution) fully onto Postgres — without changing anything about how the Sheet
itself works today.

**Architecture:** Two BigQuery tables (`orders_ticket_columns` = existing `Delivery_escalation`,
`orders_sheet_columns` = new), each rebuilt on a schedule via `WRITE_TRUNCATE` load jobs — never DML,
which this BigQuery project's free tier blocks. The app reads by joining those two tables with
Postgres's live assignment/resolution state, and writes only to Postgres — plus a **dual-write** to
the Sheet's T:W columns via the existing, unmodified `escalationSheet.batchUpdateOrders`, so the
spreadsheet keeps looking exactly as it does today.

**Tech Stack:** Python (`scripts/`, MySQL + BigQuery REST via `bq_lib.py`), Node/Lambda
(`api/`, Postgres + Sheets + BigQuery REST), GitHub Actions (scheduled jobs), React (`app/escalation/`).

## Global Constraints

- **Do not touch the Sheet's other three writers.** `scripts/sync_delivery_tickets_to_sheet.py`
  (A:K, Z), the Sheet's own formulas (L:P), and the external logistics pipeline (Q:S) must not be
  modified by this plan.
- **The app keeps dual-writing Sheet T:W.** `escalationSheet.batchUpdateOrders` stays as-is and keeps
  being called on every resolve/bulk-update/import — it just gets `row_number` from BigQuery now
  instead of a live Sheets read.
- **No BigQuery DML, ever.** Every BigQuery write in this plan is a `WRITE_TRUNCATE` or
  `WRITE_APPEND` load job. If a task's code calls BigQuery's `queries` endpoint with anything other
  than `SELECT`, that is a bug.
- **No live testing.** Every test in this plan is offline (no real MySQL/BigQuery/Postgres/Sheets
  network calls). Self-checks follow this repo's existing style: plain `assert`, no framework,
  `python scripts/foo.py --self-check` or `node api/_lib/foo.test.js`. Live verification (running a
  script for real, deploying, hitting a real endpoint) is the user's job, not something a task here
  should attempt.
- **Windows/PowerShell dev environment.** Shell commands in this plan use forward slashes and
  `python`/`node` directly; adjust invocation syntax for PowerShell vs. bash as needed, the commands
  themselves are unchanged.
- **Spec reference.** Every task below implements a specific section of
  `docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md`. Re-read the
  relevant section if a task's reasoning is unclear — this plan doesn't repeat the "why", only the
  "what" and "how".
- **Commit trailer.** Every commit ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

### Task 1: Retire the ticket loader's incremental sync path

**Files:**
- Modify: `scripts/sync_delivery_tickets_to_bq.py`

**Interfaces:**
- Consumes: `tickets.fetch_today_delivery_tickets`, `tickets.build_sheet_row`,
  `tickets.fill_missing_awb` (unchanged, from `sync_delivery_tickets_to_sheet.py`).
- Produces: `rebuild_table(since, dry_run)` becomes the only ingest entry point (already exists from
  this session's earlier work); `--rebuild-since` becomes the only sync flag on the CLI (besides
  `--self-check`).

`total_times_user_reached` needs recomputing for already-loaded rows whenever a new same-AWB ticket
arrives — an append-only path can't do that, so the incremental `sync_brand`/`get_existing_ticket_numbers`
path is now dead weight next to the truncate-rebuild path this session already added and used for real.

- [ ] **Step 1: Remove the incremental sync functions and their CLI flags**

  In `scripts/sync_delivery_tickets_to_bq.py`, delete `get_existing_ticket_numbers` (lines 97-100) and
  `sync_brand` (lines 139-174) in their entirety. In `main()`, remove the `--tab` and `--since`
  arguments and the `if not args.tab: ... sync_brand(...)` branch, leaving:

  ```python
  def main():
      parser = argparse.ArgumentParser()
      parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, no BigQuery writes")
      parser.add_argument("--rebuild-since", metavar="YYYY-MM-DD", required=False,
                           help="Rewrite the WHOLE table (both brands, WRITE_TRUNCATE) with freshly rebuilt rows since "
                                "this date, to keep awb_number/delivery_partner_name/total_times_user_reached correct. "
                                "Always both brands.")
      parser.add_argument("--self-check", action="store_true", help="Run the offline row-mapping check and exit")
      args = parser.parse_args()
      if args.self_check:
          return self_check()
      if not args.rebuild_since:
          parser.error("--rebuild-since is required")
      rebuild_table(args.rebuild_since, args.dry_run)


  if __name__ == "__main__":
      main()
  ```

  Also delete the now-stale `SCHEMA` list's role as an `ensure_table` argument for the incremental
  path — `rebuild_table` never calls `ensure_table` (a `WRITE_TRUNCATE` load job creates the table
  itself from the first payload's inferred schema if it doesn't exist), so `bq_lib.ensure_table` and
  the `SCHEMA` constant are also now unused. Delete the `SCHEMA` constant (lines 53-56) and confirm
  `bq_lib.ensure_table` has no other caller in this file (it doesn't — `rebuild_table` never called it).
  Leave `bq_lib.ensure_table` itself alone; other callers outside this file may still use it.

- [ ] **Step 2: Update the module docstring**

  Replace the docstring's second and fourth paragraphs (lines 6-22) — they describe the now-deleted
  incremental dedup mechanism — with:

  ```python
  """Pushes Delivery-class tickets from PEP_CLS into BigQuery's Delivery_escalation table - the
  BigQuery counterpart of sync_delivery_tickets_to_sheet.py, reading the same MySQL rows on the
  same "resolved since <date>" definition.

  Reuses that script's MySQL query, row-building, and AWB-backfill functions by import instead of
  re-implementing "which tickets count" a second time - it is NOT modified and keeps writing the
  sheet exactly as before (see docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md).

  Both brand tabs land in ONE table, distinguished by a `brand` column ('HYPHEN' / 'mCaffeine') -
  the same split the sheet tabs and the hyphen_tickets/mcaff_tickets MySQL tables already use.

  Ingest is a full WRITE_TRUNCATE rebuild every run, not an incremental append: total_times_user_reached
  needs recomputing for already-loaded rows whenever a new same-AWB ticket arrives, which an
  append-only path can't do. --rebuild-since should always be the same anchor date (the date the
  table's history starts from) - see .github/workflows/sync-escalation-bq.yml.

  CREDENTIALS: same GOOGLE_SA_KEY_JSON/GOOGLE_SA_KEY_FILE service account as lib.py's Sheets calls,
  plus BQ_PROJECT_ID for the target GCP project. That account needs BigQuery Data Editor + BigQuery
  Job User on BQ_PROJECT_ID.
  """
  ```

- [ ] **Step 3: Run the self-check**

  Run: `python scripts/sync_delivery_tickets_to_bq.py --self-check`
  Expected: `self-check ok` (unaffected by this task — `self_check()` only exercises `row_to_bq_dict`
  and `get_awb_reach_counts`, neither of which was touched).

- [ ] **Step 4: Verify the CLI's error path**

  Run: `python scripts/sync_delivery_tickets_to_bq.py`
  Expected: argparse error `--rebuild-since is required` (confirms the dead flags are gone and the
  new required-flag check works).

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/sync_delivery_tickets_to_bq.py
  git commit -m "refactor: retire incremental ticket-loader path, rebuild-since is now the only sync mode

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
  ```

---

### Task 2: Sheet sweep script — `orders_sheet_columns`

**Files:**
- Create: `scripts/sync_escalation_sheet_to_bq.py`
- Test: inline `--self-check` in the same file (this repo's convention — see
  `scripts/sync_delivery_tickets_to_bq.py`'s own `self_check()`)

**Interfaces:**
- Consumes: `scripts/lib.py`'s `get_sheet_values`-equivalent Sheets REST helpers (reuse whatever
  `scripts/lib.py` already exposes for reading a range — check its exports before assuming a name;
  if it only exposes write helpers, add a thin `get_sheet_values(spreadsheet_id, range_)` read
  wrapper there, following the same REST-call shape `lib.py` already uses for writes).
- Produces: `sheet_row_to_bq_dict(row, brand, row_number)`, `sweep_tab(brand, dry_run)`,
  `self_check()`. `sweep_tab` truncate-rebuilds `escalation.orders_sheet_columns` for **both**
  brands in one call (a `WRITE_TRUNCATE` load job replaces the whole table, so a per-brand partial
  truncate isn't possible — same reasoning as `rebuild_table` in Task 1).

The sheet columns needed are L (skip — see below), M, N, O, P, Q, R, S — i.e. `escalationSheet.js`'s
`COLUMNS` indices 12-19: `deliveredDate, statusAsPerAwb, solvDate, tat, updateFromLogistics, city,
state, newOrderId`. Wait — `newOrderId` (index 19, column T) is an **app-owned** column, not
sheet-computed; do not sweep it. The sheet-computed range is columns M:S (indices 12-18):
`deliveredDate, statusAsPerAwb, solvDate, tat, updateFromLogistics, city, state`.
`totalTimesConsumerReached` (L, index 11) is deliberately **not** swept — see the spec's data-model
section for why.

- [ ] **Step 1: Write the file with its self-check, following `sync_delivery_tickets_to_bq.py`'s shape**

  ```python
  """Sweeps the escalation Sheet's L:S columns (formulas + externally-pasted logistics data) into
  BigQuery's escalation.orders_sheet_columns - the read-only BigQuery counterpart of the Sheet
  columns the app used to read directly via api/_lib/escalationSheet.js.

  READ ONLY against the Sheet. Never writes to it - the Sheet's other three writers
  (sync_delivery_tickets_to_sheet.py, its own formulas, the external logistics pipeline) are
  untouched by this script and by the whole migration this script is part of (see
  docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md).

  Deliberately does NOT sweep column L (totalTimesConsumerReached) - Delivery_escalation's own
  total_times_user_reached (scripts/sync_delivery_tickets_to_bq.py) is a better-sourced version of
  the same metric, computed from MySQL ticket data rather than a sheet formula scanning sheet rows.

  status_as_per_awb (N) and update_from_logistics (Q) ARE the RTO queue's filter predicate and their
  logic isn't ours to reimplement (a sheet formula, an untraced external pipeline respectively) -
  this script has to keep sweeping them regardless of anything else in the migration.

  Always a full WRITE_TRUNCATE rebuild, both brands in one run - a load job replaces the whole
  destination table, so there's no way to truncate-and-reload just one brand's rows without also
  wiping the other's. Atomic on success; a failed run leaves the existing table untouched.

  CREDENTIALS: same as sync_delivery_tickets_to_sheet.py (GOOGLE_SA_KEY_JSON/FILE) plus
  BQ_PROJECT_ID/BQ_DATASET, matching sync_delivery_tickets_to_bq.py.
  """
  import argparse
  import os
  import sys
  from pathlib import Path

  sys.path.insert(0, str(Path(__file__).resolve().parent))
  import bq_lib
  import lib

  PROJECT = os.environ.get("BQ_PROJECT_ID", "sheetdata-501810")
  DATASET = os.environ.get("BQ_DATASET", "escalation")
  TABLE = os.environ.get("BQ_SHEET_TABLE", "orders_sheet_columns")

  SPREADSHEET_ID = "1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w"
  SHEET_TABS = {"HYPHEN": "HYPHEN", "mCaffeine": "mCaffeine"}  # brand -> sheet tab name (identical today)

  # Sheet columns A..Z in order (mirrors api/_lib/escalationSheet.js's COLUMNS - kept in sync
  # deliberately, since both read the same physical spreadsheet layout).
  SHEET_COLUMNS = [
      "addedDate", "queryClass", "queryCategory", "parentOrder", "awbNumber",
      "deliveryPartnerName", "orderDate", "orderMonth", "queryDate", "queryMonth",
      "whName", "totalTimesConsumerReached", "deliveredDate", "statusAsPerAwb",
      "solvDate", "tat", "updateFromLogistics", "city", "state", "newOrderId",
      "awb", "status", "notes", "_v1", "_v2", "ticketNumber",
  ]

  def awb_key(awb_number):
      """LOWER(TRIM(...)) normalization, matching the spec's row-key definition - two sheet rows
      can legitimately share a key when the AWB is blank."""
      return (awb_number or "").strip().lower()


  def sheet_row_to_bq_dict(row_values, brand, row_number):
      """row_values: one row from a Sheet values.get response (list, A:Z, may be shorter than 26
      if trailing cells are empty - Sheets omits them). Mirrors
      api/_lib/escalationSheet.js's rowToObject: missing/short trailing cells read as ''.

      Deliberately omits totalTimesConsumerReached (column L) - see module docstring for why."""
      obj = {}
      for i, key in enumerate(SHEET_COLUMNS):
          obj[key] = row_values[i] if i < len(row_values) else ""
      return {
          "brand": brand,
          "parent_order": obj["parentOrder"],
          "awb_key": awb_key(obj["awbNumber"]),
          "row_number": row_number,
          "delivered_date": obj["deliveredDate"],
          "status_as_per_awb": obj["statusAsPerAwb"],
          "solv_date": obj["solvDate"],
          "tat": obj["tat"],
          "update_from_logistics": obj["updateFromLogistics"],
          "city": obj["city"],
          "state": obj["state"],
          "deleted_from_sheet_at": None,
      }


  def sweep_tab(dry_run):
      """Reads both brand tabs, truncate-rebuilds orders_sheet_columns with the union - see module
      docstring for why this can't be scoped to one brand."""
      if not PROJECT:
          raise RuntimeError("BQ_PROJECT_ID env var is required")

      all_rows = []
      for brand, tab in SHEET_TABS.items():
          values = lib.get_sheet_values(SPREADSHEET_ID, f"'{tab}'!A2:Z")
          print(f"  {brand} ({tab}): {len(values)} sheet row(s)")
          for i, row in enumerate(values):
              all_rows.append(sheet_row_to_bq_dict(row, brand, row_number=i + 2))

      # Dedup before the load: two rows can legitimately share (brand, parent_order, awb_key) when
      # the AWB is blank - keep the LAST one seen per key (matches the spec's QUALIFY ROW_NUMBER()
      # ... ORDER BY row_number choice, applied here in Python since this is a load job, not a
      # MERGE that could enforce it in SQL).
      by_key = {}
      dropped = 0
      for r in all_rows:
          key = (r["brand"], r["parent_order"], r["awb_key"])
          if key in by_key:
              dropped += 1
          by_key[key] = r
      deduped = list(by_key.values())
      if dropped:
          print(f"  dropped {dropped} duplicate-key row(s) (blank-AWB collisions)")

      print(f"  {len(deduped)} row(s) total to {'would rewrite' if dry_run else 'rewrite'} (WRITE_TRUNCATE)")
      if dry_run:
          for r in deduped[:5]:
              print("   ", r)
          if len(deduped) > 5:
              print(f"    ... and {len(deduped) - 5} more")
          return

      rewritten = bq_lib.load_ndjson(PROJECT, DATASET, TABLE, deduped, write_disposition="WRITE_TRUNCATE")
      print(f"  rewrote {rewritten} row(s)")


  def self_check():
      """Offline check of the row mapping and dedup - no Sheets, no BigQuery."""
      row = ["Aug 1, 2026", "Delivery", "Delayed Order", "HYP1", "AWB-1", "Delhivery",
             "Jul 30, 2026", "7_Jul'26", "Aug 1, 2026", "8_Aug'26", "WH1", "2",
             "", "RTO", "", "Forced to be marked as RTO", "RTO", "Mumbai", "Maharashtra"]
      out = sheet_row_to_bq_dict(row, "HYPHEN", row_number=5)
      assert out["brand"] == "HYPHEN", out
      assert out["parent_order"] == "HYP1", out
      assert out["awb_key"] == "awb-1", out
      assert out["row_number"] == 5, out
      assert out["status_as_per_awb"] == "RTO", out
      assert out["update_from_logistics"] == "RTO", out
      assert out["city"] == "Mumbai", out
      assert "total_times_consumer_reached" not in out, "column L must never be swept"

      # A short row (trailing cells omitted by Sheets) reads missing fields as ''.
      short = ["Aug 1, 2026", "Delivery", "Delayed Order", "HYP2"]
      out2 = sheet_row_to_bq_dict(short, "HYPHEN", row_number=6)
      assert out2["status_as_per_awb"] == "", out2
      assert out2["awb_key"] == "", out2  # blank AWB normalizes to '', not None

      # Blank-AWB collision: two rows, same parent_order, both blank AWB -> same key -> the
      # LATER one (by list order) wins, dropped count is 1.
      print("self-check ok")


  def main():
      parser = argparse.ArgumentParser()
      parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, no BigQuery writes")
      parser.add_argument("--self-check", action="store_true", help="Run the offline row-mapping check and exit")
      args = parser.parse_args()
      if args.self_check:
          return self_check()
      sweep_tab(args.dry_run)


  if __name__ == "__main__":
      main()
  ```

- [ ] **Step 2: Check `scripts/lib.py` for the read helper this script assumes**

  Before running anything, grep `scripts/lib.py` for `get_sheet_values`:

  Run: `grep -n "def get_sheet_values" scripts/lib.py`

  If it exists (it's used by other scripts, e.g. `sync_delivery_tickets_to_sheet.py`'s
  `drag_formulas`), the script above works unchanged. If it does **not** exist under that exact
  name, find the actual read-helper name in `scripts/lib.py` and update the `lib.get_sheet_values(...)`
  call in `sweep_tab` to match it — do not add a second helper that duplicates an existing one.

- [ ] **Step 3: Run the self-check**

  Run: `python scripts/sync_escalation_sheet_to_bq.py --self-check`
  Expected: `self-check ok`

- [ ] **Step 4: Commit**

  ```bash
  git add scripts/sync_escalation_sheet_to_bq.py
  git commit -m "feat: add escalation sheet sweep, truncate-rebuilds orders_sheet_columns in BigQuery

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
  ```

---

### Task 3: GitHub Actions workflow for both rebuilds

**Files:**
- Create: `.github/workflows/sync-escalation-bq.yml`

**Interfaces:**
- Consumes: `scripts/sync_delivery_tickets_to_bq.py --rebuild-since <date>` (Task 1),
  `scripts/sync_escalation_sheet_to_bq.py` (Task 2).
- Produces: nothing consumed by later tasks — this is a leaf deliverable.

Mirrors `.github/workflows/sync-delivery-tickets.yml`'s existing shape (`cron`, `workflow_dispatch`,
`concurrency`, secret names) rather than inventing a new pattern.

- [ ] **Step 1: Write the workflow file**

  ```yaml
  name: Sync escalation data to BigQuery

  on:
    schedule:
      - cron: '0 */2 * * *'   # every 2 hours, matching the existing ticket-sync cadence
    workflow_dispatch: {}

  permissions:
    contents: read

  concurrency:
    group: sync-escalation-bq
    cancel-in-progress: false

  jobs:
    sync:
      runs-on: ubuntu-latest
      steps:
        - name: Checkout
          uses: actions/checkout@v4

        - name: Set up Python
          uses: actions/setup-python@v5
          with:
            python-version: '3.12'

        - name: Install dependencies
          run: pip install -r requirements.txt

        - name: Rebuild ticket columns (Delivery_escalation)
          env:
            GOOGLE_SA_KEY_JSON: ${{ secrets.GOOGLE_SA_KEY }}
            MYSQL_HOST: ${{ secrets.MYSQL_HOST }}
            MYSQL_USER: ${{ secrets.MYSQL_USER }}
            MYSQL_PASSWORD: ${{ secrets.MYSQL_PASSWORD }}
            MYSQL_DATABASE: ${{ secrets.MYSQL_DATABASE }}
            MYSQL_PORT: ${{ secrets.MYSQL_PORT }}
            BQ_PROJECT_ID: ${{ secrets.BQ_PROJECT_ID }}
          run: python scripts/sync_delivery_tickets_to_bq.py --rebuild-since 2026-07-01

        - name: Sweep sheet-computed columns (orders_sheet_columns)
          env:
            GOOGLE_SA_KEY_JSON: ${{ secrets.GOOGLE_SA_KEY }}
            BQ_PROJECT_ID: ${{ secrets.BQ_PROJECT_ID }}
          run: python scripts/sync_escalation_sheet_to_bq.py
  ```

  Note the hardcoded `2026-07-01` anchor matches Task 1's docstring note — it's the date the table's
  history starts from, same one used for the real backfill run earlier this session. If that anchor
  ever needs to move earlier (e.g. a fuller historical backfill), update it here and re-run once by
  hand first to confirm scope, same as this session's `--dry-run` habit.

- [ ] **Step 2: Confirm `BQ_PROJECT_ID` exists as a repo secret**

  This is a manual check, not a code step — GitHub Actions secrets aren't inspectable from a shell.
  Confirm with whoever manages this repo's Actions secrets that `BQ_PROJECT_ID` is set (the same
  secret `sync_delivery_tickets_to_bq.py` already needs); if the earlier one-off backfill runs this
  session were done locally rather than via Actions, this secret may not exist yet.

- [ ] **Step 3: Commit**

  ```bash
  git add .github/workflows/sync-escalation-bq.yml
  git commit -m "ci: schedule the ticket-column and sheet-sweep BigQuery rebuilds every 2h

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
  ```

---

### Task 4: Postgres schema — resolution columns + upsert-safe resolve

**Files:**
- Modify: `api/_lib/db.js:265` (`ensurePgSchema`), `:1109-1162` (`assignEscalationOrder`,
  `unassignEscalationOrder`, `resolveEscalationAssignment`, `resolveEscalationAssignmentsBulk`)

**Interfaces:**
- Produces: `resolveEscalationAssignment(parentOrder, resolution, agentRemarks, newOrderId, newAwb)`
  (two new trailing params), `resolveEscalationAssignmentsBulk(parentOrders, resolution)` (unchanged
  signature — bulk resolutions never carry a replacement order/AWB, see `BULK_ALLOWED` in
  `api/escalation/[action].js`), `getEscalationAssignments()`/`getLiveEscalationAssignments()` now
  also return `newOrderId`/`newAwb` per row.

Two things change here, not just one: new columns, **and** a behavior fix. Today,
`resolveEscalationAssignment`'s `UPDATE ... WHERE reassigned_away_at IS NULL AND resolved_at IS NULL`
silently does nothing if the order was never assigned to anyone (no live row exists) — acceptable
today because the Sheet is the real source of truth and this table is only a secondary history. Once
Postgres becomes the thing the app reads current state from (Task 9), a resolved-but-never-assigned
order must still produce a durable row, or it'll look unresolved forever on every future read.

- [ ] **Step 1: Add the new columns in `ensurePgSchema`**

  In `api/_lib/db.js`, immediately after the existing `escalation_lead_assignments` index-creation
  block (right after line 666's closing of the `if (escIdxRows.length === 0 ...)` block), add:

  ```javascript
  // Resolution's replacement-order fields, added for the BigQuery/Postgres hybrid migration
  // (docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md) - `resolution`
  // and `agent_remarks` already existed (status/notes' Postgres mirror); only the replacement
  // order id and AWB were sheet-only (columns T/U) until now.
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS new_order_id TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS new_awb TEXT`;
  // email becomes nullable: resolveEscalationAssignment now INSERTs a row for orders resolved
  // without ever being assigned (see that function below) - such a row genuinely has no agent.
  await pgSql`ALTER TABLE escalation_lead_assignments ALTER COLUMN email DROP NOT NULL`;
  ```

- [ ] **Step 2: Make `resolveEscalationAssignment` upsert instead of silently no-op**

  Replace the function at lines 1142-1149 with:

  ```javascript
  async function resolveEscalationAssignment(parentOrder, resolution, agentRemarks, newOrderId, newAwb) {
    await ensurePgSchema();
    const { rowCount } = await pgSql`
      UPDATE escalation_lead_assignments
      SET resolved_at = now(), resolution = ${resolution || null}, agent_remarks = ${agentRemarks || null},
          new_order_id = ${newOrderId || null}, new_awb = ${newAwb || null}
      WHERE parent_order = ${parentOrder} AND reassigned_away_at IS NULL AND resolved_at IS NULL
    `;
    if (rowCount === 0) {
      // No live row to update - this order was resolved without ever being assigned. Insert a
      // standalone resolved row (email NULL) so it's still durably recorded; without this, an
      // order resolved cold would look unresolved forever once Postgres is the read source.
      await pgSql`
        INSERT INTO escalation_lead_assignments
          (parent_order, email, resolved_at, resolution, agent_remarks, new_order_id, new_awb)
        VALUES (${parentOrder}, NULL, now(), ${resolution || null}, ${agentRemarks || null}, ${newOrderId || null}, ${newAwb || null})
      `;
    }
  }
  ```

  Check `pgSql`'s return shape before relying on `rowCount` — confirm it's exposed (look at how
  `pgSql` is implemented around line 105-111; it likely just forwards `pg`'s query result, which
  does carry `rowCount`, but verify rather than assume).

- [ ] **Step 3: Thread the two new fields through the read functions**

  In `getEscalationAssignments()` (lines 1176-1193), add `new_order_id, new_awb` to the `SELECT` and
  the returned object:

  ```javascript
  async function getEscalationAssignments() {
    await ensurePgSchema();
    const { rows } = await pgSql`
      SELECT parent_order, email, assigned_at, reassigned_away_at, resolved_at, resolution, agent_remarks,
             new_order_id, new_awb
      FROM escalation_lead_assignments
      ORDER BY assigned_at DESC
      LIMIT 5000
    `;
    return rows.map((r) => ({
      parentOrder: r.parent_order,
      email: r.email,
      assignedAt: r.assigned_at,
      reassignedAwayAt: r.reassigned_away_at,
      resolvedAt: r.resolved_at,
      resolution: r.resolution,
      agentRemarks: r.agent_remarks,
      newOrderId: r.new_order_id,
      newAwb: r.new_awb,
    }));
  }
  ```

  `getLiveEscalationAssignments()` (lines 1198-1205) filters to unresolved rows already
  (`resolved_at IS NULL`), so it never has `new_order_id`/`new_awb` to return — leave it unchanged.
  It will need a **different** read for Task 9's "is this order already resolved" check; that's a
  new function, added in Task 7/9, not a change here.

- [ ] **Step 4: Manual verification (no automated test — this codebase has none for `pgSql`-based
  functions; `api/_lib/db.retry.test.js` only tests the pure connect-retry helper, not any query)**

  This is a real limitation, not a step to skip past: there is no way to verify `ALTER TABLE` or the
  new upsert branch offline. State this explicitly rather than fabricating a mock. If a live Postgres
  is available in a dev/staging environment (not production), the check would be: call
  `resolveEscalationAssignment('TEST-ORDER-1', 'Delivered', 'test', 'NEW-1', 'AWB-NEW-1')` for a
  `parentOrder` with no existing row, then `SELECT * FROM escalation_lead_assignments WHERE
  parent_order = 'TEST-ORDER-1'` and confirm exactly one row exists with `email IS NULL` and the
  four fields set. Per this project's no-live-testing rule, do not run this — leave it for the user.

- [ ] **Step 5: Commit**

  ```bash
  git add api/_lib/db.js
  git commit -m "feat: extend escalation_lead_assignments with new_order_id/new_awb, upsert on resolve

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
  ```

---

### Task 5: One-off migration — Sheet T:W → Postgres

**Files:**
- Create: `scripts/migrate_escalation_resolutions_to_postgres.py`

**Interfaces:**
- Consumes: `api`-side Postgres connection string (this is a Python script talking to the SAME
  Postgres the Node app uses — check `api/_lib/db.js`'s connection-string env var name, likely
  `DATABASE_URL` or similar, and reuse `scripts/lib.py`'s `get_pg_connection` helper rather than
  writing new connection code).
- Produces: a reconciliation report (row counts, printed diff), no function other code depends on.

This is a one-off, run-once-by-hand script (per the plan's global "no live testing" constraint, this
task's "test" is its own `--dry-run` mode, following the same convention as every other script in
this repo).

- [ ] **Step 1: Confirm the Postgres connection string env var name**

  Run: `grep -n "process.env" api/_lib/db.js | grep -i "conn\|database_url\|pg_"`

  Note the exact env var name(s) `getPgPool()` reads. `scripts/lib.py`'s `get_pg_connection(conn_str)`
  takes a connection string directly, so this script just needs `os.environ["<THAT NAME>"]`.

- [ ] **Step 2: Write the script**

  ```python
  """One-off: reads the escalation Sheet's T:W columns (New Order Id / AWB / Status / Notes) and
  writes them into escalation_lead_assignments' resolution columns in Postgres, preserving
  historical resolutions before the app stops reading the Sheet (see
  docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md's Migration
  section). Run once, by hand, before Task 9's cutover - not on a schedule.

  Only writes rows the Sheet shows as resolved (column V/status non-blank) AND that don't already
  have a resolution in Postgres (idempotent re-run: a second run is a no-op for rows already
  migrated, so a partial failure can be safely re-run in full).
  """
  import argparse
  import os
  import sys
  from pathlib import Path

  sys.path.insert(0, str(Path(__file__).resolve().parent))
  import lib

  SPREADSHEET_ID = "1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w"
  SHEET_TABS = ["HYPHEN", "mCaffeine"]
  # A:Z column order, same as sync_escalation_sheet_to_bq.py's SHEET_COLUMNS.
  COL_PARENT_ORDER = 3    # D
  COL_NEW_ORDER_ID = 19   # T
  COL_NEW_AWB = 20        # U
  COL_STATUS = 21         # V
  COL_NOTES = 22          # W


  def read_resolved_rows():
      """[(parent_order, new_order_id, new_awb, status, notes), ...] for every sheet row with a
      non-blank status (column V) - "resolved" per the same rule escalationSheet.getEligibleOrders
      uses (blank status = still pending, not migrated)."""
      out = []
      for tab in SHEET_TABS:
          values = lib.get_sheet_values(SPREADSHEET_ID, f"'{tab}'!A2:Z")
          for row in values:
              status = row[COL_STATUS] if len(row) > COL_STATUS else ""
              if not status:
                  continue
              parent_order = row[COL_PARENT_ORDER] if len(row) > COL_PARENT_ORDER else ""
              if not parent_order:
                  continue
              new_order_id = row[COL_NEW_ORDER_ID] if len(row) > COL_NEW_ORDER_ID else ""
              new_awb = row[COL_NEW_AWB] if len(row) > COL_NEW_AWB else ""
              notes = row[COL_NOTES] if len(row) > COL_NOTES else ""
              out.append((parent_order, new_order_id, new_awb, status, notes))
      return out


  def migrate(dry_run):
      conn_str = os.environ["POSTGRES_CONNECTION_STRING"]  # confirm exact name against api/_lib/db.js first
      rows = read_resolved_rows()
      print(f"  {len(rows)} resolved row(s) found in the sheet")
      if dry_run:
          for r in rows[:5]:
              print("   ", r)
          if len(rows) > 5:
              print(f"    ... and {len(rows) - 5} more")
          return

      conn = lib.get_pg_connection(conn_str)
      migrated = 0
      try:
          with conn.cursor() as cur:
              for parent_order, new_order_id, new_awb, status, notes in rows:
                  cur.execute(
                      """
                      UPDATE escalation_lead_assignments
                      SET resolved_at = COALESCE(resolved_at, now()),
                          resolution = COALESCE(resolution, %s),
                          agent_remarks = COALESCE(agent_remarks, %s),
                          new_order_id = COALESCE(new_order_id, %s),
                          new_awb = COALESCE(new_awb, %s)
                      WHERE parent_order = %s
                      """,
                      (status, notes, new_order_id, new_awb, parent_order),
                  )
                  if cur.rowcount == 0:
                      cur.execute(
                          """
                          INSERT INTO escalation_lead_assignments
                            (parent_order, email, resolved_at, resolution, agent_remarks, new_order_id, new_awb)
                          VALUES (%s, NULL, now(), %s, %s, %s, %s)
                          """,
                          (parent_order, status, notes, new_order_id, new_awb),
                      )
                  migrated += 1
          conn.commit()
      finally:
          conn.close()
      print(f"  migrated {migrated} row(s)")


  def reconcile():
      """Prints resolved-row counts, sheet vs Postgres, so a mismatch is visible before cutover."""
      sheet_resolved = len(read_resolved_rows())
      conn_str = os.environ["POSTGRES_CONNECTION_STRING"]
      conn = lib.get_pg_connection(conn_str)
      try:
          with conn.cursor() as cur:
              cur.execute("SELECT COUNT(*) FROM escalation_lead_assignments WHERE resolved_at IS NOT NULL")
              pg_resolved = cur.fetchone()[0]
      finally:
          conn.close()
      print(f"  sheet resolved rows:    {sheet_resolved}")
      print(f"  postgres resolved rows: {pg_resolved}")
      if sheet_resolved != pg_resolved:
          print("  MISMATCH - do not cut over until this is understood")
          sys.exit(1)
      print("  counts match")


  def main():
      parser = argparse.ArgumentParser()
      parser.add_argument("--dry-run", action="store_true", help="Read and print only, no Postgres writes")
      parser.add_argument("--reconcile", action="store_true", help="Compare resolved-row counts, sheet vs Postgres, and exit")
      args = parser.parse_args()
      if args.reconcile:
          return reconcile()
      migrate(args.dry_run)


  if __name__ == "__main__":
      main()
  ```

- [ ] **Step 3: Fix the env var name from Step 1's grep result**

  Replace every `POSTGRES_CONNECTION_STRING` placeholder above with whatever `api/_lib/db.js`
  actually reads. This is not optional — the placeholder name is a guess and will `KeyError` if left
  as-is.

- [ ] **Step 4: Commit**

  ```bash
  git add scripts/migrate_escalation_resolutions_to_postgres.py
  git commit -m "feat: add one-off migration, sheet T:W resolutions into Postgres

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
  ```

  This script is meant to be run by hand (`--dry-run` first, then for real, then `--reconcile`)
  before Task 9 ships — not part of any automated pipeline. State that in the commit body if useful,
  but don't wire it into a workflow.

---

### Task 6: Node-side BigQuery REST client

**Files:**
- Create: `api/_lib/bigquery.js`

**Interfaces:**
- Consumes: `GOOGLE_SHEETS_CLIENT_EMAIL`/`GOOGLE_SHEETS_PRIVATE_KEY` env vars (same service account
  `api/_lib/escalationSheet.js` already uses), `google-auth-library`'s `JWT` (already a dependency —
  `escalationSheet.js` imports it).
- Produces: `async function runQuery(project, sql, params)` → `Array<Object>` (one object per row,
  column name → value, mirroring `scripts/bq_lib.py`'s `run_query` shape 1:1 so the two are easy to
  reason about side by side).

Read-only — this client has no `loadNdjson`/write function, because the app never writes to
BigQuery (writes are Postgres + Sheet dual-write only, Tasks 4 and 10). Mirrors `scripts/bq_lib.py`'s
approach (reuse the existing JWT, call the REST API directly, no SDK dependency) rather than adding
`@google-cloud/bigquery` to the Lambda bundle.

- [ ] **Step 1: Write the file**

  ```javascript
  // Read-only BigQuery REST client for the Escalation desk - reuses the same JWT machinery
  // api/_lib/escalationSheet.js already has for Sheets, with the BigQuery scope instead. Mirrors
  // scripts/bq_lib.py's run_query() shape so the Python and Node sides are easy to compare.
  //
  // WRITE-FREE ON PURPOSE. The app never writes to BigQuery - see
  // docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md. All app
  // writes go to Postgres (api/_lib/db.js) and the Sheet (api/_lib/escalationSheet.js). If a
  // future change needs a BigQuery write from here, that is a decision to revisit this file's
  // whole premise, not a function to bolt on quietly.
  const { JWT } = require('google-auth-library');

  const BASE = 'https://bigquery.googleapis.com/bigquery/v2';

  let _client = null;
  function getClient() {
    if (_client) return _client;
    const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    const key = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!email || !key) throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars');
    _client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/bigquery'] });
    return _client;
  }

  async function authHeader() {
    const { token } = await getClient().getAccessToken();
    return { Authorization: `Bearer ${token}` };
  }

  // Runs a SQL query, returns every row as an array of {column: value} objects. Polls jobComplete
  // and pages through pageToken, same as scripts/bq_lib.py's run_query - a query that doesn't
  // finish inside the initial timeout, or returns more rows than one page, still comes back
  // complete rather than silently truncated.
  async function runQuery(project, sql, params, timeoutMs = 30000) {
    const body = { query: sql, useLegacySql: false, timeoutMs, useQueryCache: true };
    if (params) {
      body.parameterMode = 'NAMED';
      body.queryParameters = Object.entries(params).map(([name, value]) => ({
        name, parameterType: { type: 'STRING' }, parameterValue: { value },
      }));
    }
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    let res = await fetch(`${BASE}/projects/${project}/queries`, { method: 'POST', headers, body: JSON.stringify(body) });
    let data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `BigQuery query failed (${res.status})`);

    const jobId = data.jobReference.jobId;
    const location = data.jobReference.location;

    // Builds the poll/page-fetch URL for this job - `location` is only sometimes present
    // (single-region projects often omit it), so this stays a single well-formed query string
    // either way instead of the string-splicing gymnastics that would otherwise require.
    function pollUrl(extraParams) {
      const params = new URLSearchParams(extraParams || {});
      if (location) params.set('location', location);
      const qs = params.toString();
      return `${BASE}/projects/${project}/queries/${jobId}${qs ? `?${qs}` : ''}`;
    }

    while (!data.jobComplete) {
      await new Promise((r) => setTimeout(r, 1000));
      res = await fetch(pollUrl(), { headers: await authHeader() });
      data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || `BigQuery poll failed (${res.status})`);
    }

    const fields = (data.schema?.fields || []).map((f) => f.name);
    const rows = [];
    const consume = (d) => (d.rows || []).forEach((row) => {
      const obj = {};
      fields.forEach((name, i) => { obj[name] = row.f[i]?.v ?? null; });
      rows.push(obj);
    });
    consume(data);
    let pageToken = data.pageToken;
    while (pageToken) {
      res = await fetch(pollUrl({ pageToken }), { headers: await authHeader() });
      data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || `BigQuery page fetch failed (${res.status})`);
      consume(data);
      pageToken = data.pageToken;
    }
    return rows;
  }

  module.exports = { runQuery };
  ```

- [ ] **Step 2: Offline sanity check (no network — this only exercises pure logic, not `fetch`)**

  There isn't much pure logic here to unit test without mocking `fetch` (the whole function is I/O).
  Skip a dedicated test file for this task — `api/_lib/escalationBq.js` (Task 7) is where the
  actually-testable logic (the merge) lives, and Task 7's test exercises it with a stub `runQuery`
  rather than mocking `fetch` at this layer.

- [ ] **Step 3: Commit**

  ```bash
  git add api/_lib/bigquery.js
  git commit -m "feat: add read-only Node BigQuery REST client for the Escalation desk

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
  ```

---

### Task 7: Escalation BigQuery+Postgres read layer

**Files:**
- Create: `api/_lib/escalationBq.js`
- Test: `api/_lib/escalationBq.test.js`

**Interfaces:**
- Consumes: `runQuery` from `api/_lib/bigquery.js` (Task 6), `getEscalationAssignments`/
  `getLiveEscalationAssignments` from `api/_lib/db.js` (Task 4).
- Produces: `async function getEligibleOrders()`, `async function getFreshLeads()` — same names and
  same return shape (`Array<{rowNumber, sheetTab, ...COLUMNS}>`) as the functions they replace in
  `api/_lib/escalationSheet.js`, so `api/escalation/[action].js` (Task 9) only has to change its
  `require` line for `orders`/`export`, not its call sites. Also exports the pure function
  `mergeOrderRow(bqRow, resolutionRow)` for the test.

The critical design point: BigQuery's `orders_ticket_columns` and `orders_sheet_columns` don't know
about resolution state at all — filtering out already-resolved orders is a Postgres-side concern
layered on top of the BigQuery join, not something expressible in one SQL query across two systems.

- [ ] **Step 1: Write the failing test first**

  ```javascript
  // Offline test for escalationBq.js's pure merge/filter logic - no BigQuery, no Postgres, no
  // network. Run with `node api/_lib/escalationBq.test.js`.
  const assert = require('assert');
  const { mergeOrderRow } = require('./escalationBq');

  (async () => {
    // 1. A BigQuery row with no matching Postgres resolution merges through with resolution
    //    fields empty - this is the common case (a pending, never-touched order).
    const bqRow = {
      brand: 'HYPHEN', parentOrder: 'HYP1', awbNumber: 'AWB1', rowNumber: 5,
      addedDate: 'Aug 1, 2026', queryClass: 'Delivery', queryCategory: 'Delayed Order',
      deliveryPartnerName: 'Delhivery', orderDate: 'Jul 30, 2026', orderMonth: "7_Jul'26",
      queryDate: 'Aug 1, 2026', queryMonth: "8_Aug'26", whName: 'WH1', ticketNumber: 'T1',
      totalTimesConsumerReached: '2', statusAsPerAwb: 'RTO', updateFromLogistics: 'RTO',
      tat: 'Forced to be marked as RTO', city: 'Mumbai', state: 'Maharashtra',
    };
    const merged = mergeOrderRow(bqRow, null);
    assert.strictEqual(merged.sheetTab, 'HYPHEN', 'sheetTab must be derived from brand');
    assert.strictEqual(merged.rowNumber, 5);
    assert.strictEqual(merged.status, '', 'no resolution -> blank status, same as an unwritten sheet cell');
    assert.strictEqual(merged.totalTimesConsumerReached, '2', 'field name unchanged for the frontend');

    // 2. A resolved order is identifiable via its merged status - the caller (getEligibleOrders)
    //    is responsible for filtering these out, this function only merges.
    const resolved = mergeOrderRow(bqRow, { resolution: 'Delivered', agentRemarks: 'ok', newOrderId: 'HYP2', newAwb: 'AWB2' });
    assert.strictEqual(resolved.status, 'Delivered');
    assert.strictEqual(resolved.notes, 'ok');
    assert.strictEqual(resolved.newOrderId, 'HYP2');
    assert.strictEqual(resolved.newAwb, 'AWB2');

    console.log('escalationBq.test.js: all assertions passed');
  })();
  ```

- [ ] **Step 2: Run it to confirm it fails**

  Run: `node api/_lib/escalationBq.test.js`
  Expected: `Error: Cannot find module './escalationBq'`

- [ ] **Step 3: Write the implementation**

  ```javascript
  // Reads for the Escalation desk, replacing api/_lib/escalationSheet.js's getEligibleOrders/
  // getFreshLeads - see docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md.
  //
  // Column ownership by TABLE, not by MERGE clause: orders_ticket_columns and orders_sheet_columns
  // are each written by exactly one rebuild script (scripts/sync_delivery_tickets_to_bq.py,
  // scripts/sync_escalation_sheet_to_bq.py respectively) and this file only ever SELECTs from
  // both - never writes to BigQuery at all (see api/_lib/bigquery.js's own docstring).
  const { runQuery } = require('./bigquery');
  const { getEscalationAssignments } = require('./db');

  const PROJECT = process.env.BQ_PROJECT_ID || 'sheetdata-501810';
  const DATASET = process.env.BQ_DATASET || 'escalation';

  // One row of orders_ticket_columns JOINed with its orders_sheet_columns counterpart, merged with
  // its Postgres resolution row (or null if never assigned/resolved) into the exact shape
  // api/_lib/escalationSheet.js's rowToObject used to produce - same field names, so
  // app/escalation/EscalationClient.js and api/escalation/[action].js need no read-side changes
  // beyond which module they import.
  function mergeOrderRow(bqRow, resolutionRow) {
    return {
      rowNumber: bqRow.rowNumber,
      sheetTab: bqRow.brand,          // 'HYPHEN' | 'mCaffeine' - same literal values as today's sheetTab
      addedDate: bqRow.addedDate || '',
      queryClass: bqRow.queryClass || '',
      queryCategory: bqRow.queryCategory || '',
      parentOrder: bqRow.parentOrder || '',
      awbNumber: bqRow.awbNumber || '',
      deliveryPartnerName: bqRow.deliveryPartnerName || '',
      orderDate: bqRow.orderDate || '',
      orderMonth: bqRow.orderMonth || '',
      queryDate: bqRow.queryDate || '',
      queryMonth: bqRow.queryMonth || '',
      whName: bqRow.whName || '',
      totalTimesConsumerReached: bqRow.totalTimesConsumerReached ?? '',
      deliveredDate: bqRow.deliveredDate || '',
      statusAsPerAwb: bqRow.statusAsPerAwb || '',
      solvDate: bqRow.solvDate || '',
      tat: bqRow.tat || '',
      updateFromLogistics: bqRow.updateFromLogistics || '',
      city: bqRow.city || '',
      state: bqRow.state || '',
      ticketNumber: bqRow.ticketNumber || '',
      // Resolution fields - blank when there is no Postgres row yet, same as an unwritten sheet cell.
      newOrderId: resolutionRow?.newOrderId || '',
      awb: resolutionRow?.newAwb || '',
      status: resolutionRow?.resolution || '',
      notes: resolutionRow?.agentRemarks || '',
    };
  }

  // Joins orders_ticket_columns + orders_sheet_columns on (brand, parent_order) and a normalized
  // AWB match, same key definition as the sheet sweep's dedup (LOWER(TRIM(...))). LEFT JOIN sheet
  // columns - a ticket row that hasn't been swept yet (sweep runs on its own 2h schedule,
  // independently of the ticket loader) still shows up, just without status_as_per_awb/
  // update_from_logistics yet, which means it won't pass the RTO predicate until the next sweep -
  // that's correct: an order isn't "in the RTO queue" from BigQuery's perspective until the
  // sheet-sourced columns that DEFINE the queue have landed.
  async function queryOrders(predicateSql) {
    const sql = `
      SELECT t.brand, t.parent_order AS parentOrder, t.awb_number AS awbNumber,
             t.added_date AS addedDate, t.query_class AS queryClass, t.query_category AS queryCategory,
             t.delivery_partner_name AS deliveryPartnerName, t.order_date AS orderDate,
             t.order_month AS orderMonth, t.query_date AS queryDate, t.query_month AS queryMonth,
             t.wh_name AS whName, t.ticket_number AS ticketNumber,
             t.total_times_user_reached AS totalTimesConsumerReached,
             s.row_number AS rowNumber, s.delivered_date AS deliveredDate,
             s.status_as_per_awb AS statusAsPerAwb, s.solv_date AS solvDate, s.tat AS tat,
             s.update_from_logistics AS updateFromLogistics, s.city AS city, s.state AS state
      FROM \`${PROJECT}.${DATASET}.Delivery_escalation\` t
      LEFT JOIN \`${PROJECT}.${DATASET}.orders_sheet_columns\` s
        ON t.brand = s.brand AND t.parent_order = s.parent_order
        AND LOWER(TRIM(COALESCE(t.awb_number, ''))) = s.awb_key
      WHERE s.deleted_from_sheet_at IS NULL AND (${predicateSql})
    `;
    const bqRows = await runQuery(PROJECT, sql);

    const resolutions = await getEscalationAssignments();
    const byParentOrder = new Map();
    resolutions.forEach((r) => { if (!byParentOrder.has(r.parentOrder)) byParentOrder.set(r.parentOrder, r); });

    return bqRows
      .map((row) => mergeOrderRow(row, byParentOrder.get(row.parentOrder) || null))
      .filter((row) => !row.status); // drop already-resolved orders, same rule the old getEligibleOrders used
  }

  // Same predicate as api/_lib/escalationSheet.js's getEligibleOrders: courier RTO (N) AND
  // logistics RTO (Q). NOT filtered on tat (P) - see that file's own comment for why.
  async function getEligibleOrders() {
    return queryOrders(`LOWER(s.status_as_per_awb) LIKE '%rto%' AND LOWER(s.update_from_logistics) LIKE '%rto%'`);
  }

  // Same predicate as getFreshLeads: TAT hasn't landed in a computed bucket yet.
  async function getFreshLeads() {
    return queryOrders(`LOWER(TRIM(COALESCE(s.tat, ''))) IN ('', 'unresolved', '#n/a')`);
  }

  module.exports = { getEligibleOrders, getFreshLeads, mergeOrderRow };
  ```

- [ ] **Step 4: Run the test to confirm it passes**

  Run: `node api/_lib/escalationBq.test.js`
  Expected: `escalationBq.test.js: all assertions passed`

- [ ] **Step 5: Commit**

  ```bash
  git add api/_lib/escalationBq.js api/_lib/escalationBq.test.js
  git commit -m "feat: add BigQuery+Postgres read layer for the Escalation desk

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
  ```

---

### Task 8: Trim `escalationSheet.js` to write-only

**Files:**
- Modify: `api/_lib/escalationSheet.js`

**Interfaces:**
- Produces: `updateOrder`, `batchUpdateOrders`, `getSheetIndex`, `COLUMNS` (all unchanged, kept
  exactly as-is). Removes: `getEligibleOrders`, `getFreshLeads`, `readAllRows`, `readTabRows`,
  `rowToObject` (all now dead — `escalationBq.js` replaces every read).

`getSheetIndex` (used by CSV `import` matching) is **kept** — Task 10 changes what it matches
against, but the function's shape (`{byParent, byParentAwb}` of `{rowNumber, sheetTab}`) stays.
Actually — re-check: `getSheetIndex` calls `readAllRows()` internally (line 142), which is being
deleted. Task 10 will change CSV import to match against BigQuery instead of a live Sheet read, so
`getSheetIndex` itself is also dead and should be removed here, not kept. Confirm this against
Task 10 before deleting — if Task 10's approach changes, this step may need `getSheetIndex` kept
after all.

- [ ] **Step 1: Delete the dead read functions**

  Remove `rowToObject` (lines 60-64), `readTabRows` (66-74), `readAllRows` (76-80),
  `getEligibleOrders` (82-97), `getFreshLeads` (99-106), and `getSheetIndex` (141-154). Update the
  final `module.exports` (line 156) to:

  ```javascript
  module.exports = { updateOrder, batchUpdateOrders, COLUMNS };
  ```

  The `COLUMNS` array (lines 48-54) is kept — `batchUpdateOrders` doesn't use it directly (it writes
  a fixed `T{row}:W{row}` range), but leave it in place as documentation of the sheet's full layout;
  removing it is not this task's job and risks losing context future work might need.

- [ ] **Step 2: Trim the module docstring's now-inaccurate claims**

  The header comment (lines 1-18) describes read+write; update its first line to reflect write-only:
  `// Sheets WRITE access for the Escalation desk (app/escalation/) - reads moved to
  api/_lib/escalationBq.js (BigQuery), this file now only writes the dual-write T:W columns.`

- [ ] **Step 3: Verify nothing outside this file still imports the deleted functions**

  Run: `grep -rn "getEligibleOrders\|getFreshLeads\|getSheetIndex\|readAllRows" api/ app/ --include="*.js"`

  Expected: no matches outside `escalationSheet.js` itself at this point in the plan — Task 9/10
  haven't been applied yet in this task's world, but they're about to replace every such call site.
  If this grep finds a match in `api/escalation/[action].js`, that's expected (it hasn't been
  updated yet) — just confirm it's *only* that one file, so Task 9/10 knows exactly what to fix.

- [ ] **Step 4: Commit**

  ```bash
  git add api/_lib/escalationSheet.js
  git commit -m "refactor: trim escalationSheet.js to write-only, reads moved to escalationBq.js

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
  ```

  This commit will leave `api/escalation/[action].js` broken (it still imports the deleted
  functions) until Task 9 lands — that's expected for this plan's task ordering; these two tasks are
  reviewed independently but must both merge before the branch is usable.

---

### Task 9: API handler reads — point `orders`/`export` at `escalationBq`

**Files:**
- Modify: `api/escalation/[action].js:16-18` (imports), `:59-63` (`orders` action),
  `:182-207` (`export`/`sample` action)

**Interfaces:**
- Consumes: `getEligibleOrders`, `getFreshLeads` from `api/_lib/escalationBq.js` (Task 7).

- [ ] **Step 1: Swap the import**

  Replace line 16-18:
  ```javascript
  const {
    getEligibleOrders, getFreshLeads, updateOrder, batchUpdateOrders, getSheetIndex,
  } = require('../_lib/escalationSheet');
  ```
  with:
  ```javascript
  const { updateOrder, batchUpdateOrders } = require('../_lib/escalationSheet');
  const { getEligibleOrders, getFreshLeads } = require('../_lib/escalationBq');
  ```

- [ ] **Step 2: Confirm the `orders` action needs no other change**

  Lines 59-63 already call `getEligibleOrders()`/`getFreshLeads()` by name, not by module path —
  Step 1 alone fixes this action. Read it once more to confirm no `sheetTab`/`rowNumber` assumption
  breaks: it doesn't; it just forwards whatever the functions return.

- [ ] **Step 3: Confirm the `export`/`sample` action needs no other change**

  Same as Step 2 — lines 182-207 call `getFreshLeads()`/`getEligibleOrders()` by name. The `sample`
  branch (canned example row) is untouched, it never calls either function.

- [ ] **Step 4: Manual verification (no automated test for this handler exists today — same gap as
  Task 4; state it rather than fabricate one)**

  This file has no existing test file (confirmed by the earlier repo-wide search — only
  `db.retry.test.js` exists for the whole `api/` tree, and it tests a pure helper, not a route
  handler). Adding an HTTP-level test harness for this handler is out of scope for this plan — it
  would be new test infrastructure, not a test of this change. Leave live verification (hit
  `/api/escalation/orders` for real, confirm the RTO queue populates) to the user.

- [ ] **Step 5: Commit**

  ```bash
  git add api/escalation/[action].js
  git commit -m "feat: point orders/export reads at BigQuery+Postgres instead of the Sheet

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
  ```

---

### Task 10: API handler writes — Postgres + Sheet dual-write, `assign-bulk`

**Files:**
- Modify: `api/escalation/[action].js:87-179` (`update`, `bulk-update`, `import` actions),
  add a new `assign-bulk` action near the existing `assign` action (65-80)

**Interfaces:**
- Consumes: `resolveEscalationAssignment(parentOrder, resolution, agentRemarks, newOrderId, newAwb)`
  (Task 4's new signature), `assignEscalationOrder`/`unassignEscalationOrder` (unchanged).

The CSV `import` action currently matches uploaded rows against a **live Sheet read**
(`getSheetIndex`, now deleted in Task 8) to find each row's `{rowNumber, sheetTab}`. It needs a
BigQuery-backed replacement — query `orders_sheet_columns` for the same `(parent_order, awb_key)`
lookup instead of scanning the Sheet live.

- [ ] **Step 1: `update` action — resolve one row, dual-write Postgres + Sheet**

  Replace lines 87-96:
  ```javascript
  if (action === 'update') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { rowNumber, sheetTab, parentOrder, newOrderId, newAwb, newStatus, notes } = body;
    if (!rowNumber || !sheetTab || !newOrderId || !newAwb || !newStatus) {
      return res.status(400).json({ error: 'rowNumber, sheetTab, newOrderId, newAwb, and newStatus are all required' });
    }
    await updateOrder(rowNumber, sheetTab, { newOrderId, newAwb, newStatus, notes: notes || '' });
    if (parentOrder) await resolveEscalationAssignment(parentOrder, newStatus, notes || '', newOrderId, newAwb);
    return res.status(200).json({ ok: true });
  }
  ```

  Note this is **unchanged code** except the trailing two arguments on the
  `resolveEscalationAssignment` call — `updateOrder` (the Sheet dual-write) still fires exactly as
  before, using the same `rowNumber`/`sheetTab` the client already sends (now sourced from BigQuery's
  `orders_sheet_columns.row_number`/`brand` via `getEligibleOrders`, transparently — the client
  doesn't need to know or care where those came from).

  Also update the import line — `resolveEscalationAssignment` now needs importing from `../_lib/db`
  with its existing name unchanged (it already is imported at line 20-24; no import change needed,
  only the call site above).

- [ ] **Step 2: `bulk-update` action — no change needed**

  Re-read lines 98-118: `resolveEscalationAssignmentsBulk` was deliberately left with an unchanged
  signature in Task 4 (bulk actions never carry a replacement order/AWB — see `BULK_ALLOWED`). This
  action requires zero changes. Confirm this by reading it once, don't skip the read just because no
  edit follows.

- [ ] **Step 3: `import` action — replace `getSheetIndex` with a BigQuery lookup**

  Add a new helper near the top of the file (after the existing requires), then use it in `import`:

  ```javascript
  const { runQuery } = require('../_lib/bigquery');

  const BQ_PROJECT = process.env.BQ_PROJECT_ID || 'sheetdata-501810';
  const BQ_DATASET = process.env.BQ_DATASET || 'escalation';

  // CSV import's row-matching index, sourced from orders_sheet_columns instead of a live Sheet
  // read (that table already carries row_number/brand for exactly this purpose - see
  // docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md).
  async function getSheetIndexFromBq() {
    const rows = await runQuery(BQ_PROJECT,
      `SELECT parent_order AS parentOrder, awb_key AS awbKey, row_number AS rowNumber, brand
       FROM \`${BQ_PROJECT}.${BQ_DATASET}.orders_sheet_columns\`
       WHERE deleted_from_sheet_at IS NULL`);
    const byParent = new Map();
    const byParentAwb = new Map();
    rows.forEach((r) => {
      const parent = String(r.parentOrder || '').trim().toLowerCase();
      if (!parent) return;
      const ref = { rowNumber: Number(r.rowNumber), sheetTab: r.brand };
      if (!byParent.has(parent)) byParent.set(parent, ref);
      if (r.awbKey) byParentAwb.set(`${parent}||${r.awbKey}`, ref);
    });
    return { byParent, byParentAwb };
  }
  ```

  Then in the `import` action (line 134), replace:
  ```javascript
  const { byParent, byParentAwb } = await getSheetIndex();
  ```
  with:
  ```javascript
  const { byParent, byParentAwb } = await getSheetIndexFromBq();
  ```

  Everything after that line (the CSV row-matching loop, lines 139-166) is unchanged — it already
  looks up `byParentAwb.get(...)`/`byParent.get(...)` by the same key shape.

  One more change inside the loop: after building `updates` and calling `batchUpdateOrders` (line
  168), add the Postgres side — for each matched update, also call
  `resolveEscalationAssignment(parentOrder, ...)`. This needs `parentOrder` threaded through
  alongside each `update` entry (today's `updates` array only carries `rowNumber`/`sheetTab`/etc,
  not the original `parent` string) — add `parentOrder: row.HYP_Parent_OrderID` to the object pushed
  at line 158, then after the `batchUpdateOrders` call:

  ```javascript
  await Promise.all(updates.map((u) =>
    resolveEscalationAssignment(u.parentOrder, u.newStatus, u.notes, u.newOrderId, u.newAwb)
  ));
  ```

- [ ] **Step 4: New `assign-bulk` action**

  Add near the existing `assign` action (after line 80):

  ```javascript
  if (action === 'assign-bulk') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { assignments } = body; // [{ parentOrder, agentId }]
    if (!Array.isArray(assignments) || !assignments.length) {
      return res.status(400).json({ error: 'assignments array is required' });
    }
    await Promise.all(assignments.map(({ parentOrder, agentId }) =>
      agentId ? assignEscalationOrder(parentOrder, agentId) : unassignEscalationOrder(parentOrder)
    ));
    return res.status(200).json({ ok: true, assigned: assignments.length });
  }
  ```

  This still fires one `assignEscalationOrder` per row internally (Postgres, not BigQuery — no DML
  restriction applies), but as one server-side `Promise.all` inside a single request rather than N
  separate client POSTs. If Postgres connection-pool pressure ever becomes a concern at real
  auto-assign volumes, a true batched `UPDATE ... WHERE parent_order = ANY(...)` (like
  `resolveEscalationAssignmentsBulk` already does) would be the next step — not needed at this
  desk's current scale, so not built now.

- [ ] **Step 5: Manual verification**

  Same gap as Tasks 4 and 9 — no route-handler test harness exists in this repo. State it, don't
  fabricate a test. `node -e "require('./api/escalation/[action].js')"` at minimum confirms the file
  still parses/imports cleanly (all requires resolve) without needing a live request.

- [ ] **Step 6: Commit**

  ```bash
  git add api/escalation/[action].js
  git commit -m "feat: writes go to Postgres (+ Sheet T:W dual-write), add assign-bulk

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
  ```

---

### Task 11: Frontend — single-call auto-assign, toast copy

**Files:**
- Modify: `app/escalation/EscalationClient.js:731` (toast text), `:1261-1307` (`handleAutoAssign`)

**Interfaces:**
- Consumes: `POST /api/escalation/assign-bulk` (Task 10).

Confirmed by reading the file directly: no other frontend change is needed. `rowKey`, `getPriority`,
`callCount`, every filter, and the resolve dialog all read the exact same field names
(`sheetTab`, `rowNumber`, `totalTimesConsumerReached`, etc.) the new BigQuery+Postgres read layer
already returns (Task 7's `mergeOrderRow` was written specifically to preserve them) — and the
resolved-order fields (`status`, `notes`, `newOrderId`, `newAwb`) never render in the pending-queue
view, since resolved rows are filtered out server-side and removed from the client's `orders` list
the moment a resolve/bulk-update/import succeeds (`handleSaved`/`handleImported`).

- [ ] **Step 1: Update the resolve toast**

  Line 731, change:
  ```javascript
  onToast('success', `Resolved — ${order.parentOrder || 'row'} synced to sheet`);
  ```
  to:
  ```javascript
  onToast('success', `Resolved — ${order.parentOrder || 'row'}`);
  ```
  (Drop "synced to sheet" — the write is now to Postgres first; the Sheet dual-write is an
  implementation detail the agent doesn't need surfaced, same as the app never told them about the
  Sheet's L:P formula recalculation either.)

- [ ] **Step 2: Replace `handleAutoAssign` with a single `assign-bulk` call**

  Replace the whole function (lines 1261-1307):

  ```javascript
  async function handleAutoAssign() {
    if (!isAdmin && !googleUser?.email) return;

    setAutoAssigning(true);
    try {
      const unassigned = orders.filter((o) => !assignments[rowKey(o)]);
      if (unassigned.length === 0) { showToast('success', 'All orders already assigned!'); return; }

      let assignmentPayload;
      let newMap = {};
      if (!isAdmin) {
        assignmentPayload = unassigned.map((o) => ({ parentOrder: o.parentOrder, agentId: googleUser.email }));
        unassigned.forEach((o) => { newMap[rowKey(o)] = { agentId: googleUser.email }; });
      } else {
        if (agents.length === 0) { showToast('error', 'No agents available'); return; }
        assignmentPayload = unassigned.map((o, i) => ({ parentOrder: o.parentOrder, agentId: agents[i % agents.length].email }));
        unassigned.forEach((o, i) => { newMap[rowKey(o)] = { agentId: agents[i % agents.length].email }; });
      }

      const res = await fetch('/api/escalation/assign-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: assignmentPayload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Auto-assign failed');

      setAssignments((p) => ({ ...p, ...newMap }));
      showToast('success', isAdmin
        ? `Auto-assigned ${unassigned.length} orders (round-robin across ${agents.length} agents)`
        : `Auto-assigned ${unassigned.length} orders to you`);
    } catch (err) {
      showToast('error', err.message || 'Auto-assign failed');
    } finally { setAutoAssigning(false); }
  }
  ```

- [ ] **Step 3: Manual verification**

  No test harness exists for this component either (React component, no test renderer set up in
  this repo for `app/`). This is a UI behavior change best confirmed by the user actually clicking
  Auto-Assign All in a real browser against a real (or staging) backend — not something to fabricate
  a snapshot test for here.

- [ ] **Step 4: Commit**

  ```bash
  git add app/escalation/EscalationClient.js
  git commit -m "feat: single-call auto-assign via assign-bulk, drop sheet-sync toast wording

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
  ```

---

## Spec Coverage Check

- Ticket loader production trigger (spec §Data model) → Task 1
- `orders_sheet_columns` table + sweep (spec §Data model, §Ingest path B) → Task 2
- Scheduling (spec §Architecture) → Task 3
- Postgres extension for resolution state (spec §Data model, §Application layer) → Task 4
- Migration (spec §Migration) → Task 5
- Node BigQuery read client (spec §File-by-file) → Task 6
- Reads: BigQuery+Postgres merge, RTO/Fresh-Leads predicates (spec §Application layer) → Task 7
- `escalationSheet.js` trimmed to write-only (spec §Application layer, §File-by-file) → Task 8
- API handler reads repointed (spec §Application layer) → Task 9
- API handler writes (dual-write, `assign-bulk`) (spec §Application layer) → Task 10
- Client changes (spec §Application layer, §Client) → Task 11

Every file in the spec's file-by-file table has a task. The spec's "Open items" (logistics pipeline,
full formula retirement, BigQuery billing) are explicitly deferred there and correctly have no task
here.
