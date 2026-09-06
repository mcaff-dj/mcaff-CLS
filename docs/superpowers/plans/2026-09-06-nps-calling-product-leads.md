# NPS-Calling Product Leads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second detractor lead pool to NPS-Calling, sourced from `nps_product`
(product-rating survey) alongside the existing `nps_delivery` pool, tagged `lead_type` on each
ticket, with its own admin-configurable disposition tree — one shared quota, one ticket list, one
page.

**Architecture:** Extend the existing `'detractor'` process rather than add a new one. A new
nullable `lead_type` column on `CLS_NPS_calling` tags which pool a ticket came from; the same
nullable-scope pattern `calling_process_dispositions.team_id` already uses is repeated for
`lead_type` so a disposition tree can be scoped per pool with the same "falls back to shared if
empty" rule. Claiming merges both pools by peeking the oldest/newest eligible candidate from each
and inserting whichever wins, so `assignDetractorLeadsToAgent`'s existing loop, quota math, and
dup-retry logic need no changes at all — only its default claim function changes.

**Tech Stack:** Node.js (Vercel serverless functions, `api/`), Next.js/React (`app/`), MySQL
(`PEP_CLS` schema via `api/_lib/db.js`'s `sql` tagged template), Python migration scripts
(`scripts/`, `pymysql`).

**Spec:** `docs/superpowers/specs/2026-09-06-nps-calling-product-leads-design.md`

## Global Constraints

- One shared quota per agent, mixed pool — no per-type quota, no per-agent type assignment (spec's
  "Quota" decision).
- One call lead per `response_id`, even though `nps_product` has up to 4 rows per response (spec's
  "Lead granularity" decision).
- Same `'detractor'` process/tab/page — no new `callingProcesses.json` entry (spec's
  "Process/tab" decision).
- `nps_delivery` and `nps_product` are independent response pools (never the same person in both) —
  no dedup needed *between* the two tables, only within `nps_product` (multiple slots per
  response).
- No live-DB or dev-server runs in this plan — the user performs live testing. Every step that
  needs a database is verified by a `--dry-run`/print check or is covered by a pure-logic test
  instead, matching this repo's existing convention for scripts like
  `scripts/migrate_team_dispositions.py` (no accompanying test file; dry-run output is its own
  check).

---

## File Structure

**Create:**
- `api/_lib/detractorMerge.js` — pure logic: parse a `submitted_date` string, decide which of two
  candidate dates wins under the admin's lead-order setting. No DB, no network — unit-testable
  standalone, same shape as `api/_lib/dispositionTrees.js`.
- `api/_lib/detractorMerge.test.js` — its test.
- `scripts/migrate_nps_calling_lead_type.py` — adds `CLS_NPS_calling.lead_type`, rewrites its
  `live_response_id` generated column, and adds `calling_process_dispositions.lead_type` (+ index)
  on the live database. Same dry-run-by-default/`--apply`/idempotent shape as
  `scripts/migrate_team_dispositions.py`.

**Modify:**
- `api/_lib/db.js` — bootstrap schema (fresh-install `CREATE TABLE` text) for `CLS_NPS_calling`;
  split `getNextDetractorLead` into a peek (SELECT-only) step and the existing insert; add the
  equivalent peek+insert pair for `nps_product`; add the merge entrypoint that
  `assignDetractorLeadsToAgent` now defaults to; extend `getUnassignedDetractorLeads` to merge both
  pools; thread a `leadType` parameter through the five `calling_process_dispositions` functions,
  mirroring `teamId` exactly; update the module's `exports`.
- `api/admin/[action].js` — `handleDispositions` resolves `leadType` from the request the same way
  it already resolves `teamId`, and passes it to the five db functions.
- `app/_calling/CallingAdminPanel.js` — `useProcessDispositions` gains a `leadType` option, sent on
  every load/add/edit/delete/reorder call, mirroring `teamId`.
- `app/nps-calling/NpsCallingClient.js` — a `PRODUCT_AREAS`-driven branch in `TicketSurveyDetails`
  for `lead_type === 'product'` tickets; a small type badge on each ticket row; an admin Lead Type
  toggle driving the existing disposition-list editor; a second `useProcessDispositions` instance
  scoped to whichever ticket's dispose modal is open, replacing the admin instance as the source of
  `visibleDispositionNodes`.

---

### Task 1: Pure merge-decision helper

**Files:**
- Create: `api/_lib/detractorMerge.js`
- Create: `api/_lib/detractorMerge.test.js`

**Interfaces:**
- Produces: `parseDdMmYyyy(dateStr) -> number|null` (epoch ms, or `null` for an unparseable/absent
  string). `pickOlderDetractorCandidate(deliverySubmittedDate, productSubmittedDate, sortDirection = 1) -> 'delivery'|'product'|null`
  — `sortDirection` is `1` for oldest-first, `-1` for newest-first (same convention
  `getNextDetractorLead`'s own `sortDirection` already uses). Both consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Create `api/_lib/detractorMerge.test.js`:

```js
// Pure-function tests for merging NPS-Calling's two detractor pools (nps_delivery,
// nps_product) into one claim order. No DB, no network. Run: node api/_lib/detractorMerge.test.js
const assert = require('assert');
const { parseDdMmYyyy, pickOlderDetractorCandidate } = require('./detractorMerge');

// parseDdMmYyyy
assert.strictEqual(parseDdMmYyyy('27/04/2026'), new Date(2026, 3, 27).getTime());
assert.strictEqual(parseDdMmYyyy('01/12/2025'), new Date(2025, 11, 1).getTime());
assert.strictEqual(parseDdMmYyyy(null), null);
assert.strictEqual(parseDdMmYyyy(''), null);
assert.strictEqual(parseDdMmYyyy('not-a-date'), null);

// pickOlderDetractorCandidate: oldest-first (sortDirection 1, the default)
assert.strictEqual(pickOlderDetractorCandidate('01/01/2026', '15/01/2026'), 'delivery'); // delivery is older
assert.strictEqual(pickOlderDetractorCandidate('15/01/2026', '01/01/2026'), 'product'); // product is older
assert.strictEqual(pickOlderDetractorCandidate('01/01/2026', '01/01/2026'), 'delivery'); // tie -> deterministic

// newest-first (sortDirection -1) flips which pool wins
assert.strictEqual(pickOlderDetractorCandidate('01/01/2026', '15/01/2026', -1), 'product'); // product is newer
assert.strictEqual(pickOlderDetractorCandidate('15/01/2026', '01/01/2026', -1), 'delivery'); // delivery is newer

// One pool empty (its own claimFn returned nothing to peek): the other always wins, regardless
// of lead order.
assert.strictEqual(pickOlderDetractorCandidate(null, '01/01/2026'), 'product');
assert.strictEqual(pickOlderDetractorCandidate('01/01/2026', null), 'delivery');
assert.strictEqual(pickOlderDetractorCandidate(null, '01/01/2026', -1), 'product');
assert.strictEqual(pickOlderDetractorCandidate('01/01/2026', null, -1), 'delivery');

// Both pools empty: nothing to claim from either.
assert.strictEqual(pickOlderDetractorCandidate(null, null), null);

console.log('detractorMerge.test.js: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node api/_lib/detractorMerge.test.js`
Expected: `Cannot find module './detractorMerge'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `api/_lib/detractorMerge.js`:

```js
// Pure rules for merging NPS-Calling's two detractor pools (nps_delivery, nps_product) into one
// claim order - no DB, no network, so which pool's oldest/newest candidate wins is unit-testable
// without a database. See docs/superpowers/specs/2026-09-06-nps-calling-product-leads-design.md.

// nps_delivery/nps_product both store submitted_date as DD/MM/YYYY text, never a real DATE
// column (confirmed against both tables' data) - same reasoning as getNextDetractorLead's own
// STR_TO_DATE use in db.js. Returns epoch ms, or null for an absent/malformed string so a bad
// value loses every comparison rather than sorting as "smallest" (year zero) or throwing.
function parseDdMmYyyy(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(dateStr).trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d)).getTime();
}

// Which pool's top candidate should be claimed next: 'delivery', 'product', or null if neither
// pool has anything left to peek. sortDirection matches getNextDetractorLead's own convention (1
// = oldest-first, the admin default; -1 = newest-first) - the SAME setting the delivery-only
// claim already used, now applied across both pools instead of within one.
//
// A pool with nothing to peek (its caller already found no eligible row) always loses to the
// other pool, regardless of lead order - "nothing" never outranks "something". A tie (identical
// submitted_date down to the day) resolves to 'delivery' deterministically rather than being
// arbitrary between runs - ties are already rare (same-day submissions across two different
// surveys) and no ordering has ever been promised between them.
function pickOlderDetractorCandidate(deliverySubmittedDate, productSubmittedDate, sortDirection = 1) {
  const d = parseDdMmYyyy(deliverySubmittedDate);
  const p = parseDdMmYyyy(productSubmittedDate);
  if (d == null && p == null) return null;
  if (d == null) return 'product';
  if (p == null) return 'delivery';
  if (d === p) return 'delivery';
  return (d - p) * sortDirection < 0 ? 'delivery' : 'product';
}

module.exports = { parseDdMmYyyy, pickOlderDetractorCandidate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node api/_lib/detractorMerge.test.js`
Expected: `detractorMerge.test.js: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add api/_lib/detractorMerge.js api/_lib/detractorMerge.test.js
git commit -m "feat(nps-calling): add pure merge-decision helper for two detractor pools"
```

---

### Task 2: Schema — `lead_type` on `CLS_NPS_calling`, plus the live-DB migration script

**Files:**
- Modify: `api/_lib/db.js` (the `CLS_NPS_calling` bootstrap `CREATE TABLE`, inside `ensureSchema`)
- Create: `scripts/migrate_nps_calling_lead_type.py`

**Interfaces:**
- Produces: every `CLS_NPS_calling` row now carries `lead_type` (`'delivery'` or `'product'`) and
  six nullable `product_*` rating columns (`product_results`, `product_texture`,
  `product_fragrance`, `product_packaging_rating`, `product_skin_type`, `product_nps`), consumed
  starting Task 4 (write) and Task 10 (render).

- [ ] **Step 1: Edit the bootstrap `CREATE TABLE` for fresh installs**

In `api/_lib/db.js`, find the `CLS_NPS_calling` bootstrap (the block containing
`CREATE TABLE IF NOT EXISTS CLS_NPS_calling`). Locate:

```js
      -- Order context, added by scripts/add_product_name_list_to_calling.py.
      product_name_list TEXT,
      payment_method VARCHAR(50),
      courier_company VARCHAR(100),
      submitted_date VARCHAR(20),
      agent_email VARCHAR(320) NOT NULL,
```

Change to:

```js
      -- Order context, added by scripts/add_product_name_list_to_calling.py.
      product_name_list TEXT,
      payment_method VARCHAR(50),
      courier_company VARCHAR(100),
      submitted_date VARCHAR(20),
      -- Which source table this ticket was claimed from - 'delivery' (nps_delivery, the only
      -- pool that existed before this) or 'product' (nps_product). Added live by
      -- scripts/migrate_nps_calling_lead_type.py; DEFAULT 'delivery' matches every existing
      -- row's actual origin, so the ALTER TABLE that adds this column needs no separate
      -- backfill. Drives which disposition tree a ticket's dispose modal shows (see
      -- calling_process_dispositions.lead_type) and which fields TicketSurveyDetails renders
      -- (app/nps-calling/NpsCallingClient.js).
      lead_type ENUM('delivery','product') NOT NULL DEFAULT 'delivery',
      -- nps_product's own per-product rating fields, only ever filled for lead_type='product'
      -- (a 'delivery' ticket has its own, differently-named rating columns above - these are
      -- never shared between the two, same "only fill in what's relevant" shape those already
      -- use). Copied from whichever product_slot claimOneProductDetractorLead picked as
      -- representative - see that function's own comment for why only one slot's ratings are
      -- kept even when a response rated more than one product.
      product_results VARCHAR(20),
      product_texture VARCHAR(20),
      product_fragrance VARCHAR(20),
      product_packaging_rating VARCHAR(20),
      product_skin_type VARCHAR(50),
      product_nps VARCHAR(10),
      agent_email VARCHAR(320) NOT NULL,
```

Then find the generated column:

```js
      live_response_id VARCHAR(64) GENERATED ALWAYS AS
        (IF(reassigned_away_at IS NULL, response_id, NULL)) VIRTUAL,
```

Change to:

```js
      -- Namespaced by lead_type, not just response_id: nps_delivery and nps_product are
      -- separate UUID spaces with no shared generator (confirmed with the process owner), so a
      -- same-string collision between the two is very unlikely - but the alternative (an
      -- unrelated Delivery and Product lead silently colliding on this unique key) is a
      -- hard-to-diagnose failure for one CONCAT to rule out.
      live_response_id VARCHAR(80) GENERATED ALWAYS AS
        (IF(reassigned_away_at IS NULL, CONCAT(lead_type, ':', response_id), NULL)) VIRTUAL,
```

- [ ] **Step 2: Write the migration script**

Create `scripts/migrate_nps_calling_lead_type.py`:

```python
#!/usr/bin/env python3
"""Adds PEP_CLS.CLS_NPS_calling.lead_type (+ its six nps_product rating columns) and rewrites
live_response_id's generated column to namespace by lead_type, then adds
PEP_CLS.calling_process_dispositions.lead_type (+ index) - see
docs/superpowers/specs/2026-09-06-nps-calling-product-leads-design.md.

Why this is a script and not part of ensureSchema(): api/_lib/db.js bootstraps schema with CREATE
TABLE IF NOT EXISTS, which is inert against an existing table, and there is no ALTER TABLE
anywhere in api/ - so these two new columns cannot ship themselves with the Lambda deploy the way
a brand-new table would. Same reasoning, same shape, as scripts/migrate_team_dispositions.py.

Run BEFORE the api/ deploy that reads these columns - a read against a missing column throws
ER_BAD_FIELD_ERROR (getUnassignedDetractorLeads/getProcessDispositions have no pre-migration
fallback for these two specifically, unlike team_id's own softened read path).

CLS_NPS_calling.lead_type:
  - DEFAULT 'delivery' means the ADD COLUMN itself backfills every existing row correctly (every
    ticket that exists today really did come from nps_delivery) - no separate UPDATE needed.
  - live_response_id (a generated/virtual column carrying CLS_NPS_calling's actual dedup UNIQUE
    KEY - NOT a plain PRIMARY KEY(response_id); see that column's own comment in db.js) is
    rewritten from `IF(reassigned_away_at IS NULL, response_id, NULL)` to
    `IF(reassigned_away_at IS NULL, CONCAT(lead_type, ':', response_id), NULL)` - a generated
    column's expression can be changed in place via MODIFY COLUMN; every existing row's value
    re-derives automatically (all still 'delivery:<response_id>', identical in effect to today),
    no backfill loop needed.

calling_process_dispositions.lead_type: nullable, same convention team_id already established -
NULL means shared/fallback, not "unassigned". Existing rows (every process, including today's
'detractor' rows) stay NULL and keep their current meaning; only an admin who actually configures
a Product tree ever writes a non-null value.

Idempotent / safe to re-run: every step is skipped if already applied (checked via
information_schema). Dry-run by default; --apply performs the DDL.
"""
import argparse
import sys
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
CALLING_TABLE = "CLS_NPS_calling"
DISP_TABLE = "calling_process_dispositions"
DISP_INDEX_NAME = "calling_process_dispositions_lead_type_idx"

OLD_LIVE_RESPONSE_ID_EXPR = "IF(reassigned_away_at IS NULL, response_id, NULL)"
NEW_LIVE_RESPONSE_ID_EXPR = "IF(reassigned_away_at IS NULL, CONCAT(lead_type, ':', response_id), NULL)"

# nps_product's per-product rating fields, only ever filled for lead_type='product' rows - see
# claimOneProductDetractorLead (api/_lib/db.js) for how these are populated.
PRODUCT_RATING_COLUMNS = {
    "product_results": "VARCHAR(20)",
    "product_texture": "VARCHAR(20)",
    "product_fragrance": "VARCHAR(20)",
    "product_packaging_rating": "VARCHAR(20)",
    "product_skin_type": "VARCHAR(50)",
    "product_nps": "VARCHAR(10)",
}


def _column_exists(cur, table, column):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, table, column),
    )
    return cur.fetchone() is not None


def _generation_expression(cur, table, column):
    cur.execute(
        "SELECT generation_expression FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, table, column),
    )
    row = cur.fetchone()
    return row[0] if row else None


def _index_exists(cur, table, index):
    cur.execute(
        "SELECT 1 FROM information_schema.statistics "
        "WHERE table_schema = %s AND table_name = %s AND index_name = %s",
        (SCHEMA, table, index),
    )
    return cur.fetchone() is not None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="run the DDL (default: dry run)")
    args = ap.parse_args()

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], autocommit=False,
        ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        with conn.cursor() as cur:
            # Step 1: CLS_NPS_calling.lead_type
            if _column_exists(cur, CALLING_TABLE, "lead_type"):
                print(f"  {CALLING_TABLE}.lead_type: already present")
            elif args.apply:
                cur.execute(
                    f"ALTER TABLE {CALLING_TABLE} "
                    "ADD COLUMN lead_type ENUM('delivery','product') NOT NULL DEFAULT 'delivery'"
                )
                print(f"  {CALLING_TABLE}.lead_type: added (existing rows backfilled to 'delivery' by DEFAULT)")
            else:
                print(f"  {CALLING_TABLE}.lead_type: would add (DEFAULT 'delivery')")

            # Step 2: live_response_id's generated expression
            current_expr = _generation_expression(cur, CALLING_TABLE, "live_response_id")
            # information_schema normalizes whitespace/case differently across MySQL versions, so
            # this checks for the OLD form still being in place rather than an exact string match
            # against NEW_LIVE_RESPONSE_ID_EXPR (which would never match self-consistently).
            needs_rewrite = current_expr is not None and "concat" not in (current_expr or "").lower()
            if current_expr is None:
                print(f"  {CALLING_TABLE}.live_response_id: column not found (unexpected - is lead_type applied?)")
            elif not needs_rewrite:
                print(f"  {CALLING_TABLE}.live_response_id: already namespaced by lead_type")
            elif args.apply:
                cur.execute(
                    f"ALTER TABLE {CALLING_TABLE} MODIFY COLUMN live_response_id VARCHAR(80) "
                    f"GENERATED ALWAYS AS ({NEW_LIVE_RESPONSE_ID_EXPR}) VIRTUAL"
                )
                print(f"  {CALLING_TABLE}.live_response_id: rewritten to namespace by lead_type")
            else:
                print(f"  {CALLING_TABLE}.live_response_id: would rewrite to namespace by lead_type")

            # Step 3: the six nps_product rating columns
            for column, coltype in PRODUCT_RATING_COLUMNS.items():
                if _column_exists(cur, CALLING_TABLE, column):
                    print(f"  {CALLING_TABLE}.{column}: already present")
                elif args.apply:
                    cur.execute(f"ALTER TABLE {CALLING_TABLE} ADD COLUMN {column} {coltype} NULL")
                    print(f"  {CALLING_TABLE}.{column}: added")
                else:
                    print(f"  {CALLING_TABLE}.{column}: would add")

            # Step 4: calling_process_dispositions.lead_type (+ index)
            if _column_exists(cur, DISP_TABLE, "lead_type"):
                print(f"  {DISP_TABLE}.lead_type: already present")
            elif args.apply:
                cur.execute(f"ALTER TABLE {DISP_TABLE} ADD COLUMN lead_type VARCHAR(16) NULL")
                print(f"  {DISP_TABLE}.lead_type: added")
            else:
                print(f"  {DISP_TABLE}.lead_type: would add")

            if _index_exists(cur, DISP_TABLE, DISP_INDEX_NAME):
                print(f"  index {DISP_INDEX_NAME}: already present")
            elif args.apply:
                cur.execute(
                    f"CREATE INDEX {DISP_INDEX_NAME} ON {DISP_TABLE} (process_key, lead_type, sort_order)"
                )
                print(f"  index {DISP_INDEX_NAME}: added")
            else:
                print(f"  index {DISP_INDEX_NAME}: would add")

        if args.apply:
            conn.commit()
            print("committed")
        else:
            conn.rollback()
            print("dry run - nothing written (re-run with --apply)")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Dry-run smoke check (this repo's convention for a migration script — no
      automated test; see `scripts/migrate_team_dispositions.py`, which ships with none either)**

Run: `python scripts/migrate_nps_calling_lead_type.py`
Expected: prints a plan (`would add` / `would rewrite`) for all four steps, no `--apply`, exits 0.
Cannot run against the live database in this session — the user runs `--apply` before the next
`api/` deploy, per the script's own docstring on run order.

- [ ] **Step 4: Commit**

```bash
git add api/_lib/db.js scripts/migrate_nps_calling_lead_type.py
git commit -m "feat(nps-calling): add lead_type schema for the nps_product lead pool"
```

---

### Task 3: `db.js` — split the delivery claim into peek + insert

**Files:**
- Modify: `api/_lib/db.js:1854-1939` (`getNextDetractorLead`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `peekDeliveryDetractorCandidates({ email, limit }) -> Promise<Array<row>>` (row has at
  least `response_id`, `submitted_date`, plus every other `nps_delivery` column
  `getNextDetractorLead` already selected). `getNextDetractorLead(email)` keeps its existing
  signature and behavior — used unchanged everywhere it's called today, and consumed by Task 5's
  merge entrypoint.

This task is a refactor with no behavior change: the existing single query becomes two calls
(peek, then insert whichever row peek returned), not two new features. `getNextDetractorLead`'s
current callers, and `db.detractorAssign.test.js` (which stubs `claimFn` directly), are
unaffected.

- [ ] **Step 1: Extract the SELECT into `peekDeliveryDetractorCandidates`**

In `api/_lib/db.js`, replace the body of `getNextDetractorLead` (the function starting
`async function getNextDetractorLead(email) {`) up to its `if (!rows.length) return null;` line.

Find:

```js
async function getNextDetractorLead(email) {
  await ensureSchema();
  // Admin-set pull order (calling_process_settings.lead_order via /api/admin/lead-order) -
  // 'oldest' (default) or 'newest'. sql`` only binds plain values, never raw SQL keywords, so
  // ASC/DESC itself can't be parametrized - sortDirection instead flips the SIGN of the sort
  // key (TO_DAYS as a plain integer), and the query's own ORDER BY stays a fixed ASC on that
  // signed value: ASC on the day number is oldest-first, ASC on its negation is newest-first.
  const sortDirection = (await getCallingLeadOrder('detractor')) === 'newest' ? -1 : 1;
  // '' (no row, or an explicitly cleared filter) = unrestricted - the `${brandFilter} = ''`
  // branch of the OR below always wins in that case, same "empty string means no restriction"
  // convention as NDR's ndr_brand_filter (see calling_agent_process's own column comment).
  const { rows: filterRows } = await sql`
    SELECT detractor_brand_filter FROM calling_agent_process WHERE email = ${email} AND process_key = 'detractor'
  `;
  const brandFilter = (filterRows[0] && filterRows[0].detractor_brand_filter) || '';
  const { rows } = await sql`
    SELECT d.response_id, d.brand, d.channel_order_id, d.customer_name, d.customer_phone,
           d.customer_email, d.address_city, d.address_state, d.address_pincode, d.nps_score,
           d.nps_category, d.category, d.sub_category,
           d.top_rated_area, d.other_l1_specify,
           d.order_placement_experience, d.order_placement_promoter_reason, d.order_placement_promoter_openend,
           d.platform_passive_reason, d.platform_passive_openend,
           d.platform_detractor_reason, d.platform_detractor_openend,
           d.product_first_impression, d.product_packaging_promoter_reason, d.product_packaging_promoter_openend,
           d.product_first_impression_passive_reason, d.product_first_impression_passive_openend,
           d.product_packaging_detractor_reason, d.product_packaging_detractor_openend,
           d.cs_reach, d.cs_team_rating, d.cs_promoter_reason, d.cs_promoter_openend,
           d.cs_passive_reason, d.cs_passive_openend,
           d.cs_detractor_reason, d.cs_detractor_openend,
           d.delivery_service_rating, d.delivery_promoter_reason, d.delivery_promoter_openend,
           d.delivery_passive_reason, d.delivery_passive_openend,
           d.delivery_detractor_reason, d.delivery_detractor_openend,
           d.additional_feedback, d.product_name_list, d.payment_method, d.courier_company,
           d.submitted_date
    FROM nps_delivery d
    LEFT JOIN CLS_NPS_calling c ON c.response_id = d.response_id
    WHERE d.nps_category = 'Detractor' AND c.response_id IS NULL
      AND (${brandFilter} = '' OR d.brand = ${brandFilter})
      AND STR_TO_DATE(d.submitted_date, '%d/%m/%Y') >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    ORDER BY TO_DAYS(STR_TO_DATE(d.submitted_date, '%d/%m/%Y')) * ${sortDirection} ASC
    LIMIT 1
  `;
  if (!rows.length) return null;
```

Replace with:

```js
// Reads calling_agent_process.detractor_brand_filter - '' (no row, or an explicitly cleared
// filter) means unrestricted, same "empty string means no restriction" convention as NDR's
// ndr_brand_filter. null for a preview/admin call with no agent behind it (getUnassignedDetractorLeads).
async function _detractorBrandFilterFor(email) {
  if (!email) return '';
  const { rows } = await sql`
    SELECT detractor_brand_filter FROM calling_agent_process WHERE email = ${email} AND process_key = 'detractor'
  `;
  return (rows[0] && rows[0].detractor_brand_filter) || '';
}

// SELECT-only half of the delivery claim - the same 30-day-filtered, lead-order-sorted,
// brand-filtered nps_delivery query getNextDetractorLead always ran, now callable without also
// inserting. limit>1 backs getUnassignedDetractorLeads' merged preview; email=null skips the
// brand filter (used by that same preview, which has never applied one).
async function peekDeliveryDetractorCandidates({ email = null, limit = 1 } = {}) {
  await ensureSchema();
  const sortDirection = (await getCallingLeadOrder('detractor')) === 'newest' ? -1 : 1;
  const brandFilter = await _detractorBrandFilterFor(email);
  const { rows } = await sql`
    SELECT d.response_id, d.brand, d.channel_order_id, d.customer_name, d.customer_phone,
           d.customer_email, d.address_city, d.address_state, d.address_pincode, d.nps_score,
           d.nps_category, d.category, d.sub_category,
           d.top_rated_area, d.other_l1_specify,
           d.order_placement_experience, d.order_placement_promoter_reason, d.order_placement_promoter_openend,
           d.platform_passive_reason, d.platform_passive_openend,
           d.platform_detractor_reason, d.platform_detractor_openend,
           d.product_first_impression, d.product_packaging_promoter_reason, d.product_packaging_promoter_openend,
           d.product_first_impression_passive_reason, d.product_first_impression_passive_openend,
           d.product_packaging_detractor_reason, d.product_packaging_detractor_openend,
           d.cs_reach, d.cs_team_rating, d.cs_promoter_reason, d.cs_promoter_openend,
           d.cs_passive_reason, d.cs_passive_openend,
           d.cs_detractor_reason, d.cs_detractor_openend,
           d.delivery_service_rating, d.delivery_promoter_reason, d.delivery_promoter_openend,
           d.delivery_passive_reason, d.delivery_passive_openend,
           d.delivery_detractor_reason, d.delivery_detractor_openend,
           d.additional_feedback, d.product_name_list, d.payment_method, d.courier_company,
           d.submitted_date
    FROM nps_delivery d
    LEFT JOIN CLS_NPS_calling c ON c.response_id = d.response_id
    WHERE d.nps_category = 'Detractor' AND c.response_id IS NULL
      AND (${brandFilter} = '' OR d.brand = ${brandFilter})
      AND STR_TO_DATE(d.submitted_date, '%d/%m/%Y') >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    ORDER BY TO_DAYS(STR_TO_DATE(d.submitted_date, '%d/%m/%Y')) * ${sortDirection} ASC
    LIMIT ${limit}
  `;
  return rows;
}

async function getNextDetractorLead(email) {
  const [lead] = await peekDeliveryDetractorCandidates({ email, limit: 1 });
  if (!lead) return null;
```

Leave everything from the `await sql\`INSERT INTO CLS_NPS_calling (...` line to the function's
closing `return lead; }` exactly as it is today — it already reads `lead.response_id` etc. from
the row object, which `peekDeliveryDetractorCandidates` still provides identically.

Since `CLS_NPS_calling` now has `lead_type NOT NULL DEFAULT 'delivery'` (Task 2), the existing
`INSERT INTO CLS_NPS_calling (...)` column list does not need `lead_type` added explicitly — the
column default already makes every `getNextDetractorLead` insert a `'delivery'` row, which is
correct and requires no change to this INSERT statement.

- [ ] **Step 2: Commit**

```bash
git add api/_lib/db.js
git commit -m "refactor(nps-calling): split delivery detractor claim into peek + insert"
```

---

### Task 4: `db.js` — claim from `nps_product`

**Files:**
- Modify: `api/_lib/db.js` (new functions, placed directly after `getNextDetractorLead`, before
  `getUnassignedDetractorLeads`)

**Interfaces:**
- Consumes: `_detractorBrandFilterFor` (Task 3), `getCallingLeadOrder` (existing).
- Produces: `peekProductDetractorCandidates({ email, limit }) -> Promise<Array<{response_id, submitted_date, nps_category}>>`.
  `claimOneProductDetractorLead(email) -> Promise<lead|null>` — same contract as
  `getNextDetractorLead`: returns the claimed row (now including `lead_type: 'product'` and a
  `product_name_list`-style aggregated field), or `null` if the pool is empty. Consumed by Task 5's
  merge entrypoint and by `assignDetractorLeadsToAgent`'s dup-retry loop (unchanged — it already
  retries whatever `claimFn` it's given).

- [ ] **Step 1: Add the peek + claim pair**

In `api/_lib/db.js`, insert immediately after `getNextDetractorLead`'s closing brace (before the
`// Claims up to maxCount fresh detractor leads...` comment that precedes
`assignDetractorLeadsToAgent`):

```js
// nps_product-sourced equivalent of peekDeliveryDetractorCandidates. nps_product has up to 4
// rows per response_id (one per rated product, product_slot 0-3) with nps_category constant
// across a response's own slots (confirmed against nps_source.py's own finding) - this dedups to
// one row per response_id, same "one lead per person" shape nps_delivery already has. Returns
// only response_id/submitted_date/nps_category: enough to peek and compare against the delivery
// pool's own candidates (see detractorMerge.js), not the full row - claimOneProductDetractorLead
// fetches the rest only for the response_id that actually wins.
async function peekProductDetractorCandidates({ email = null, limit = 1 } = {}) {
  await ensureSchema();
  const sortDirection = (await getCallingLeadOrder('detractor')) === 'newest' ? -1 : 1;
  const brandFilter = await _detractorBrandFilterFor(email);
  const { rows } = await sql`
    SELECT p.response_id, MIN(p.submitted_date) AS submitted_date, MIN(p.nps_category) AS nps_category
    FROM nps_product p
    LEFT JOIN CLS_NPS_calling c ON c.response_id = p.response_id
    WHERE c.response_id IS NULL
      AND (${brandFilter} = '' OR p.brand = ${brandFilter})
      AND STR_TO_DATE(p.submitted_date, '%d/%m/%Y') >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    GROUP BY p.response_id
    HAVING MIN(p.nps_category) = 'Detractor'
    ORDER BY TO_DAYS(STR_TO_DATE(MIN(p.submitted_date), '%d/%m/%Y')) * ${sortDirection} ASC
    LIMIT ${limit}
  `;
  return rows;
}

// Claims one Detractor response_id from nps_product for `email` - the peek above found which
// response_id to claim; this fetches the rest of that one response's data and inserts it.
//
// A Detractor response can have more than one really-rated product (product_name not NULL/'NA');
// product_name_list joins all of them (same comma-joined shape nps_delivery's own
// product_name_list already has, parsed client-side by NpsCallingClient.js's
// splitProductNameList) - but the per-product RATING fields (results, texture, fragrance,
// packaging, skin_type_category, product_nps) are taken from only the first such slot (lowest
// product_slot): rendering up to 4 parallel rating sets on one ticket has no clear "the" value to
// show an agent, so one representative product's ratings is the deliberate simplification here.
// overall_nps_score/additional_feedback are constant across a response's slots (same finding
// nps_source.py already relies on) and copied as-is.
async function claimOneProductDetractorLead(email) {
  const [candidate] = await peekProductDetractorCandidates({ email, limit: 1 });
  if (!candidate) return null;
  const responseId = candidate.response_id;

  const { rows: nameRows } = await sql`
    SELECT GROUP_CONCAT(DISTINCT product_name ORDER BY product_slot SEPARATOR ', ') AS product_name_list
    FROM nps_product
    WHERE response_id = ${responseId} AND product_name IS NOT NULL AND TRIM(product_name) NOT IN ('', 'NA')
  `;
  const productNameList = (nameRows[0] && nameRows[0].product_name_list) || null;

  const { rows: slotRows } = await sql`
    SELECT response_id, brand, channel_order_id, customer_name, customer_phone, customer_email,
           address_city, address_state, address_pincode, category, sub_category,
           payment_method, courier_company, submitted_date,
           overall_nps_score, nps_category, product_nps, results, texture, fragrance, packaging,
           skin_type_category, additional_feedback
    FROM nps_product
    WHERE response_id = ${responseId}
    ORDER BY (product_name IS NULL OR TRIM(product_name) IN ('', 'NA')) ASC, product_slot ASC
    LIMIT 1
  `;
  const lead = slotRows[0];
  if (!lead) return null; // the candidate's rows vanished between peek and here - pool moved on, not an error

  await sql`
    INSERT INTO CLS_NPS_calling (
      response_id, brand, channel_order_id, customer_name, customer_phone, customer_email,
      address_city, address_state, address_pincode, nps_score, nps_category, category, sub_category,
      additional_feedback, product_name_list, payment_method, courier_company, submitted_date,
      lead_type, product_results, product_texture, product_fragrance, product_packaging_rating,
      product_skin_type, product_nps, agent_email, assigned_at
    ) VALUES (
      ${lead.response_id}, ${lead.brand}, ${lead.channel_order_id}, ${lead.customer_name}, ${lead.customer_phone},
      ${lead.customer_email}, ${lead.address_city}, ${lead.address_state}, ${lead.address_pincode},
      ${lead.overall_nps_score}, ${lead.nps_category}, ${lead.category}, ${lead.sub_category},
      ${lead.additional_feedback}, ${productNameList}, ${lead.payment_method}, ${lead.courier_company},
      ${lead.submitted_date}, 'product', ${lead.results}, ${lead.texture}, ${lead.fragrance},
      ${lead.packaging}, ${lead.skin_type_category}, ${lead.product_nps}, ${email}, NOW()
    )
  `;
  return {
    ...lead, product_name_list: productNameList, lead_type: 'product',
    product_results: lead.results, product_texture: lead.texture, product_fragrance: lead.fragrance,
    product_packaging_rating: lead.packaging, product_skin_type: lead.skin_type_category,
  };
}
```

`lead.results`/`lead.texture`/`lead.fragrance`/`lead.packaging`/`lead.skin_type_category` are the
`nps_product` column names (from the representative-slot query above); they're written into
`CLS_NPS_calling`'s differently-named `product_*` columns (Task 2) to keep them visually distinct
from that table's existing, unrelated `product_packaging_promoter_reason`-style columns.

- [ ] **Step 2: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat(nps-calling): claim detractor leads from nps_product"
```

---

### Task 5: `db.js` — merge entrypoint, wired into `assignDetractorLeadsToAgent`

**Files:**
- Modify: `api/_lib/db.js:1955` (`assignDetractorLeadsToAgent`'s default parameter)
- Modify: `api/_lib/db.js` (new function, placed just before `assignDetractorLeadsToAgent`)

**Interfaces:**
- Consumes: `peekDeliveryDetractorCandidates`, `peekProductDetractorCandidates`,
  `getNextDetractorLead`, `claimOneProductDetractorLead` (all above), `pickOlderDetractorCandidate`
  from `./detractorMerge` (Task 1).
- Produces: `getNextDetractorLeadEitherPool(email) -> Promise<lead|null>` — the new default
  `claimFn` for `assignDetractorLeadsToAgent`. No change to `assignDetractorLeadsToAgent`'s own
  loop, dup-retry, or exported signature — callers that already pass an explicit `claimFn` (the
  test file) are unaffected; callers that rely on the default (`api/auth/[action].js`,
  `api/detractor/lead-assignment.js`) start drawing from both pools with no code change on their
  side.

- [ ] **Step 1: Add the merge entrypoint and switch the default**

In `api/_lib/db.js`, add near the top of the file (with the other `require`s):

```js
const { pickOlderDetractorCandidate, parseDdMmYyyy } = require('./detractorMerge');
```

(`parseDdMmYyyy` isn't used by this task — it's consumed by Task 6's merge sort, which reuses this
same top-level import rather than adding its own.)

Then, immediately before the `// Claims up to maxCount fresh detractor leads...` comment that
precedes `assignDetractorLeadsToAgent`, add:

```js
// Peeks both pools' top candidate and claims whichever wins under the admin's lead-order
// setting (see pickOlderDetractorCandidate) - the single shared-quota merge point every
// auto-assign trigger (going-Online batch-fill, on-disposal self-refill) now goes through by
// default. A pool with nothing left to peek just loses every comparison; no special-casing
// needed for "one pool is empty" beyond what pickOlderDetractorCandidate already does.
async function getNextDetractorLeadEitherPool(email) {
  const sortDirection = (await getCallingLeadOrder('detractor')) === 'newest' ? -1 : 1;
  const [[deliveryCandidate], [productCandidate]] = await Promise.all([
    peekDeliveryDetractorCandidates({ email, limit: 1 }),
    peekProductDetractorCandidates({ email, limit: 1 }),
  ]);
  const pick = pickOlderDetractorCandidate(
    deliveryCandidate && deliveryCandidate.submitted_date,
    productCandidate && productCandidate.submitted_date,
    sortDirection,
  );
  if (pick === 'delivery') return getNextDetractorLead(email);
  if (pick === 'product') return claimOneProductDetractorLead(email);
  return null;
}
```

Then find:

```js
async function assignDetractorLeadsToAgent(email, maxCount, claimFn = getNextDetractorLead) {
```

Change to:

```js
async function assignDetractorLeadsToAgent(email, maxCount, claimFn = getNextDetractorLeadEitherPool) {
```

- [ ] **Step 2: Run the existing pure-logic test to confirm no regression**

Run: `node api/_lib/db.detractorAssign.test.js`
Expected: `db.detractorAssign.test.js: all assertions passed` — this file always passes its own
`claimFn` stub explicitly, so the default's change is invisible to it; this step just confirms the
surrounding edit didn't break the file's syntax/exports.

- [ ] **Step 3: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat(nps-calling): merge both detractor pools behind one auto-assign claim"
```

---

### Task 6: `db.js` — merge both pools in the admin's unassigned-preview

**Files:**
- Modify: `api/_lib/db.js:1984-1997` (`getUnassignedDetractorLeads`)

**Interfaces:**
- Consumes: `peekDeliveryDetractorCandidates`, `peekProductDetractorCandidates` (already return
  enough for a preview row: `response_id`, `submitted_date`, plus delivery's fuller row / product's
  slim row).
- Produces: `getUnassignedDetractorLeads(limit = 20)` keeps its existing signature; each returned
  row now carries `lead_type`.

The existing preview always sorts oldest-first regardless of the admin's lead-order setting (its
`ORDER BY ... ASC` is hardcoded, unlike the claim path) — this task preserves that exact existing
behavior for the merged list rather than changing it, since changing the preview's own ordering
rule is out of scope for this feature.

- [ ] **Step 1: Replace the query with a two-pool merge**

Find:

```js
async function getUnassignedDetractorLeads(limit = 20) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT d.response_id, d.brand, d.channel_order_id, d.customer_name, d.nps_score, d.nps_category,
           d.category, d.sub_category, d.submitted_date
    FROM nps_delivery d
    LEFT JOIN CLS_NPS_calling c ON c.response_id = d.response_id
    WHERE d.nps_category = 'Detractor' AND c.response_id IS NULL
      AND STR_TO_DATE(d.submitted_date, '%d/%m/%Y') >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    ORDER BY STR_TO_DATE(d.submitted_date, '%d/%m/%Y') ASC
    LIMIT ${limit}
  `;
  return rows;
}
```

Replace with:

```js
async function getUnassignedDetractorLeads(limit = 20) {
  await ensureSchema();
  const { rows: deliveryRows } = await sql`
    SELECT d.response_id, d.brand, d.channel_order_id, d.customer_name, d.nps_score, d.nps_category,
           d.category, d.sub_category, d.submitted_date
    FROM nps_delivery d
    LEFT JOIN CLS_NPS_calling c ON c.response_id = d.response_id
    WHERE d.nps_category = 'Detractor' AND c.response_id IS NULL
      AND STR_TO_DATE(d.submitted_date, '%d/%m/%Y') >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    ORDER BY STR_TO_DATE(d.submitted_date, '%d/%m/%Y') ASC
    LIMIT ${limit}
  `;
  const { rows: productRows } = await sql`
    SELECT p.response_id, MIN(p.brand) AS brand, NULL AS channel_order_id, MIN(p.customer_name) AS customer_name,
           MIN(p.overall_nps_score) AS nps_score, MIN(p.nps_category) AS nps_category,
           MIN(p.category) AS category, MIN(p.sub_category) AS sub_category, MIN(p.submitted_date) AS submitted_date
    FROM nps_product p
    LEFT JOIN CLS_NPS_calling c ON c.response_id = p.response_id
    WHERE c.response_id IS NULL
      AND STR_TO_DATE(p.submitted_date, '%d/%m/%Y') >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    GROUP BY p.response_id
    HAVING MIN(p.nps_category) = 'Detractor'
    ORDER BY MIN(p.submitted_date) ASC
    LIMIT ${limit}
  `;
  // Same convention this function already used for its own single-pool query: submitted_date is
  // DD/MM/YYYY text, so a plain string sort is wrong (see parseDdMmYyyy in ./detractorMerge for
  // why) - both lists are re-sorted together on their PARSED date, oldest-first, matching this
  // function's existing (hardcoded, lead-order-independent) behavior. parseDdMmYyyy is already
  // imported at module scope by Task 5.
  const tagged = [
    ...deliveryRows.map((r) => ({ ...r, lead_type: 'delivery' })),
    ...productRows.map((r) => ({ ...r, lead_type: 'product' })),
  ];
  tagged.sort((a, b) => (parseDdMmYyyy(a.submitted_date) || 0) - (parseDdMmYyyy(b.submitted_date) || 0));
  return tagged.slice(0, limit);
}
```

- [ ] **Step 2: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat(nps-calling): merge both detractor pools in the unassigned-leads preview"
```

---

### Task 7: `db.js` — `leadType` scoping on the five disposition functions

**Files:**
- Modify: `api/_lib/db.js:4088-4137` (`getProcessDispositions`)
- Modify: `api/_lib/db.js:4142-4176` (`addProcessDisposition`)
- Modify: `api/_lib/db.js:4177-4217` (`updateProcessDisposition`)
- Modify: `api/_lib/db.js:4218-4235` (`deleteProcessDisposition`)
- Modify: `api/_lib/db.js:4236-4260ish` (`reorderProcessDispositions`)
- Modify: `api/_lib/db.js` (`exports`)

**Interfaces:**
- Produces: all five functions gain a trailing `leadType = null` parameter, exactly mirroring the
  existing `teamId = null` parameter already on each — same position (after `teamId`), same `NULL`
  = shared/fallback convention. Consumed by Task 8 (`api/admin/[action].js`) and Task 9
  (`app/_calling/CallingAdminPanel.js`).

Each function already scopes every statement on `(process_key, team_id)`; this task adds
`lead_type` as a second, independent scope resolved the same "specific rows if any, else NULL
rows" way `team_id` already is, applied AFTER team resolution (so a process that never splits by
team — true of `'detractor'` today — behaves exactly as if only `lead_type` existed).

- [ ] **Step 1: `getProcessDispositions`**

Find:

```js
async function getProcessDispositions(processKey, teamId = null) {
  await ensureSchema();
  if (!processKey) return [];
  // sql() executes eagerly (it's `await p.execute(...)` inside, not a lazy fragment builder), so
  // a nested `${sql\`...\`}` fragment would stringify a Promise into the outer query text - two
  // separate literal queries instead of building SQL by concatenation.
  const fetchRows = async (team) => (team == null
    ? (await sql`
        SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
        WHERE process_key = ${processKey} AND team_id IS NULL
        ORDER BY sort_order ASC, id ASC`).rows
    : (await sql`
        SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
        WHERE process_key = ${processKey} AND team_id = ${team}
        ORDER BY sort_order ASC, id ASC`).rows);
  let rows;
  try {
    rows = await fetchRows(teamId);
    if (!rows.length && teamId != null) rows = await fetchRows(null);
  } catch (e) {
    // Unlike the release-1 team-isolation softening (api/_lib/callingTeams.js), this migration
    // is NOT order-independent: the column can be deployed before the api/ code that selects it
    // is live. Rather than require a strict deploy order, retry as a plain pre-migration read
    // (no team_id predicate - the column doesn't exist yet, so there is no team to filter by).
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    rows = (await sql`
      SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
      WHERE process_key = ${processKey}
      ORDER BY sort_order ASC, id ASC`).rows;
  }
```

Replace with:

```js
async function getProcessDispositions(processKey, teamId = null, leadType = null) {
  await ensureSchema();
  if (!processKey) return [];
  // sql() executes eagerly (it's `await p.execute(...)` inside, not a lazy fragment builder), so
  // a nested `${sql\`...\`}` fragment would stringify a Promise into the outer query text - two
  // separate literal queries instead of building SQL by concatenation.
  const fetchRows = async (team, type) => (team == null
    ? (type == null
        ? (await sql`
            SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
            WHERE process_key = ${processKey} AND team_id IS NULL AND lead_type IS NULL
            ORDER BY sort_order ASC, id ASC`).rows
        : (await sql`
            SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
            WHERE process_key = ${processKey} AND team_id IS NULL AND lead_type = ${type}
            ORDER BY sort_order ASC, id ASC`).rows)
    : (type == null
        ? (await sql`
            SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
            WHERE process_key = ${processKey} AND team_id = ${team} AND lead_type IS NULL
            ORDER BY sort_order ASC, id ASC`).rows
        : (await sql`
            SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
            WHERE process_key = ${processKey} AND team_id = ${team} AND lead_type = ${type}
            ORDER BY sort_order ASC, id ASC`).rows));
  let rows;
  try {
    // Team resolves first (unchanged), then within that team scope, lead_type resolves the same
    // "specific rows if any, else the type-shared (lead_type IS NULL) rows" way - two
    // independent, sequential fallbacks rather than one combined rule, so a process that never
    // splits by team (every process today) behaves exactly as if only lead_type existed.
    rows = await fetchRows(teamId, leadType);
    if (!rows.length && leadType != null) rows = await fetchRows(teamId, null);
    if (!rows.length && teamId != null) rows = await fetchRows(null, leadType);
    if (!rows.length && teamId != null && leadType != null) rows = await fetchRows(null, null);
  } catch (e) {
    // Unlike the release-1 team-isolation softening (api/_lib/callingTeams.js), this migration
    // is NOT order-independent: the column can be deployed before the api/ code that selects it
    // is live. Rather than require a strict deploy order, retry as a plain pre-migration read
    // (no team_id/lead_type predicate - neither column exists yet, so there is nothing to filter
    // by).
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    rows = (await sql`
      SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
      WHERE process_key = ${processKey}
      ORDER BY sort_order ASC, id ASC`).rows;
  }
```

Leave the rest of the function (the two-pass parent/child tree build) unchanged.

- [ ] **Step 2: `addProcessDisposition`**

Find:

```js
async function addProcessDisposition(processKey, label, description, createdBy, parentId, teamId = null) {
```

Change its signature to:

```js
async function addProcessDisposition(processKey, label, description, createdBy, parentId, teamId = null, leadType = null) {
```

Find the parent-scope check:

```js
      ? await sql`SELECT id FROM calling_process_dispositions WHERE id = ${parent} AND process_key = ${processKey} AND team_id IS NULL`
      : await sql`SELECT id FROM calling_process_dispositions WHERE id = ${parent} AND process_key = ${processKey} AND team_id = ${teamId}`;
```

Change to:

```js
      ? await sql`SELECT id FROM calling_process_dispositions WHERE id = ${parent} AND process_key = ${processKey} AND team_id IS NULL AND (${leadType} IS NULL AND lead_type IS NULL OR lead_type = ${leadType})`
      : await sql`SELECT id FROM calling_process_dispositions WHERE id = ${parent} AND process_key = ${processKey} AND team_id = ${teamId} AND (${leadType} IS NULL AND lead_type IS NULL OR lead_type = ${leadType})`;
```

Apply the same `AND (${leadType} IS NULL AND lead_type IS NULL OR lead_type = ${leadType})`
addition to both `sort_order` lookup queries just below (the `parentId` and no-`parentId`
branches), and add `lead_type` to the final `INSERT`:

Find:

```js
    INSERT INTO calling_process_dispositions (process_key, team_id, parent_id, label, description, sort_order, created_by)
```

Change to:

```js
    INSERT INTO calling_process_dispositions (process_key, team_id, lead_type, parent_id, label, description, sort_order, created_by)
```

and add `${leadType}` into that `INSERT`'s `VALUES` list at the matching position (right after the
`team_id` value).

Finally, update this function's own call to `getProcessDispositions` at its end (the line that
returns the refreshed list) to pass `leadType` through as its third argument.

- [ ] **Step 3: `updateProcessDisposition`, `deleteProcessDisposition`, `reorderProcessDispositions`**

Apply the identical pattern to each: add a trailing `leadType = null` parameter; add
`AND (${leadType} IS NULL AND lead_type IS NULL OR lead_type = ${leadType})` to every `WHERE`
clause that already has `AND (team_id IS NULL OR team_id = ${teamId})`-style scoping; pass
`leadType` through to whatever call each makes to `getProcessDispositions` to build its return
value.

- [ ] **Step 4: Update `exports`**

Find:

```js
  getProcessDispositions, addProcessDisposition, updateProcessDisposition,
  deleteProcessDisposition, reorderProcessDispositions,
```

(These function names are unchanged — only their signatures gained a parameter — so `exports`
itself needs no edit here. This step is a checklist item to confirm that, not a code change.)

- [ ] **Step 5: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat(nps-calling): add leadType scoping to disposition-tree functions"
```

---

### Task 8: `api/admin/[action].js` — resolve and pass `leadType`

**Files:**
- Modify: `api/admin/[action].js:692-798` (`handleDispositions`)

**Interfaces:**
- Consumes: Task 7's five updated `db.js` functions.
- Produces: `GET /api/admin/dispositions?process=detractor&leadType=product` and
  `POST/PUT/DELETE` bodies carrying `leadType` now select/write the Product tree. Consumed by
  Task 9.

Per the spec, `leadType` needs no per-role restriction beyond the existing
`isProcessAdmin`/team-lock checks already in this function (a free-form value, not a permission
boundary) — it is simply read straight from the request, same trust level `teamId` already gets
for a full admin.

- [ ] **Step 1: Resolve `leadType` alongside `teamId`**

Find:

```js
  const dispTeamId = dispositionTeamFor({
    callerTeamId,
    activeTeamCount,
    explicitTeamId: coerceTeamId(req.method === 'GET' ? (req.query && req.query.teamId) : body.teamId),
    isAdmin: !!session.isAdmin,
  });
```

Add immediately after:

```js
  // No per-role resolution needed (unlike teamId, which is DERIVED for a non-admin so a Team
  // Lead can't target another team) - lead_type isn't a permission boundary, just which of two
  // admin-configurable trees this request means. 'product' or nothing (-> shared/Delivery tree).
  const rawLeadType = req.method === 'GET' ? (req.query && req.query.leadType) : body.leadType;
  const dispLeadType = rawLeadType === 'product' ? 'product' : null;
```

- [ ] **Step 2: Pass it to all five call sites**

Find each of these four calls and add `, dispLeadType` as the trailing argument:

```js
      const dispositions = await addProcessDisposition(body.processKey, body.label, body.description, session.email, body.parentId, dispTeamId);
```
→
```js
      const dispositions = await addProcessDisposition(body.processKey, body.label, body.description, session.email, body.parentId, dispTeamId, dispLeadType);
```

```js
        ? await reorderProcessDispositions(body.processKey, body.parentId, body.orderedIds, dispTeamId)
        : await updateProcessDisposition(body.processKey, body.id, { label: body.label, description: body.description, childrenInputType: body.childrenInputType }, dispTeamId);
```
→
```js
        ? await reorderProcessDispositions(body.processKey, body.parentId, body.orderedIds, dispTeamId, dispLeadType)
        : await updateProcessDisposition(body.processKey, body.id, { label: body.label, description: body.description, childrenInputType: body.childrenInputType }, dispTeamId, dispLeadType);
```

```js
    const dispositions = await deleteProcessDisposition(body.processKey, body.id, dispTeamId);
```
→
```js
    const dispositions = await deleteProcessDisposition(body.processKey, body.id, dispTeamId, dispLeadType);
```

```js
  res.status(200).json({ dispositions: await getProcessDispositions(processKey, dispTeamId) });
```
→
```js
  res.status(200).json({ dispositions: await getProcessDispositions(processKey, dispTeamId, dispLeadType) });
```

- [ ] **Step 3: Commit**

```bash
git add "api/admin/[action].js"
git commit -m "feat(nps-calling): resolve and pass leadType through the dispositions endpoint"
```

---

### Task 9: `CallingAdminPanel.js` — `leadType` option on `useProcessDispositions`

**Files:**
- Modify: `app/_calling/CallingAdminPanel.js:646-831` (`useProcessDispositions`)

**Interfaces:**
- Consumes: Task 8's updated `/api/admin/dispositions` endpoint.
- Produces: `useProcessDispositions(processKey, { googleUser, showToast, teamId, leadType })` — the
  hook's returned object gains a `leadType` field (mirroring its existing `teamId` field).
  Consumed by Task 10 (`NpsCallingClient.js`); every other caller of this hook (NDR, Escalation)
  keeps working unchanged since `leadType` defaults to `null`.

- [ ] **Step 1: Thread `leadType` through the hook, mirroring every existing `teamId` use**

Find:

```js
export function useProcessDispositions(processKey, { googleUser, showToast, teamId = null } = {}) {
```

Change to:

```js
export function useProcessDispositions(processKey, { googleUser, showToast, teamId = null, leadType = null } = {}) {
```

Find:

```js
  const loadDispositions = useCallback(async (key, team) => {
    if (!key) return;
    setProcessDispositions(null);
    setDispositionsError('');
    try {
      // teamId is honoured server-side only for a full admin - an agent or team lead gets their
      // own team's tree regardless of what is sent here, so this is a UI affordance, not a
      // permission.
      const teamQuery = team != null ? `&teamId=${encodeURIComponent(team)}` : '';
      const r = await fetch(`/api/admin/dispositions?process=${encodeURIComponent(key)}${teamQuery}`);
```

Change to:

```js
  const loadDispositions = useCallback(async (key, team, type) => {
    if (!key) return;
    setProcessDispositions(null);
    setDispositionsError('');
    try {
      // teamId is honoured server-side only for a full admin - an agent or team lead gets their
      // own team's tree regardless of what is sent here, so this is a UI affordance, not a
      // permission.
      const teamQuery = team != null ? `&teamId=${encodeURIComponent(team)}` : '';
      const typeQuery = type != null ? `&leadType=${encodeURIComponent(type)}` : '';
      const r = await fetch(`/api/admin/dispositions?process=${encodeURIComponent(key)}${teamQuery}${typeQuery}`);
```

Find:

```js
  useEffect(() => {
    if (googleUser?.email) loadDispositions(processKey, teamId);
  }, [googleUser, processKey, teamId, loadDispositions]);
```

Change to:

```js
  useEffect(() => {
    if (googleUser?.email) loadDispositions(processKey, teamId, leadType);
  }, [googleUser, processKey, teamId, leadType, loadDispositions]);
```

In `addDisposition`, `saveDispositionEdit`, `deleteDisposition`, and `moveDisposition`, find each
occurrence of:

```js
...(teamId != null ? { teamId } : {}) }),
```

and change it to:

```js
...(teamId != null ? { teamId } : {}), ...(leadType != null ? { leadType } : {}) }),
```

(There are four such occurrences — one per function — each inside that function's own
`JSON.stringify({...})` call.)

In `moveDisposition`'s failure branch and `deleteDisposition`'s implicit reload (search for
`loadDispositions(processKey, teamId)`), change both call sites to
`loadDispositions(processKey, teamId, leadType)`.

Find the hook's return statement:

```js
  return {
    processDispositions, dispositionsError, savingDisposition,
    newDispLabel, setNewDispLabel, newDispDesc, setNewDispDesc,
    expandedDispIds, toggleDispExpanded, newChildDrafts, setNewChildDrafts,
    addDisposition, saveDispositionEdit, deleteDisposition, moveDisposition,
    teamId,
  };
```

Change to:

```js
  return {
    processDispositions, dispositionsError, savingDisposition,
    newDispLabel, setNewDispLabel, newDispDesc, setNewDispDesc,
    expandedDispIds, toggleDispExpanded, newChildDrafts, setNewChildDrafts,
    addDisposition, saveDispositionEdit, deleteDisposition, moveDisposition,
    teamId, leadType,
  };
```

- [ ] **Step 2: Commit**

```bash
git add app/_calling/CallingAdminPanel.js
git commit -m "feat(nps-calling): add leadType option to useProcessDispositions"
```

---

### Task 10: `NpsCallingClient.js` — Product ticket fields, type badge, dual disposition trees

**Files:**
- Modify: `app/nps-calling/NpsCallingClient.js:30-180` (`AREAS`, `TicketSurveyDetails`)
- Modify: `app/nps-calling/NpsCallingClient.js:286-289` (admin `disp` hook + new Lead Type toggle
  state)
- Modify: `app/nps-calling/NpsCallingClient.js:426-429` (`visibleDispositionNodes`)
- Modify: `app/nps-calling/NpsCallingClient.js:894-896` (admin panel render)
- Modify: `app/nps-calling/NpsCallingClient.js` (ticket row render, near line 577 — add a type
  badge)

**Interfaces:**
- Consumes: Task 9's `leadType`-aware `useProcessDispositions`; `t.lead_type` on every ticket
  returned by `api/detractor/tickets.js` (already `SELECT *`, so it's there automatically once
  Task 2/4 ship).

Task 4 wrote `nps_product`'s per-product ratings into `CLS_NPS_calling`'s
`product_results`/`product_texture`/`product_fragrance`/`product_packaging_rating`/
`product_skin_type`/`product_nps` columns — this task renders them, in place of Delivery's
`AREAS`-driven blocks, for a `lead_type === 'product'` ticket.

- [ ] **Step 1: Add a `PRODUCT_AREAS`-equivalent config and branch `TicketSurveyDetails` on `t.lead_type`**

Find:

```js
const AREAS = [
```

Add immediately before it:

```js
// Product-lead equivalent of AREAS: nps_product has no promoter/passive/detractor reason buckets
// (unlike nps_delivery) - just five per-product ratings, plus product_nps (that product's own
// 0-10 score, distinct from the survey-level nps_score every ticket already carries). Order
// matches nps_product's own column order.
const PRODUCT_RATING_FIELDS = [
  { label: 'Product NPS', field: 'product_nps' },
  { label: 'Results', field: 'product_results' },
  { label: 'Texture', field: 'product_texture' },
  { label: 'Fragrance', field: 'product_fragrance' },
  { label: 'Packaging', field: 'product_packaging_rating' },
  { label: 'Skin type', field: 'product_skin_type' },
];
```

Then find:

```js
      <div className="space-y-2">
        {AREAS.map(({ label, rating, reach, buckets }) => {
```

Change to:

```js
      <div className="space-y-2">
        {t.lead_type === 'product' ? (
          PRODUCT_RATING_FIELDS.filter(({ field }) => hasValue(t[field])).map(({ label, field }) => (
            <p key={field} className="text-[12px] text-zinc-300">
              <span className="font-semibold text-zinc-200">{label}:</span> {t[field]}
            </p>
          ))
        ) : AREAS.map(({ label, rating, reach, buckets }) => {
```

(The existing `.map` body, and the `{hasValue(t.additional_feedback) && (...)}` block right after
the `AREAS.map(...)` closes, both stay exactly as they are — `additional_feedback`,
`category`/`sub_category`, and `product_name_list` are rendered by the generic blocks above this
one, which are not gated on `lead_type` at all today and need no change for either ticket type.)

- [ ] **Step 2: Add a type badge to `TicketSurveyDetails`' header block**

Find:

```js
        {(t.category || t.sub_category) && (
          <p className="text-[12px] text-zinc-400">{[t.category, t.sub_category].filter(Boolean).join(' · ')}</p>
        )}
```

Change to:

```js
        <p className="text-[11px] font-bold uppercase tracking-wide text-indigo-300">
          {t.lead_type === 'product' ? 'Product' : 'Delivery'}
        </p>

        {(t.category || t.sub_category) && (
          <p className="text-[12px] text-zinc-400">{[t.category, t.sub_category].filter(Boolean).join(' · ')}</p>
        )}
```

This one change covers both places `TicketSurveyDetails` is rendered (the ticket-list row at line
577 and the dispose modal at line 1035) — it is a single shared component, so no separate badge
needs adding to the row markup itself.

- [ ] **Step 3: Give the admin's disposition editor a Lead Type toggle**

Find:

```js
  const disp = useProcessDispositions(PROCESS_KEY, { googleUser, showToast });
  const { processDispositions } = disp;
```

Change to:

```js
  // Which tree the Admin Panel's Disposition List editor is currently showing/editing - null
  // (Delivery, today's shared tree) or 'product'. Independent of any ticket's own lead_type;
  // an admin picks this explicitly to configure either tree.
  const [adminDispLeadType, setAdminDispLeadType] = useState(null);
  const disp = useProcessDispositions(PROCESS_KEY, { googleUser, showToast, leadType: adminDispLeadType });
  const { processDispositions } = disp;
```

- [ ] **Step 4: Give the dispose modal its own tree, scoped to the open ticket's `lead_type`**

Find:

```js
  const visibleDispositionNodes = useMemo(() => {
```

Add immediately before it (still inside the component, after `detailTkt`'s own declaration —
`detailTkt` already exists earlier in this component as the currently-open ticket's state):

```js
  // Independent of the admin's own disp/adminDispLeadType above - an agent (who never sees the
  // Admin Panel) still needs whichever tree matches the TICKET they're disposing, not whatever
  // the admin toggle above happens to be set to.
  const dispForTicket = useProcessDispositions(PROCESS_KEY, {
    googleUser, showToast,
    leadType: detailTkt && detailTkt.lead_type === 'product' ? 'product' : null,
  });
```

Then find:

```js
  const visibleDispositionNodes = useMemo(() => {
    // ... (existing comment)
    return (processDispositions || []).filter((n) => n.label === (branchChoice === 'Yes' ? 'Connected' : 'Non Connected'));
  }, [processDispositions, branchChoice]);
```

Change the body's `processDispositions` reference to `dispForTicket.processDispositions`, and its
dependency array to match:

```js
  const visibleDispositionNodes = useMemo(() => {
    // ... (existing comment, unchanged)
    return (dispForTicket.processDispositions || []).filter((n) => n.label === (branchChoice === 'Yes' ? 'Connected' : 'Non Connected'));
  }, [dispForTicket.processDispositions, branchChoice]);
```

- [ ] **Step 5: Add the toggle control to the admin panel render**

Find:

```js
                  <ProcessDispositionsCard processLabel="NPS-Calling" disp={disp} allowInputTypeControl />
```

Change to:

```js
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[12px] text-zinc-400 font-semibold">Editing tree:</span>
                    <button
                      type="button"
                      onClick={() => setAdminDispLeadType(null)}
                      className={`px-3 py-1 rounded-lg text-[12px] font-bold border ${
                        adminDispLeadType == null ? 'bg-indigo-600 border-indigo-500 text-white' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                      }`}
                    >
                      Delivery
                    </button>
                    <button
                      type="button"
                      onClick={() => setAdminDispLeadType('product')}
                      className={`px-3 py-1 rounded-lg text-[12px] font-bold border ${
                        adminDispLeadType === 'product' ? 'bg-indigo-600 border-indigo-500 text-white' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                      }`}
                    >
                      Product
                    </button>
                  </div>
                  <ProcessDispositionsCard
                    processLabel={`NPS-Calling${adminDispLeadType === 'product' ? ' · Product' : ''}`}
                    disp={disp}
                    allowInputTypeControl
                  />
```

- [ ] **Step 6: Commit**

```bash
git add app/nps-calling/NpsCallingClient.js
git commit -m "feat(nps-calling): show lead type on tickets and split the disposition editor"
```

---

## Post-plan manual verification (user performs, per this repo's no-live-testing convention)

1. Run `python scripts/migrate_nps_calling_lead_type.py --apply` against the live database, before
   deploying `api/`.
2. Confirm a Detractor `nps_product` response not present in `nps_delivery` becomes claimable and
   shows up in an agent's queue tagged "Product".
3. Disposing a Product ticket offers only whatever tree the admin configured under the Product
   toggle; disposing a Delivery ticket is unaffected.
4. Admin Panel → NPS-Calling → Disposition List shows the Delivery/Product toggle; RTO/NDR/
   Escalation panels are unchanged (they never pass `leadType`, so nothing about them can regress).
5. Going Online / self-refill still fills to quota with a mix of both types, oldest lead first
   (or newest, per the existing lead-order setting) regardless of source table.
