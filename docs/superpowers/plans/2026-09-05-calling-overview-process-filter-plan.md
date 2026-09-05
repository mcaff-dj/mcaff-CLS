# Calling Overview Process Filter (RTO / NDR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Process filter (RTO / NDR) to the Calling Team Overview page, with NDR-side KPI tiles and Delivery Partner / NDR Reason breakdown tables backed by 4 new mirrored columns on `ndr_lead_assignments`.

**Architecture:** Mirror `delivery_partner`/`ndr_reason`/`payment_mode`/`brand` from the NDR Google Sheet into `ndr_lead_assignments` at the two existing points a lead is claimed (the interactive top-up in `api/ndr/next-lead.js` and the periodic sweep in `scripts/assign_ndr_leads.py`), backfill historical rows from the live sheets in a one-off script, then add NDR-side SQL aggregations parallel to the existing RTO ones in `api/_lib/db.js`, and a Process dropdown in `CallingOverviewClient.js` that switches which set the page renders. `connected`/`converted` need no new column — both derive from the existing `disposition` text via `LIKE`.

**Tech Stack:** Next.js/React (app/), Node.js API routes (api/), MySQL via a `sql` tagged-template helper in `api/_lib/db.js`, Python 3 scripts (scripts/) using `pymysql`/`mysql_lib`/`lib.py`'s Sheets helpers, plain `assert`-based self-checks for JS pure functions (no jest in this repo), `pytest` for Python.

**Spec:** `docs/superpowers/specs/2026-09-05-calling-overview-process-filter-design.md`

**Correction to the spec:** Section 1 says the schema change goes "in `api/_lib/db.js`'s `ensureSchema`". That's wrong — `db.js` only ever does `CREATE TABLE IF NOT EXISTS`, never `ALTER TABLE`; every column added to an existing table in this repo ships as its own one-off `scripts/migrate_*.py` (dry-run by default, `--apply` to execute — see `scripts/migrate_ndr_team_id.py`), run manually against the real database **before** the code that reads the new columns is deployed. Task 1 below follows that precedent instead.

## Global Constraints

- No new npm/pip dependencies.
- JS pure-function tests: plain `assert`, run with `node <file>.test.js` (no jest/mocha in this repo).
- Python tests: `pytest`, following the fake-pymysql-connection pattern already used in `scripts/test_assign_ndr_leads.py`.
- New/changed function signatures must stay **backward compatible** wherever an existing call site or existing test isn't being touched in the same task (see Task 3).
- Never overwrite a non-NULL value when backfilling (Task 4) — only fill gaps.
- `connected` for NDR ⇔ `LOWER(TRIM(disposition)) LIKE 'connected%'`; `converted` for NDR ⇔ `LOWER(disposition) LIKE '%new order placed%'`. Use these exact predicates everywhere connected/converted is computed for NDR in SQL.
- Every new MySQL read filters `payment_mode`/`brand` the same way the existing RTO functions do: `(${mode} IS NULL OR payment_mode = ${mode})`, `(${brandFilter} IS NULL OR brand = ${brandFilter})` (brand is a real stored column for NDR — no `IF(UPPER(order_id) LIKE 'HYP%', ...)` derivation needed, unlike RTO).

---

## Task 1: Schema migration script — add 4 columns to `ndr_lead_assignments`

**Files:**
- Create: `scripts/migrate_ndr_lead_attributes.py`

**Interfaces:**
- Produces: 4 new nullable columns on `PEP_CLS.ndr_lead_assignments` — `delivery_partner VARCHAR(64)`, `ndr_reason VARCHAR(255)`, `payment_mode VARCHAR(20)`, `brand VARCHAR(20)`. Every later task assumes these columns already exist in the target database.

- [ ] **Step 1: Write the migration script**

Follow `scripts/migrate_ndr_team_id.py` exactly (dry-run default, `--apply` flag, `_column_exists` guard so it's safe to re-run):

```python
#!/usr/bin/env python3
"""Adds PEP_CLS.ndr_lead_assignments.delivery_partner/ndr_reason/payment_mode/brand - the
lead-attribute mirror behind the Calling Team Overview's Process (RTO/NDR) filter (see
docs/superpowers/specs/2026-09-05-calling-overview-process-filter-design.md).

Why this is a script and not part of ensureSchema(): api/_lib/db.js bootstraps schema with
CREATE TABLE IF NOT EXISTS, which is inert against an existing table, and there is no ALTER
TABLE anywhere in api/. Run this BEFORE deploying the api/ and scripts/ changes that write or
read these columns (claimNdrLead, api/ndr/next-lead.js, assign_ndr_leads.py's
record_new_assignments, the backfill script, and the new NDR query functions in db.js) - a
missing column throws ER_BAD_FIELD_ERROR the first time any of them touches it.

All 4 columns start NULL and are always written together (see the claim-time mirror and the
backfill script) - a row with any one of them non-NULL has all four set, which is what lets
both that mirror and the backfill guard against overwriting real data with `WHERE
delivery_partner IS NULL`.

Dry-run by default; --apply performs the DDL. Safe to re-run: an already-applied step is
detected and skipped, matching this repo's other one-off MySQL schema scripts (see
migrate_ndr_team_id.py).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "ndr_lead_assignments"
NEW_COLUMNS = [
    ("delivery_partner", "VARCHAR(64) NULL"),
    ("ndr_reason", "VARCHAR(255) NULL"),
    ("payment_mode", "VARCHAR(20) NULL"),
    ("brand", "VARCHAR(20) NULL"),
]


def _column_exists(cur, column):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, column),
    )
    return cur.fetchone() is not None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="run the DDL (default: dry run)")
    args = ap.parse_args()

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        plan = []
        for column, ddl_type in NEW_COLUMNS:
            if _column_exists(cur, column):
                print(f"{column} already present - skipping.")
            else:
                plan.append((
                    f"add {column} column",
                    f"ALTER TABLE `{TABLE}` ADD COLUMN `{column}` {ddl_type}",
                ))

        if not plan:
            print("\nNothing to do - schema already migrated.")
            return 0

        print(f"\n{'Applying' if args.apply else 'DRY RUN - would apply'} {len(plan)} step(s):")
        for label, stmt in plan:
            print(f"  - {label}\n      {stmt}")

        if not args.apply:
            print("\nRe-run with --apply to execute.")
            return 0

        for label, stmt in plan:
            cur.execute(stmt)
            conn.commit()
            print(f"  done: {label}")

        cur.execute(f"SELECT COUNT(*) FROM `{TABLE}`")
        (total,) = cur.fetchone()
        print(f"\nDone. {TABLE} has {total} row(s); all 4 new columns start NULL.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Dry-run it locally to check for syntax errors**

Run: `python scripts/migrate_ndr_lead_attributes.py`
Expected: either "MYSQL_* credentials not configured." (no local DB configured — fine, confirms the script imports and parses cleanly) or a printed dry-run plan naming all 4 columns.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate_ndr_lead_attributes.py
git commit -m "feat(ndr-calling): add migration for delivery_partner/ndr_reason/payment_mode/brand on ndr_lead_assignments"
```

**Do not run `--apply` yourself against the real database — tell the user the script is ready and let them run it** (this repo's convention: schema DDL against prod MySQL is a human action, not something run automatically as part of this plan).

---

## Task 2: Mirror the 4 fields at claim time (JS path)

**Files:**
- Modify: `api/_lib/db.js` (`claimNdrLead`, ~L1715)
- Modify: `api/ndr/next-lead.js` (`buildCandidateList` ~L111, `COL_*` constants ~L67, the `claimNdrLead` call ~L258)
- Modify: `api/ndr/next-lead.test.js`

**Interfaces:**
- Consumes: the 4 new MySQL columns from Task 1 (must already exist against whatever database this runs against, or the `INSERT` in `claimNdrLead` throws).
- Produces: `claimNdrLead(awbNumber, email, attrs)` where `attrs` is `{ courier, reason, paymentMode, brand }` (all optional — omitting `attrs` entirely keeps the old 2-arg behavior). `buildCandidateList`'s candidate objects gain a `courier` field (string, `''` if the cell is blank).

- [ ] **Step 1: Add the courier column read to `buildCandidateList` and extend its test**

In `api/ndr/next-lead.js`, add the column constant next to the others (~L67-77):

```javascript
const COL_ORDER_ID = 0;          // A - the only source for brand (no Brand column exists)
const COL_COURIER = 5;           // F - "Courier Company" / sheet header "Partner name"
const COL_AWB = 4;               // E
```

In the same file's `buildCandidateList` (~L124-132), add `courier` to the built lead object:

```javascript
    const lead = {
      row: i + 2, // rows[] starts at sheet row 2 (A2:T...), so +2
      awb,
      attempts: cell(COL_ATTEMPTS),
      latestNdrReason: cell(COL_LATEST_NDR_REASON),
      paymentMode: cell(COL_PAYMENT_MODE),
      brand: brandOf(cell(COL_ORDER_ID)),
      courier: cell(COL_COURIER),
      sortKey: parseLatestNdrDate(cell(COL_LATEST_NDR_DATE)),
    };
```

In `api/ndr/next-lead.test.js`, extend the `row()` helper to accept and place a courier value, and add one assertion that it's captured:

```javascript
function row({ orderId = 'MC1', awb = 'AWB1', paymentMode = 'COD', attempts = '', date = '', reason = '', agent = '', connected = '', courier = '' } = {}) {
  const r = new Array(20).fill('');
  r[0] = orderId; r[4] = awb; r[5] = courier; r[11] = paymentMode; r[14] = attempts;
  r[15] = date; r[16] = reason; r[18] = agent; r[19] = connected;
  return r;
}
```

Add near the "brand comes from the Order ID prefix" block:

```javascript
// --- courier (Courier Company, column F) is carried onto the candidate -----------------------
{
  const rows = [row({ awb: 'C1', courier: 'Delhivery' })];
  const { candidates } = buildCandidateList(rows, ME, unrestricted);
  assert.strictEqual(candidates[0].courier, 'Delhivery');
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `node api/ndr/next-lead.test.js`
Expected: `api/ndr/next-lead.test.js: all assertions passed`

- [ ] **Step 3: Extend `claimNdrLead` in `api/_lib/db.js` to accept and write the 4 attributes**

Replace the current function (~L1715-1721):

```javascript
async function claimNdrLead(awbNumber, email) {
  await ensureSchema();
  await sql`
    INSERT IGNORE INTO ndr_lead_assignments (awb_number, email)
    VALUES (${awbNumber}, ${email})
```

with:

```javascript
async function claimNdrLead(awbNumber, email, attrs) {
  await ensureSchema();
  const { courier, reason, paymentMode, brand } = attrs || {};
  await sql`
    INSERT IGNORE INTO ndr_lead_assignments
      (awb_number, email, delivery_partner, ndr_reason, payment_mode, brand)
    VALUES (${awbNumber}, ${email}, ${courier || null}, ${reason || null}, ${paymentMode || null}, ${brand || null})
```

(Leave the rest of the function — the trailing `` `; invalidateCache(...); }`` — unchanged.)

- [ ] **Step 4: Pass the attributes from the one call site**

In `api/ndr/next-lead.js` (~L258), change:

```javascript
        await Promise.all(free.map((c) => claimNdrLead(c.awb, email).catch((e) => {
```

to:

```javascript
        await Promise.all(free.map((c) => claimNdrLead(c.awb, email, {
          courier: c.courier, reason: c.latestNdrReason, paymentMode: c.paymentMode, brand: c.brand,
        }).catch((e) => {
```

- [ ] **Step 5: Re-run the full next-lead test to confirm nothing broke**

Run: `node api/ndr/next-lead.test.js`
Expected: `api/ndr/next-lead.test.js: all assertions passed`

**Deliberately unchanged:** `disposeNdrLead`'s own fallback `INSERT IGNORE` (`db.js` ~L1745-1749, fired only when its `UPDATE` matches zero rows) has no sheet row in hand at dispose time, so it keeps inserting only `awb_number, email, disposed_at, disposition, agent_remarks` — the 4 new columns stay NULL there, same as any other disposal race, to be filled in later by a claim or a backfill run. Do not add them to that INSERT.

- [ ] **Step 6: Commit**

```bash
git add api/_lib/db.js api/ndr/next-lead.js api/ndr/next-lead.test.js
git commit -m "feat(ndr-calling): mirror courier/reason/payment-mode/brand at claim time"
```

---

## Task 3: Mirror the 4 fields at claim time (Python sweep path)

**Files:**
- Modify: `scripts/assign_ndr_leads.py` (`COL_*` constants, `assign_for_run`, `record_new_assignments`)

**Interfaces:**
- Consumes: same 4 MySQL columns as Task 2.
- Produces: `record_new_assignments(new_assignments)` still accepts its existing 2-tuple `(awb, email)` items **unchanged** (every existing call in `scripts/test_assign_ndr_leads.py` keeps working with zero test edits), but now also accepts a longer tuple `(awb, email, courier, reason, payment_mode, brand)` and writes those 4 extra fields when present.

- [ ] **Step 1: Add the courier column constant**

In `scripts/assign_ndr_leads.py`, next to the other `COL_*` constants (~L58-65):

```python
COL_ORDER_ID = 0             # A - source for brand_of (no dedicated Brand column exists)
COL_COURIER = 5              # F - "Courier Company" / sheet header "Partner name"
COL_AWB = 4                  # E
```

- [ ] **Step 2: Read courier in `assign_for_run` and carry it through `unassigned`/`new_assignments`**

In `assign_for_run` (~L369-388), add a courier read and append it to the tuple:

```python
    for i, row in enumerate(sheet_rows):
        agent = row[COL_AGENT].strip().lower() if len(row) > COL_AGENT and row[COL_AGENT] else ""
        if agent:
            connected = row[COL_CONNECTED].strip() if len(row) > COL_CONNECTED and row[COL_CONNECTED] else ""
            if not connected and agent in current_load:
                current_load[agent] += 1
        else:
            latest_ndr_date = parse_latest_ndr_date(row[COL_LATEST_NDR_DATE] if len(row) > COL_LATEST_NDR_DATE else "")
            bucket = attempt_bucket(row[COL_ATTEMPTS] if len(row) > COL_ATTEMPTS else "")
            reason = row[COL_LATEST_NDR_REASON] if len(row) > COL_LATEST_NDR_REASON else ""
            payment_mode = row[COL_PAYMENT_MODE] if len(row) > COL_PAYMENT_MODE else ""
            brand = brand_of(row[COL_ORDER_ID] if len(row) > COL_ORDER_ID else "")
            courier = row[COL_COURIER] if len(row) > COL_COURIER else ""
            awb = row[COL_AWB] if len(row) > COL_AWB else ""
            if awb:
                unassigned.append((i + 2, latest_ndr_date, bucket, reason, payment_mode, brand, courier, awb))
```

Update the two places that unpack `unassigned` tuples (~L427 and ~L436) to match the new 8-tuple shape (courier added second-to-last, awb still last):

```python
    supply = {email: 0 for email in online_agents}
    for _, _, bucket, reason, payment_mode, brand, _courier, _ in unassigned:
        for email in online_agents:
            if _eligible(email, bucket, reason, payment_mode, brand):
                supply[email] += 1
```

```python
    for row_num, _, bucket, reason, payment_mode, brand, courier, awb in unassigned:
```

And where the assignment is recorded (~L461):

```python
        new_assignments.append((awb, email, courier, reason, payment_mode, brand))
```

- [ ] **Step 3: Extend `record_new_assignments` to write the extra fields when present, backward-compatibly**

Replace the batch-building and insert/update logic (~L307-337). Current:

```python
    batch = list({awb: email for awb, email in new_assignments}).items())
```

(Note: the real current line is `batch = list({awb: email for awb, email in new_assignments}.items())` — replace it and the insert/update block below with:)

```python
    # Each item is (awb, email) or (awb, email, courier, reason, payment_mode, brand) - accept
    # both so every existing 2-tuple caller (scripts/test_assign_ndr_leads.py's many fakes) keeps
    # working unchanged; only assign_for_run's own new_assignments passes the longer form.
    def _unpack(item):
        awb, email, *rest = item
        courier, reason, payment_mode, brand = (list(rest) + [None, None, None, None])[:4]
        return awb, email, courier, reason, payment_mode, brand
    # Last agent wins for a repeated AWB, matching the sheet.
    by_awb = {}
    for item in new_assignments:
        awb, email, courier, reason, payment_mode, brand = _unpack(item)
        by_awb[awb] = (email, courier, reason, payment_mode, brand)
    batch = [(awb, *rest) for awb, rest in by_awb.items()]
    conn = None
    try:
        conn = pymysql.connect(
            host=cred["host"], user=cred["user"], password=cred["password"],
            database=PRESENCE_SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
        )
        cur = conn.cursor()
        cur.executemany(
            "UPDATE ndr_lead_assignments SET reassigned_away_at = %s "
            "WHERE awb_number = %s AND reassigned_away_at IS NULL",
            [(now, awb) for awb, _email, _courier, _reason, _payment_mode, _brand in batch],
        )
        for awb, email, courier, reason, payment_mode, brand in batch:
            try:
                cur.execute(
                    "INSERT INTO ndr_lead_assignments "
                    "(awb_number, email, assigned_at, delivery_partner, ndr_reason, payment_mode, brand) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (awb, email, now, courier or None, reason or None, payment_mode or None, brand or None),
                )
            except pymysql.err.IntegrityError as e:
                if "ndr_lead_assignments_live_awb_key" not in str(e):
                    raise
                cur.execute(
                    "UPDATE ndr_lead_assignments SET email = %s, assigned_at = %s, "
                    "delivery_partner = %s, ndr_reason = %s, payment_mode = %s, brand = %s "
                    "WHERE awb_number = %s AND reassigned_away_at IS NULL",
                    (email, now, courier or None, reason or None, payment_mode or None, brand or None, awb),
                )
        conn.commit()
        return True
```

(Everything above and below this block — the credential check, the `except Exception`/`finally` handling — stays exactly as it is today; only the batch-building and the body of the `try` shown above changes.)

- [ ] **Step 4: Run the existing Python test suite to confirm the 2-tuple call sites still pass unchanged**

Run: `pytest scripts/test_assign_ndr_leads.py -v`
Expected: all tests pass, including `test_record_new_assignments_dedupes_repeated_awb_in_one_batch`, `test_record_new_assignments_absorbs_live_key_collision_per_row`, and every `test_main_*`/`test_assign_for_run_*` test that calls `record_new_assignments` with plain `(awb, email)` tuples.

- [ ] **Step 5: Add one new test for the extended write**

Append to `scripts/test_assign_ndr_leads.py`:

```python
def test_record_new_assignments_writes_lead_attributes_when_given():
    ok, cursor, _fake = _run_record(
        [("AWB1", "a@x.com", "Delhivery", "Customer refused", "COD", "mCaffeine")])
    assert ok is True
    inserts = [p for sql, p in cursor.statements if "INSERT" in sql]
    assert len(inserts) == 1
    awb, email, now, courier, reason, payment_mode, brand = inserts[0]
    assert (courier, reason, payment_mode, brand) == ("Delhivery", "Customer refused", "COD", "mCaffeine")


def test_record_new_assignments_still_accepts_plain_two_tuples():
    # assign_for_run is the only real caller of the longer form; every other existing caller in
    # this test file (and any future one) must keep working with the original (awb, email) shape.
    ok, cursor, _fake = _run_record([("AWB2", "b@x.com")])
    assert ok is True
    inserts = [p for sql, p in cursor.statements if "INSERT" in sql]
    assert inserts[0][3:] == (None, None, None, None)
```

- [ ] **Step 6: Run the new tests**

Run: `pytest scripts/test_assign_ndr_leads.py -v -k "test_record_new_assignments_writes_lead_attributes_when_given or test_record_new_assignments_still_accepts_plain_two_tuples"`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/assign_ndr_leads.py scripts/test_assign_ndr_leads.py
git commit -m "feat(ndr-calling): mirror courier/reason/payment-mode/brand from the assignment sweep"
```

---

## Task 4: Backfill script for historical rows

**Files:**
- Create: `scripts/backfill_ndr_lead_attributes_from_sheet.py`
- Create: `scripts/test_backfill_ndr_lead_attributes_from_sheet.py`

**Interfaces:**
- Consumes: `assign_ndr_leads.fetch_active_ndr_teams`, `assign_ndr_leads.SPREADSHEET_ID`/`SHEET_TAB`/`PRESENCE_SCHEMA`/`brand_of`; `lib.get_sheet_values(sheet_id, range)`.
- Produces: `build_attribute_map(rows)` — pure function, `rows` (list of sheet row arrays, `A2:Q` shape) → `{awb_number: (delivery_partner, ndr_reason, payment_mode, brand)}`. Exported for the test, same convention as `next-lead.js`'s `buildCandidateList`.

- [ ] **Step 1: Write the script**

```python
#!/usr/bin/env python3
"""One-off backfill: fills PEP_CLS.ndr_lead_assignments.delivery_partner/ndr_reason/
payment_mode/brand for existing rows, read from each active NDR team's live Google Sheet (see
docs/superpowers/specs/2026-09-05-calling-overview-process-filter-design.md). Run once, after
scripts/migrate_ndr_lead_attributes.py --apply and after this repo's claim-time mirroring
(Tasks 2-3) has deployed - not a substitute for either.

Matched by awb_number, updating EVERY historical cycle for that AWB (these are lead-level
facts, not cycle-level - a lead's courier/reason/payment-mode/brand don't change across
reassignment cycles). An AWB no longer present in any active sheet is left NULL; there is
nowhere else to recover it from, and it will show as attribute-less in the Overview's
breakdown tables the same way any other "no data for this filter" row does.

COALESCE-free by construction: the UPDATE's WHERE clause requires delivery_partner IS NULL,
so a row a prior run (or the claim-time mirror) already populated is never touched again -
this is what makes it idempotent and safe to re-run against an updated sheet.

Dry-run by default; --apply performs the writes.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
from mysql_lib import get_credential
from assign_ndr_leads import fetch_active_ndr_teams, SPREADSHEET_ID, SHEET_TAB, PRESENCE_SCHEMA, brand_of

COL_ORDER_ID = 0   # A
COL_COURIER = 5    # F - "Courier Company" / sheet header "Partner name"
COL_AWB = 4        # E
COL_PAYMENT_MODE = 11  # L
COL_LATEST_NDR_REASON = 16  # Q
LAST_COL = "Q"
UPDATE_CHUNK = 200


def build_attribute_map(rows):
    """rows: sheet rows (A2:Q shape, as returned by lib.get_sheet_values) -> {awb_number:
    (delivery_partner, ndr_reason, payment_mode, brand)}. First-seen-wins per AWB, same
    convention as every other sheet-backed backfill in this repo. A row with no AWB is
    skipped - there is nothing to key it by."""
    by_awb = {}
    for row in rows:
        awb = (row[COL_AWB] if len(row) > COL_AWB else "").strip()
        if not awb or awb in by_awb:
            continue
        courier = (row[COL_COURIER] if len(row) > COL_COURIER else "").strip() or None
        reason = (row[COL_LATEST_NDR_REASON] if len(row) > COL_LATEST_NDR_REASON else "").strip() or None
        payment_mode = (row[COL_PAYMENT_MODE] if len(row) > COL_PAYMENT_MODE else "").strip() or None
        order_id = row[COL_ORDER_ID] if len(row) > COL_ORDER_ID else ""
        brand = brand_of(order_id) if order_id else None
        by_awb[awb] = (courier, reason, payment_mode, brand)
    return by_awb


def _resolve_runs():
    teams = fetch_active_ndr_teams()
    if teams is None:
        raise SystemExit("Could not determine NDR's active teams (calling_teams query failed).")
    if not teams:
        return [{"id": None, "name": "NDR", "sheet_id": SPREADSHEET_ID, "sheet_tab": SHEET_TAB}]
    return teams


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="run the writes (default: dry run)")
    args = ap.parse_args()

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql

    combined = {}
    for run in _resolve_runs():
        rows = lib.get_sheet_values(run["sheet_id"], f"'{run['sheet_tab']}'!A2:{LAST_COL}1000000")
        attrs = build_attribute_map(rows)
        print(f"[{run['name']}] {len(attrs)} AWB(s) with attributes in the live sheet.")
        combined.update(attrs)  # later teams overwrite earlier on an AWB collision - rare, harmless

    if not combined:
        print("Nothing found in any active sheet - nothing to do.")
        return 0

    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=PRESENCE_SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        cur.execute(
            f"SELECT COUNT(*) FROM ndr_lead_assignments WHERE delivery_partner IS NULL "
            f"AND awb_number IN ({','.join(['%s'] * len(combined))})",
            list(combined.keys()),
        ) if len(combined) <= 10000 else None  # skip the preview count on a huge batch
        matched = cur.fetchone()[0] if cur.rowcount != -1 and len(combined) <= 10000 else None
        if matched is not None:
            print(f"{matched} row(s) currently NULL will be updated.")

        if not args.apply:
            print("\nDRY RUN - re-run with --apply to write.")
            return 0

        rows_to_write = [
            (courier, reason, payment_mode, brand, awb)
            for awb, (courier, reason, payment_mode, brand) in combined.items()
        ]
        updated = 0
        for start in range(0, len(rows_to_write), UPDATE_CHUNK):
            chunk = rows_to_write[start:start + UPDATE_CHUNK]
            cur.executemany(
                "UPDATE ndr_lead_assignments SET delivery_partner = %s, ndr_reason = %s, "
                "payment_mode = %s, brand = %s WHERE awb_number = %s AND delivery_partner IS NULL",
                chunk,
            )
            conn.commit()
            updated += cur.rowcount
            print(f"  ...{start + len(chunk)}/{len(rows_to_write)} AWBs processed")
        print(f"\nDone. {updated} row(s) updated.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Write the failing test first**

```python
"""Self-check for build_attribute_map (scripts/backfill_ndr_lead_attributes_from_sheet.py) -
pure, no sheet, no DB. Run with `pytest scripts/test_backfill_ndr_lead_attributes_from_sheet.py -v`."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backfill_ndr_lead_attributes_from_sheet import build_attribute_map


def _row(order_id="MC1", awb="AWB1", courier="", payment_mode="", reason=""):
    r = [""] * 17
    r[0] = order_id
    r[4] = awb
    r[5] = courier
    r[11] = payment_mode
    r[16] = reason
    return r


def test_build_attribute_map_captures_all_four_fields():
    rows = [_row(order_id="HYP900", awb="A1", courier="Delhivery", payment_mode="COD", reason="Customer refused")]
    result = build_attribute_map(rows)
    assert result == {"A1": ("Delhivery", "Customer refused", "COD", "Hyphen")}


def test_build_attribute_map_skips_rows_with_no_awb():
    rows = [_row(awb=""), _row(awb="  "), _row(awb="A1")]
    result = build_attribute_map(rows)
    assert list(result.keys()) == ["A1"]


def test_build_attribute_map_first_seen_wins_for_a_repeated_awb():
    rows = [_row(awb="A1", courier="Delhivery"), _row(awb="A1", courier="Bluedart")]
    result = build_attribute_map(rows)
    assert result["A1"][0] == "Delhivery"


def test_build_attribute_map_blank_cells_become_none():
    rows = [_row(awb="A1", courier="", payment_mode="", reason="")]
    result = build_attribute_map(rows)
    courier, reason, payment_mode, brand = result["A1"]
    assert (courier, reason, payment_mode) == (None, None, None)
    assert brand == "mCaffeine"  # order_id "MC1" -> brand_of still runs, just doesn't start with HYP
```

- [ ] **Step 3: Run it to verify it fails (module doesn't exist yet if written out of order — otherwise skip straight to Step 4)**

Run: `pytest scripts/test_backfill_ndr_lead_attributes_from_sheet.py -v`
Expected (if Step 1 hasn't been done yet): `ModuleNotFoundError: No module named 'backfill_ndr_lead_attributes_from_sheet'`

- [ ] **Step 4: Run it against the real implementation from Step 1**

Run: `pytest scripts/test_backfill_ndr_lead_attributes_from_sheet.py -v`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill_ndr_lead_attributes_from_sheet.py scripts/test_backfill_ndr_lead_attributes_from_sheet.py
git commit -m "feat(ndr-calling): add one-off backfill for lead attributes from the live sheets"
```

**Do not run `--apply` yourself — this hits the real sheets and real prod DB. Tell the user it's ready for them to run**, same as Task 1.

---

## Task 5: NDR query layer + process branching in `api/_lib/db.js`

**Files:**
- Modify: `api/_lib/db.js` (add 3 functions near `getCallingPartnerReasonBreakdown`/`getCallingRtoReasonBreakdown` ~L4234-4330; modify `getCallingOverviewData` ~L4334-4344)
- Modify: `app/calling-overview/CallingOverviewClient.js` (only the one field-name reference, `data.rtoReasonBreakdown` → `data.reasonBreakdown` — full UI work is Task 6)

**Interfaces:**
- Consumes: `dateBounds(dateFrom, dateTo)` (existing helper, unchanged).
- Produces: `getCallingOverviewData(query)` where `query.process` is `'RTO'` (default, unchanged behavior) or `'NDR'`. Returned payload shape: `{ stats, reasonBreakdown, partnerReasonBreakdown }` for both processes (renamed from `rtoReasonBreakdown`); `hourly`/`partnerBreakdown` are RTO-only and simply absent from the NDR payload (confirmed unused by the client in the current code).

- [ ] **Step 1: Add the three NDR query functions**

Insert directly above `getCallingOverviewData` (~L4331, right after `getCallingPartnerReasonBreakdown`'s closing brace):

```javascript
// connected/converted have no dedicated column - disposition already IS the full dash-joined
// disposition-tree leaf path an agent picked (see NdrCallingClient.js's saveNdrDisposition),
// e.g. "Connected - New order Placed" or "Not Connected - Reattempt". LOWER()+LIKE mirrors the
// case-insensitive matching commit efe2d09 already established for this exact ambiguity
// (an admin can reword a tree label's case without it being a schema change).
//
// Written as LITERAL SQL text inline below, not interpolated via ${} - the `sql` tag in this
// file binds every ${} as a parameterized value (like a prepared-statement `?`), so passing a
// SQL fragment string through ${} would try to bind
// "LOWER(TRIM(disposition)) LIKE 'connected%'" as a VALUE, not splice it in as SQL, and the
// query would fail. This is exactly how the existing RTO functions handle their own fixed
// fragment (`IF(UPPER(order_id) LIKE 'HYP%', 'Hyphen', 'mCaffeine')`) - always written directly
// in the template's static text, never through a substitution.

// Cross-agent KPIs for the Overview's Process=NDR view, reading ndr_lead_assignments instead
// of CLS_RTO_calling. Same assigned/pending (reassigned_away_at IS NULL + assigned_at bounds)
// vs disposed/connected/converted (every cycle + disposed_at bounds) grain split as
// getCallingOverviewStats - see its own comment for why. No refund fields: NDR calling has no
// refund concept, and the Overview hides that KPI tile entirely for this process rather than
// showing a fixed zero.
async function getNdrCallingOverviewStats(dateFrom, dateTo) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const { rows } = await sql`
    SELECT
      COUNT(DISTINCT CASE WHEN reassigned_away_at IS NULL AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to}) THEN awb_number END) AS total_assigned,
      COUNT(DISTINCT CASE WHEN disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN awb_number END) AS total_disposed,
      COUNT(DISTINCT CASE WHEN reassigned_away_at IS NULL AND disposed_at IS NULL AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to}) THEN awb_number END) AS total_pending,
      COUNT(DISTINCT CASE WHEN LOWER(TRIM(disposition)) LIKE 'connected%' AND disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN awb_number END) AS total_connected,
      COUNT(DISTINCT CASE WHEN LOWER(TRIM(disposition)) NOT LIKE 'connected%' AND disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN awb_number END) AS total_unreachable,
      COUNT(DISTINCT CASE WHEN LOWER(disposition) LIKE '%new order placed%' AND disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN awb_number END) AS total_converted
    FROM ndr_lead_assignments
  `;
  const r = rows[0] || {};
  return {
    totalAssigned: Number(r.total_assigned) || 0,
    totalDisposed: Number(r.total_disposed) || 0,
    totalPending: Number(r.total_pending) || 0,
    totalConnected: Number(r.total_connected) || 0,
    totalUnreachable: Number(r.total_unreachable) || 0,
    totalConverted: Number(r.total_converted) || 0,
  };
}

// Top-level NDR Reason Breakdown table - GROUP BY ndr_reason directly, no category rollup (no
// NDR equivalent of categorizeRtoReason - these are free-text courier reasons, shown as-is).
async function getNdrCallingReasonBreakdown(dateFrom, dateTo, paymentMode, brand) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const mode = paymentMode === 'Prepaid' || paymentMode === 'COD' ? paymentMode : null;
  const brandFilter = brand === 'Hyphen' || brand === 'mCaffeine' ? brand : null;
  const { rows } = await sql`
    SELECT
      COALESCE(ndr_reason, 'Unknown') AS ndr_reason,
      SUM(CASE WHEN reassigned_away_at IS NULL
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${brandFilter} IS NULL OR brand = ${brandFilter})
            AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to})
          THEN 1 ELSE 0 END) AS total_assigned,
      SUM(CASE WHEN disposed_at IS NOT NULL AND LOWER(TRIM(disposition)) LIKE 'connected%'
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${brandFilter} IS NULL OR brand = ${brandFilter})
            AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
          THEN 1 ELSE 0 END) AS total_connected,
      SUM(CASE WHEN disposed_at IS NOT NULL AND LOWER(disposition) LIKE '%new order placed%'
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${brandFilter} IS NULL OR brand = ${brandFilter})
            AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
          THEN 1 ELSE 0 END) AS total_converted
    FROM ndr_lead_assignments
    GROUP BY 1
    HAVING total_assigned > 0 OR total_connected > 0 OR total_converted > 0
    ORDER BY total_assigned DESC
  `;
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
  return rows.map((r) => {
    const totalAssigned = Number(r.total_assigned) || 0;
    const totalConnected = Number(r.total_connected) || 0;
    const totalConverted = Number(r.total_converted) || 0;
    return {
      rtoReason: r.ndr_reason, // same column key funnelColumns' labelKey uses on the client for both processes
      totalAssigned, totalConnected, totalConverted,
      connectedPct: pct(totalConnected, totalAssigned),
      convertedPct: pct(totalConverted, totalAssigned),
    };
  });
}

// Delivery Partner Breakdown for Process=NDR - GROUP BY (delivery_partner, ndr_reason), same
// reassembly into {deliveryPartner, ...totals, reasons: [...]} as getCallingPartnerReasonBreakdown.
async function getNdrCallingPartnerReasonBreakdown(dateFrom, dateTo, paymentMode, brand) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const mode = paymentMode === 'Prepaid' || paymentMode === 'COD' ? paymentMode : null;
  const brandFilter = brand === 'Hyphen' || brand === 'mCaffeine' ? brand : null;
  const { rows } = await sql`
    SELECT
      COALESCE(delivery_partner, 'Unknown') AS partner,
      COALESCE(ndr_reason, 'Unknown') AS ndr_reason,
      SUM(CASE WHEN reassigned_away_at IS NULL
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${brandFilter} IS NULL OR brand = ${brandFilter})
            AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to})
          THEN 1 ELSE 0 END) AS total_assigned,
      SUM(CASE WHEN disposed_at IS NOT NULL AND LOWER(TRIM(disposition)) LIKE 'connected%'
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${brandFilter} IS NULL OR brand = ${brandFilter})
            AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
          THEN 1 ELSE 0 END) AS total_connected,
      SUM(CASE WHEN disposed_at IS NOT NULL AND LOWER(disposition) LIKE '%new order placed%'
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${brandFilter} IS NULL OR brand = ${brandFilter})
            AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
          THEN 1 ELSE 0 END) AS total_converted
    FROM ndr_lead_assignments
    GROUP BY 1, 2
    HAVING total_assigned > 0 OR total_connected > 0 OR total_converted > 0
  `;
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
  const emptyAcc = () => ({ totalAssigned: 0, totalConnected: 0, totalConverted: 0 });
  const byPartner = new Map();
  for (const r of rows) {
    const assigned = Number(r.total_assigned) || 0;
    const connected = Number(r.total_connected) || 0;
    const converted = Number(r.total_converted) || 0;
    const partnerAcc = byPartner.get(r.partner) || { totals: emptyAcc(), byReason: new Map() };
    partnerAcc.totals.totalAssigned += assigned;
    partnerAcc.totals.totalConnected += connected;
    partnerAcc.totals.totalConverted += converted;
    const reasonAcc = partnerAcc.byReason.get(r.ndr_reason) || emptyAcc();
    reasonAcc.totalAssigned += assigned;
    reasonAcc.totalConnected += connected;
    reasonAcc.totalConverted += converted;
    partnerAcc.byReason.set(r.ndr_reason, reasonAcc);
    byPartner.set(r.partner, partnerAcc);
  }
  const toFunnelRow = (acc) => ({
    totalAssigned: acc.totalAssigned,
    totalConnected: acc.totalConnected,
    connectedPct: pct(acc.totalConnected, acc.totalAssigned),
    totalConverted: acc.totalConverted,
    convertedPct: pct(acc.totalConverted, acc.totalAssigned),
  });
  return [...byPartner.entries()]
    .map(([deliveryPartner, acc]) => ({
      deliveryPartner,
      ...toFunnelRow(acc.totals),
      reasons: [...acc.byReason.entries()]
        .map(([rtoReason, reasonAcc]) => ({ rtoReason, ...toFunnelRow(reasonAcc) }))
        .sort((a, b) => b.totalAssigned - a.totalAssigned),
    }))
    .sort((a, b) => b.totalAssigned - a.totalAssigned);
}
```

- [ ] **Step 2: Branch `getCallingOverviewData` by process and rename the field**

Replace (~L4334-4344):

```javascript
async function getCallingOverviewData(query) {
  const { dateFrom, dateTo, paymentMode, brand } = query || {};
  const [stats, hourly, partnerBreakdown, rtoReasonBreakdown, partnerReasonBreakdown] = await Promise.all([
    getCallingOverviewStats(dateFrom, dateTo),
    getCallingHourlyStats(dateFrom, dateTo),
    getCallingPartnerBreakdown(dateFrom, dateTo),
    getCallingRtoReasonBreakdown(dateFrom, dateTo, paymentMode, brand),
    getCallingPartnerReasonBreakdown(dateFrom, dateTo, paymentMode, brand),
  ]);
  return { stats, hourly, partnerBreakdown, rtoReasonBreakdown, partnerReasonBreakdown };
}
```

with:

```javascript
async function getCallingOverviewData(query) {
  const { dateFrom, dateTo, paymentMode, brand, process: proc } = query || {};
  if (proc === 'NDR') {
    const [stats, reasonBreakdown, partnerReasonBreakdown] = await Promise.all([
      getNdrCallingOverviewStats(dateFrom, dateTo),
      getNdrCallingReasonBreakdown(dateFrom, dateTo, paymentMode, brand),
      getNdrCallingPartnerReasonBreakdown(dateFrom, dateTo, paymentMode, brand),
    ]);
    return { stats, reasonBreakdown, partnerReasonBreakdown };
  }
  const [stats, hourly, partnerBreakdown, reasonBreakdown, partnerReasonBreakdown] = await Promise.all([
    getCallingOverviewStats(dateFrom, dateTo),
    getCallingHourlyStats(dateFrom, dateTo),
    getCallingPartnerBreakdown(dateFrom, dateTo),
    getCallingRtoReasonBreakdown(dateFrom, dateTo, paymentMode, brand),
    getCallingPartnerReasonBreakdown(dateFrom, dateTo, paymentMode, brand),
  ]);
  return { stats, hourly, partnerBreakdown, reasonBreakdown, partnerReasonBreakdown };
}
```

- [ ] **Step 3: Update the one client reference to the renamed field (interim, ahead of Task 6)**

In `app/calling-overview/CallingOverviewClient.js`, every occurrence of `data.rtoReasonBreakdown` (~L347, ~L359, ~L369, ~L372) becomes `data.reasonBreakdown` — a plain rename, no behavior change yet (Task 6 does the rest of the UI work). Use a project-wide find/replace scoped to this file for `rtoReasonBreakdown` → `reasonBreakdown` (both the destructured/read references and nowhere else — `PARTNER_COLUMNS`/`REASON_COLUMNS` and `partnerReasonBreakdown` are unrelated names and must NOT match this replace).

- [ ] **Step 4: Manual smoke check**

Run: `node -e "require('./api/_lib/db.js')"` from the repo root.
Expected: no syntax/require errors (this only checks the file parses and its `module.exports` still evaluates — it does not hit a real database, since `ensureSchema`/queries are never called by merely requiring the file).

- [ ] **Step 5: Commit**

```bash
git add api/_lib/db.js app/calling-overview/CallingOverviewClient.js
git commit -m "feat(calling-overview): add NDR query functions, branch getCallingOverviewData by process"
```

---

## Task 6: Process filter UI in `CallingOverviewClient.js`

**Files:**
- Modify: `app/calling-overview/CallingOverviewClient.js`

**Interfaces:**
- Consumes: `getCallingOverviewData`'s payload from Task 5 — `{ stats, reasonBreakdown, partnerReasonBreakdown }` for NDR (no `hourly`/`partnerBreakdown`, already unused), same three keys plus the two unused ones for RTO.
- Produces: nothing consumed by a later task — this is the last task.

- [ ] **Step 1: Add the Process option list and state**

Near the top, alongside `PAYMENT_MODE_OPTIONS`/`BRAND_OPTIONS` (~L16-29):

```javascript
const PROCESS_OPTIONS = [
  { value: 'RTO', label: 'RTO' },
  { value: 'NDR', label: 'NDR' },
];
```

In the component body, alongside the other filter state (~L128-129). Named `processFilter`, not `process` — `process` is the Node/webpack global and shadowing it inside the component is a footgun worth avoiding even though nothing here currently reads it:

```javascript
  const [processFilter, setProcessFilter] = useState('RTO');
```

- [ ] **Step 2: Make the reason-column label/table copy depend on `processFilter`**

Replace the module-level constants:

```javascript
const PARTNER_COLUMNS = funnelColumns('deliveryPartner', 'Delivery Partner');
const REASON_COLUMNS = funnelColumns('rtoReason', 'RTO Reason');
```

with:

```javascript
const PARTNER_COLUMNS = funnelColumns('deliveryPartner', 'Delivery Partner');
function reasonColumns(processFilter) {
  return funnelColumns('rtoReason', processFilter === 'NDR' ? 'NDR Reason' : 'RTO Reason');
}
```

Inside the component, compute the columns once from state (near where `stats` is derived, ~L176):

```javascript
  const stats = data && data.stats;
  const REASON_COLUMNS = reasonColumns(processFilter);
```

(This shadows the old module-level `REASON_COLUMNS` name inside the component — every existing `REASON_COLUMNS` reference in the JSX below keeps working unchanged, now reading the process-scoped one.)

- [ ] **Step 3: Add the filter control and send `process` to the API**

In the filterbar (~L196-197), add a Process dropdown as the first filter group:

```javascript
      <div className="co-filterbar">
        <div className="co-filter-group">
          <label htmlFor="co-process">Process</label>
          <select id="co-process" value={processFilter} onChange={(e) => setProcessFilter(e.target.value)}>
            {PROCESS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="co-filter-group">
          <label htmlFor="co-date-scope">Date range</label>
```

In the fetch effect (~L155-174), add `process` to the query params (sent under the `process` key, matching Task 5's `query.process`) and add `processFilter` to the dependency array:

```javascript
  useEffect(() => {
    if (!authed) return;
    setError(null);
    const params = new URLSearchParams();
    params.set('process', processFilter);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (paymentMode) params.set('paymentMode', paymentMode);
    if (brand) params.set('brand', brand);
    const qs = params.toString();
    fetch(`/api/report/data/calling-overview${qs ? `?${qs}` : ''}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${r.status})`);
        }
        return r.json();
      })
      .then((json) => setData(json))
      .catch((e) => setError(e.message || 'Could not load Calling Team overview.'));
  }, [authed, processFilter, dateFrom, dateTo, paymentMode, brand]);
```

- [ ] **Step 4: Hide the Refunds tile for NDR**

In the KPI row (~L233-265), wrap the Refunds tile's rendering:

```javascript
          {processFilter !== 'NDR' && (
            <div className="kpi kpi-accent">
              <div className="kpi-label">Refunds</div>
              <div className="kpi-value">{stats.totalRefunded.toLocaleString('en-IN')}</div>
              <div className="kpi-sub">₹{stats.totalRefundAmount.toLocaleString('en-IN')}</div>
            </div>
          )}
```

- [ ] **Step 5: Swap the table titles/hints for NDR**

Replace the two literal strings:

```javascript
          <h2 className="co-table-title">Delivery Partner Breakdown</h2>
          <p className="co-table-hint">Click a partner to see its RTO reason funnel.</p>
```

with:

```javascript
          <h2 className="co-table-title">Delivery Partner Breakdown</h2>
          <p className="co-table-hint">Click a partner to see its {processFilter === 'NDR' ? 'NDR' : 'RTO'} reason funnel.</p>
```

and:

```javascript
          <h2 className="co-table-title">RTO Reason Breakdown</h2>
```

with:

```javascript
          <h2 className="co-table-title">{processFilter === 'NDR' ? 'NDR' : 'RTO'} Reason Breakdown</h2>
```

- [ ] **Step 6: Manual verification (no automated UI test exists for this component today)**

Start the dev server and open `/calling-overview`:
- Default load (Process=RTO) looks exactly as it did before this change — same tiles, same table titles, same data.
- Switching Process to NDR: Refunds tile disappears, table titles/hints read "NDR", tables populate with data (empty/near-empty is expected until Tasks 1-4's migration/backfill have been run against the real database — confirm no error is thrown, and "No data for this filter." renders instead of a crash).
- Payment mode / Brand / Date range filters still work in both modes.

- [ ] **Step 7: Commit**

```bash
git add app/calling-overview/CallingOverviewClient.js
git commit -m "feat(calling-overview): add Process (RTO/NDR) filter to the Overview page"
```

---

## Post-implementation (not part of this plan's tasks — tell the user):

1. Run `python scripts/migrate_ndr_lead_attributes.py --apply` against the real database. Required before step 2 — the new code reads/writes columns this step creates.
2. Deploy `api/` and `app/` TOGETHER, in the same deploy pass. Task 5 renamed the RTO payload's `rtoReasonBreakdown` key to `reasonBreakdown` — deploying `api/` alone first would make the old (not-yet-updated) app client's RTO Reason Breakdown table go silently blank until `app/` also deploys, since these two deploy separately in this project.
3. Run `python scripts/backfill_ndr_lead_attributes_from_sheet.py --apply` once, to fill historical rows. Only depends on step 1 having completed — its timing relative to step 2 does not matter.
