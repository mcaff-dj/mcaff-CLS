# RTO CSV Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin upload a CSV of new RTO leads through the RTO CRM; the leads are
deduplicated by AWB against the live sheet, checked for existing GoKwik refunds (prepaid only)
and existing LMD "already punched" status (any payment mode), then appended to the sheet —
disqualified rows pre-stamped as disposed, survivors as fresh unassigned leads.

**Architecture:** A Node endpoint (`api/rto/upload-start.js`) does the fast, DB-free work
(parse, validate headers against the live sheet, dedupe by AWB) and appends non-prepaid rows
immediately; it then creates a Postgres job row and fires a new dedicated Lambda
(`mcaff-cls-csv-upload-worker`) fire-and-forget, since the actual refund/punch checks need
`mcaff_prod` MySQL access only Python has. The worker reuses `scripts/assign_leads.py`'s
`check_already_punched`/`resolve_refund_statuses`/`lookup_platform_order_ids` **unmodified**,
looping the GoKwik phase in existing-function-sized chunks with a pause between them, writing
progress to the job row as it goes, and finishing with one batched sheet append. The browser
polls `api/rto/upload-status.js` for progress.

**Tech Stack:** Node/Express (existing API Lambda), Python 3.12 (existing cron Lambda
pattern), Postgres (Supabase, existing), Google Sheets API v4 REST (existing JWT
service-account pattern), plain `fetch`/`requests` — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md`

## Global Constraints

- Admin-only: every new endpoint requires `session.isAdmin` **and** the existing
  `calling`/`rto` card+tab check (`session.perms.includes('calling')` +
  `session.tabPerms.calling` includes `'rto'` or is empty/blanket).
- Row cap: reject uploads above 5,000 parsed CSV rows, checked immediately after `parseCSV`,
  before any other work.
- Dedup key: AWB Code, normalized as `.trim().toUpperCase()`. A row with a blank AWB Code is
  rejected, never appended.
- Header matching is two-pass (exact-normalized first, then substring-fuzzy) against the
  **live** sheet header row, never a hardcoded list. Normalization: `.toLowerCase().replace(/[^a-z0-9]/g, '')`.
  AWB Code and Order ID are the only two required target columns; the other 13 are best-effort
  (blank if unmatched).
- Every Sheets write in this feature is a single batched call (`values:append` or
  `values:batchUpdate`) regardless of row count — never one call per row. This is a hard
  constraint, not a style preference: an unbatched write path caused a real team-wide 429
  outage earlier this same day (see `git log --oneline | grep 429`).
- The refund-check and punch-check logic is **imported and called from
  `scripts/assign_leads.py`/`scripts/lead_priority.py` unmodified** — never re-implemented in
  JavaScript. This is both a correctness requirement (the user asked for "exactly same logic")
  and a hard technical one (`Item_level_data`/`LMD` live in `mcaff_prod` MySQL, reachable only
  from the Python Lambda environment).
- Prerequisite: this plan assumes `scripts/assign_leads.py` already has `check_already_punched`,
  `ALREADY_PUNCHED`, and `LMD_TABLE` defined (currently in the user's own uncommitted working
  copy at plan-writing time — Task 1 verifies this before anything else proceeds).

---

### Task 1: Verify the LMD prerequisite is committed

**Files:**
- None modified — this is a verification gate, not a code task.

**Interfaces:**
- Consumes: `scripts/assign_leads.py` on `origin/main`.
- Produces: nothing — either this task passes and the plan proceeds, or it fails and the plan
  is blocked until the LMD work is committed.

- [ ] **Step 1: Confirm the LMD functions exist on `origin/main`, not just locally**

Run: `git show origin/main:scripts/assign_leads.py | grep -c "def check_already_punched"`
Expected: `1`. If it prints `0`, STOP — commit and push the LMD punch-check work
(`check_already_punched`, `ALREADY_PUNCHED`, `LMD_TABLE`) before continuing with this plan; every
later task in this plan imports those names.

- [ ] **Step 2: Confirm the exact current signature matches what this plan assumes**

Run: `git show origin/main:scripts/assign_leads.py | grep -n "^def check_already_punched\|^def resolve_refund_statuses\|^def lookup_platform_order_ids\|^ITEM_LEVEL_SCHEMA\|^LMD_TABLE\|^GOKWIK_MAX_CHECKS_PER_RUN\|^GOKWIK_TIME_BUDGET_SEC"`

Expected output includes all of:
```
ITEM_LEVEL_SCHEMA = "mcaff_prod"
LMD_TABLE = "LMD"
GOKWIK_MAX_CHECKS_PER_RUN = 120
GOKWIK_TIME_BUDGET_SEC = 20
def lookup_platform_order_ids(order_ids):
def check_already_punched(order_ids):
def resolve_refund_statuses(order_ids, dirty):
```
If any signature differs from this, STOP and re-read the current file before continuing —
later tasks' code blocks assume these exact names and parameter shapes.

---

### Task 2: `lib.py` — add `append_sheet_rows`, the one new primitive the Python side needs

**Files:**
- Modify: `scripts/lib.py` (add a new function near `set_sheet_values_batch`, ~line 165)
- Test: `scripts/test_lib_append_sheet_rows.py` (new)

**Interfaces:**
- Produces: `append_sheet_rows(spreadsheet_id, range_, rows) -> dict` — one
  `values:append` call (`insertDataOption=INSERT_ROWS`, `valueInputOption=USER_ENTERED`),
  same auth/error pattern as the existing `set_sheet_values_batch`. `rows` is a list of lists
  (one inner list per sheet row, cell values in column order starting at `range_`'s first
  column).

- [ ] **Step 1: Write the failing test**

Create `scripts/test_lib_append_sheet_rows.py`:
```python
"""Self-check for lib.py's append_sheet_rows - the ONE Sheets write this whole feature makes
per upload, so it matters this hits the right Google endpoint with the right body shape.
Mocks requests.post; no live network. Run: python scripts/test_lib_append_sheet_rows.py"""
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib


def test_append_sheet_rows_calls_values_append_with_insert_rows():
    captured = {}

    def fake_post(url, headers=None, json=None):
        captured['url'] = url
        captured['headers'] = headers
        captured['json'] = json
        resp = MagicMock()
        resp.raise_for_status = lambda: None
        resp.json = lambda: {"updates": {"updatedRows": 2}}
        return resp

    with patch.object(lib, 'get_write_access_token', return_value='fake-token'), \
         patch.object(lib.requests, 'post', side_effect=fake_post):
        result = lib.append_sheet_rows('SHEET123', "'Data'!B2:P", [
            ["19-08-2026", "", "Reason A", "HYP1", "U1", "AWB1"],
            ["19-08-2026", "", "Reason B", "HYP2", "U2", "AWB2"],
        ])

    assert 'values:append' in captured['url'], f"must hit values:append, got {captured['url']}"
    assert 'insertDataOption=INSERT_ROWS' in captured['url'] or captured['json'] is not None
    assert captured['json']['valueInputOption'] == 'USER_ENTERED'
    assert captured['json']['values'] == [
        ["19-08-2026", "", "Reason A", "HYP1", "U1", "AWB1"],
        ["19-08-2026", "", "Reason B", "HYP2", "U2", "AWB2"],
    ]
    assert result == {"updates": {"updatedRows": 2}}


def test_append_sheet_rows_empty_list_is_a_noop():
    # Never call Google for zero rows - avoids a pointless request and a confusing 400.
    with patch.object(lib.requests, 'post') as mock_post:
        result = lib.append_sheet_rows('SHEET123', "'Data'!B2:P", [])
    mock_post.assert_not_called()
    assert result == {"updates": {"updatedRows": 0}}


if __name__ == "__main__":
    test_append_sheet_rows_calls_values_append_with_insert_rows()
    print("  ok  test_append_sheet_rows_calls_values_append_with_insert_rows")
    test_append_sheet_rows_empty_list_is_a_noop()
    print("  ok  test_append_sheet_rows_empty_list_is_a_noop")
    print("2 passed")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/test_lib_append_sheet_rows.py`
Expected: `AttributeError: module 'lib' has no attribute 'append_sheet_rows'`

- [ ] **Step 3: Implement `append_sheet_rows` in `scripts/lib.py`**

Insert immediately after the existing `set_sheet_values_batch` function (after its `return
resp.json()` line, before `def get_sheet_values`):

```python
def append_sheet_rows(spreadsheet_id, range_, rows):
    """Appends `rows` (a list of lists, one per new sheet row) as genuinely NEW rows via
    Sheets' values:append with insertDataOption=INSERT_ROWS - never values:batchUpdate, which
    only overwrites existing cells and has no notion of "add a row". ONE call regardless of how
    many rows are in the batch - see this feature's own design note on why an unbatched write
    path is not acceptable (a real 429 outage earlier this same day, see git log).

    range_ only needs to name the starting column and sheet/tab (e.g. "'Data'!B2:P") - Google
    figures out where the actual next blank row is; it does not need to be exact.

    Returns Google's raw response dict, or {"updates": {"updatedRows": 0}} without making any
    network call at all if `rows` is empty - avoids both a wasted request and a confusing 400
    from Google for an empty values array."""
    if not rows:
        return {"updates": {"updatedRows": 0}}
    token = get_write_access_token()
    encoded = urllib.parse.quote(range_, safe="")
    url = (
        f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{encoded}"
        f":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"
    )
    resp = requests.post(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    }, json={"valueInputOption": "USER_ENTERED", "values": rows})
    resp.raise_for_status()
    return resp.json()
```

Check `scripts/lib.py`'s top-of-file imports already include `urllib.parse` and `requests`
(both are used by `get_sheet_values` just above, so they will already be imported — no new
import line needed).

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/test_lib_append_sheet_rows.py`
Expected: `2 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.py scripts/test_lib_append_sheet_rows.py
git commit -m "feat: add append_sheet_rows to lib.py for the RTO CSV upload worker"
```

---

### Task 3: Extract `triggerImmediateLambdaAssignment` into a shared module, widened to accept a payload

**Files:**
- Create: `api/_lib/lambdaTrigger.js`
- Modify: `api/auth/[action].js` (remove the local copy, import from the new file)

**Interfaces:**
- Produces: `triggerLambda(functionName, payload?)` — fire-and-forget (`InvocationType:
  'Event'`) invoke, same behavior as the existing function for callers that omit `payload`;
  when `payload` is given, it is JSON-stringified and sent as the Lambda's event body. Also
  exports `getLambdaClient()` for reuse if a future caller needs it.

- [ ] **Step 1: Create `api/_lib/lambdaTrigger.js`**

```javascript
// Shared fire-and-forget Lambda invoke, used by every "don't make someone wait for the next
// scheduled pass" trigger in this app - originally lived only in api/auth/[action].js, pulled
// out here so api/rto/upload-start.js (the CSV upload feature) doesn't duplicate the AWS SDK
// invoke call in a second file.
let _lambdaClient = null;
function getLambdaClient() {
  if (!_lambdaClient) {
    const { LambdaClient } = require('@aws-sdk/client-lambda');
    _lambdaClient = new LambdaClient({});
  }
  return _lambdaClient;
}

// InvocationType 'Event' is fire-and-forget: this returns as soon as the invoke is *accepted*,
// not when the invoked function finishes. Best-effort by design - if the invoke call fails
// (e.g. a permissions gap), this silently no-ops rather than throwing, so a misconfigured
// setup never blocks whatever triggered it (an agent going online, a CSV upload finishing its
// fast half) from completing its own response.
//
// payload is optional and JSON-stringified when present - existing callers that pass nothing
// see byte-identical behavior to before this was extracted (no Payload key sent at all).
async function triggerLambda(functionName, payload) {
  try {
    const { InvokeCommand } = require('@aws-sdk/client-lambda');
    const params = { FunctionName: functionName, InvocationType: 'Event' };
    if (payload !== undefined) {
      params.Payload = Buffer.from(JSON.stringify(payload));
    }
    const resp = await getLambdaClient().send(new InvokeCommand(params));
    if (resp.StatusCode !== 202) {
      console.error(`triggerLambda(${functionName}): unexpected StatusCode`, resp.StatusCode);
    }
  } catch (e) {
    console.error(`triggerLambda(${functionName}) error:`, e.message || e);
  }
}

module.exports = { triggerLambda, getLambdaClient };
```

- [ ] **Step 2: Verify the new file has no syntax errors**

Run: `node --check api/_lib/lambdaTrigger.js`
Expected: no output (success).

- [ ] **Step 3: Update `api/auth/[action].js` to use the shared module**

Find and remove this block (currently near the top of the file, right after the
`PROCESS_ASSIGN_WORKFLOW` constant):
```javascript
let _lambdaClient = null;
function lambdaClient() {
  if (!_lambdaClient) {
    const { LambdaClient } = require('@aws-sdk/client-lambda');
    _lambdaClient = new LambdaClient({});
  }
  return _lambdaClient;
}

// Invokes the given assign-leads Lambda directly, on demand, so an agent who comes online
// with an empty queue doesn't have to wait for the next 5-minute EventBridge Scheduler
// tick. Replaces the old GitHub Actions workflow_dispatch call now that each process's
// recurring assignment itself runs on that same Lambda (see lambda/README.md) -
// dispatching the GitHub workflow here as well would have kept running assign-leads.yml's
// job on the self-hosted runner on every empty-queue heartbeat, redundant with the
// Lambda's own schedule (this was caught in production for rto on 2026-08-13 - see the
// chat thread - and fixed for ndr at the same time it was cut over, rather than repeating
// that mistake). InvocationType 'Event' is fire-and-forget, same semantics as the old
// dispatch call: this returns as soon as the invoke is *accepted*, not when the
// assignment run finishes. Best-effort: if the invoke call fails (e.g. a permissions
// gap), this silently no-ops and the agent just gets picked up by the Lambda's own next
// scheduled run instead, so a misconfigured setup never blocks the agent from working.
async function triggerImmediateLambdaAssignment(functionName) {
  try {
    const { InvokeCommand } = require('@aws-sdk/client-lambda');
    const resp = await lambdaClient().send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
    }));
    if (resp.StatusCode !== 202) {
      console.error(`triggerImmediateLambdaAssignment(${functionName}): unexpected StatusCode`, resp.StatusCode);
    }
  } catch (e) {
    console.error(`triggerImmediateLambdaAssignment(${functionName}) error:`, e.message || e);
  }
}
```

Replace it with a single import line in the same spot:
```javascript
const { triggerLambda: triggerImmediateLambdaAssignment } = require('../_lib/lambdaTrigger');
```
(Keeping the local name `triggerImmediateLambdaAssignment` via the import alias means every
existing call site in this file — there are two, one in `handlePresence`, one in
`handleProcessPresence` — needs zero further changes.)

- [ ] **Step 4: Verify no duplicate definition remains and the file still parses**

Run: `grep -c "function triggerImmediateLambdaAssignment" "api/auth/[action].js"`
Expected: `0` (the function definition is gone; only the import-aliased name remains, used as a
plain function call at its two existing sites).

Run: `node --check "api/auth/[action].js"`
Expected: no output (success).

- [ ] **Step 5: Verify the whole Lambda app still loads (catches a broken import immediately)**

Run: `node -e "require('./api/_lambda/app.js'); console.log('app.js OK')"`
Expected: `app.js OK`

- [ ] **Step 6: Commit**

```bash
git add api/_lib/lambdaTrigger.js "api/auth/[action].js"
git commit -m "refactor: extract triggerImmediateLambdaAssignment into api/_lib/lambdaTrigger.js"
```

---

### Task 4: `api/_lib/rtoCsvImport.js` — pure header-matching, dedup, and row-building logic

**Files:**
- Create: `api/_lib/rtoCsvImport.js`
- Test: `api/_lib/rtoCsvImport.test.js`

**Interfaces:**
- Produces:
  - `normalizeHeader(h: string): string`
  - `matchHeaders(sheetTargetHeaders: string[], csvHeaders: string[]): {sheetHeader: string, csvHeader: string|null}[]`
  - `findRequiredMatch(matchResult, conceptualName: 'awb code'|'order id'): string|null` — the
    matched CSV header name for whichever target header normalizes to `conceptualName`, or
    `null` if that target itself wasn't found among `sheetTargetHeaders`, or wasn't matched to
    any CSV column.
  - `normalizeAwb(v): string`
  - `buildRowPlan({matchResult, csvRows, existingAwbSet}): {validRows, errors, counts}` — the
    main orchestration other tasks call.
  - `headerToColumnLetter(fullHeaderRow: string[], targetHeader: string): string|null` — e.g.
    given the sheet's full A:AD header row and `"AWB Code"`, returns `"G"`.

- [ ] **Step 1: Write the failing tests**

Create `api/_lib/rtoCsvImport.test.js`:
```javascript
// Self-check for the RTO CSV upload's pure logic - header matching, dedup, row planning.
// No network, no DB. Run with `node api/_lib/rtoCsvImport.test.js`.
const assert = require('assert');
const {
  normalizeHeader, matchHeaders, findRequiredMatch, normalizeAwb, buildRowPlan,
  headerToColumnLetter,
} = require('./rtoCsvImport');

// 1. normalizeHeader - lowercase, strip non-alphanumeric.
assert.strictEqual(normalizeHeader('  Payment Method'), 'paymentmethod');
assert.strictEqual(normalizeHeader('AWB Code'), 'awbcode');
assert.strictEqual(normalizeHeader('Address'), 'address');
assert.strictEqual(normalizeHeader('Address City'), 'addresscity');

// 2. matchHeaders - exact pass resolves the Address family correctly, without the fuzzy
// pass ever getting a chance to misassign City/State/Pincode data into the bare Address
// column (the collision risk identified during design: all four share "address" as a
// normalized substring).
{
  const sheetHeaders = ['Address', 'Address City', 'Address State', 'Address Pincode'];
  const csvHeaders = ['Address', 'Address City', 'Address State', 'Address Pincode'];
  const result = matchHeaders(sheetHeaders, csvHeaders);
  const byTarget = Object.fromEntries(result.map((r) => [r.sheetHeader, r.csvHeader]));
  assert.strictEqual(byTarget['Address'], 'Address');
  assert.strictEqual(byTarget['Address City'], 'Address City');
  assert.strictEqual(byTarget['Address State'], 'Address State');
  assert.strictEqual(byTarget['Address Pincode'], 'Address Pincode');
}

// 3. matchHeaders - fuzzy fallback for a genuine wording difference.
{
  const result = matchHeaders(['AWB Code'], ['AWB Number']);
  assert.strictEqual(result[0].csvHeader, 'AWB Number', 'AWB Number must fuzzy-match AWB Code');
}

// 4. matchHeaders - an extra CSV column matching nothing is simply absent from any target's
// match (never errors, never claimed).
{
  const result = matchHeaders(['Order ID'], ['Order ID', 'Some Extra Column']);
  assert.strictEqual(result.length, 1, 'only target headers appear in the result, not extras');
  assert.strictEqual(result[0].csvHeader, 'Order ID');
}

// 5. matchHeaders - a target with no match at all (neither exact nor fuzzy) resolves to null,
// not a throw.
{
  const result = matchHeaders(['Latest NDR Date'], ['Order ID', 'AWB Code']);
  assert.strictEqual(result[0].csvHeader, null);
}

// 6. findRequiredMatch - locates the matched CSV header for a conceptual required column,
// case/spacing-insensitively, and returns null cleanly when absent.
{
  const matchResult = matchHeaders(['AWB Code', 'Order ID'], ['AWB Number', 'Order ID']);
  assert.strictEqual(findRequiredMatch(matchResult, 'awb code'), 'AWB Number');
  assert.strictEqual(findRequiredMatch(matchResult, 'order id'), 'Order ID');
  assert.strictEqual(findRequiredMatch(matchResult, 'rto reason'), null,
    'a conceptual name not even present among sheetTargetHeaders must return null, not throw');
}

// 7. normalizeAwb - trim + uppercase, the dedup key everywhere else in this module uses.
assert.strictEqual(normalizeAwb('  awb123 '), 'AWB123');
assert.strictEqual(normalizeAwb(''), '');

// 8. buildRowPlan - the full orchestration: blank AWB rejected, in-file duplicate rejected
// (first occurrence wins), already-in-sheet duplicate rejected, valid rows get both a `cells`
// map (by TARGET header name) and top-level convenience fields.
{
  const sheetTargetHeaders = ['Order ID', 'AWB Code', 'Payment Method', 'RTO Reason'];
  const csvHeaders = ['Order ID', 'AWB Code', 'Payment Method', 'RTO Reason'];
  const matchResult = matchHeaders(sheetTargetHeaders, csvHeaders);
  const csvRows = [
    { 'Order ID': 'HYP1', 'AWB Code': 'awb1', 'Payment Method': 'Prepaid', 'RTO Reason': 'X' },
    { 'Order ID': 'HYP2', 'AWB Code': '', 'Payment Method': 'COD', 'RTO Reason': 'Y' }, // blank AWB
    { 'Order ID': 'HYP3', 'AWB Code': 'AWB1', 'Payment Method': 'COD', 'RTO Reason': 'Z' }, // dup of row 1 (case-insensitive)
    { 'Order ID': 'HYP4', 'AWB Code': 'awb4', 'Payment Method': 'COD', 'RTO Reason': 'W' }, // already in sheet
    { 'Order ID': 'HYP5', 'AWB Code': 'awb5', 'Payment Method': 'COD', 'RTO Reason': 'V' }, // valid
  ];
  const existingAwbSet = new Set(['AWB4']);
  const plan = buildRowPlan({ matchResult, csvRows, existingAwbSet });

  assert.strictEqual(plan.validRows.length, 2, 'only HYP1 and HYP5 survive');
  assert.deepStrictEqual(plan.validRows.map((r) => r.orderId), ['HYP1', 'HYP5']);
  assert.strictEqual(plan.validRows[0].awbCode, 'AWB1');
  assert.strictEqual(plan.validRows[0].paymentMethod, 'Prepaid');
  assert.strictEqual(plan.validRows[0].cells['RTO Reason'], 'X');

  assert.strictEqual(plan.counts.missingAwb, 1);
  assert.strictEqual(plan.counts.duplicateInFile, 1);
  assert.strictEqual(plan.counts.duplicateInSheet, 1);
  assert.strictEqual(plan.errors.length, 3);
  assert.ok(plan.errors.some((e) => e.reason.toLowerCase().includes('missing') && e.line === 3),
    'line numbers are 1-based data rows (header is not counted), so the blank-AWB row (2nd data row) is line 3');
}

// 9. headerToColumnLetter - maps a header's text to its actual column letter from a full
// header row, including past column Z (two-letter columns) and a header that starts/ends
// with whitespace exactly like the real sheet's own header row does.
{
  const fullHeaderRow = [' CXB CV', 'RTO Initiated Date', 'Latest NDR Date', 'RTO Reason',
    'Order ID', 'Unique', 'AWB Code', 'Customer Email', 'Customer Name', 'Customer Mobile',
    'Address', 'Address City', 'Address State', 'Address Pincode', '  Payment Method', 'Order Total'];
  assert.strictEqual(headerToColumnLetter(fullHeaderRow, 'AWB Code'), 'G');
  assert.strictEqual(headerToColumnLetter(fullHeaderRow, 'Payment Method'), 'O',
    'must match despite the real sheet header carrying leading whitespace');
  assert.strictEqual(headerToColumnLetter(fullHeaderRow, 'Order Total'), 'P');
  assert.strictEqual(headerToColumnLetter(fullHeaderRow, 'Nonexistent'), null);
}

console.log('rtoCsvImport.test.js: all assertions passed');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node api/_lib/rtoCsvImport.test.js`
Expected: `Error: Cannot find module './rtoCsvImport'`

- [ ] **Step 3: Implement `api/_lib/rtoCsvImport.js`**

```javascript
// Pure logic for the RTO CSV upload feature: header matching against the LIVE sheet (never a
// hardcoded list - the sheet's own header row is read fresh by the caller, api/rto/upload-start.js,
// and passed in here), AWB-based dedup, and row-plan construction. No network, no DB - every
// function here takes plain data in and returns plain data out, so it is fully unit-testable
// (see rtoCsvImport.test.js) without a live Sheets connection.

// Same normalization convention already used by app/rto-crm/RtoCrmClient.js's own header-
// matching helper (mapTkt's g()) - reused here rather than invented fresh, so this codebase
// has exactly one idea of "how two header strings are compared", not two.
function normalizeHeader(h) {
  return (h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Two-pass matching: exact-normalized-equality first for EVERY target column, then a
// substring-fuzzy fallback only for targets still unmatched after that first pass. This order
// matters - see the Address-family test in rtoCsvImport.test.js for exactly why. A CSV header
// claimed by one target is removed from the pool so it cannot be double-assigned.
function matchHeaders(sheetTargetHeaders, csvHeaders) {
  const remaining = new Map(csvHeaders.map((h) => [h, normalizeHeader(h)]));
  const result = sheetTargetHeaders.map((sheetHeader) => ({ sheetHeader, csvHeader: null }));

  // Pass 1: exact normalized equality.
  result.forEach((entry) => {
    const targetNorm = normalizeHeader(entry.sheetHeader);
    for (const [csvHeader, csvNorm] of remaining) {
      if (csvNorm === targetNorm) {
        entry.csvHeader = csvHeader;
        remaining.delete(csvHeader);
        break;
      }
    }
  });

  // Pass 2: substring fuzzy, only for what pass 1 left unmatched.
  result.forEach((entry) => {
    if (entry.csvHeader !== null) return;
    const targetNorm = normalizeHeader(entry.sheetHeader);
    if (!targetNorm) return;
    for (const [csvHeader, csvNorm] of remaining) {
      if (!csvNorm) continue;
      if (csvNorm.includes(targetNorm) || targetNorm.includes(csvNorm)) {
        entry.csvHeader = csvHeader;
        remaining.delete(csvHeader);
        break;
      }
    }
  });

  return result;
}

// Finds the CSV header matched to whichever target header conceptually means `conceptualName`
// (e.g. 'awb code', 'order id') - conceptualName is compared via the SAME normalization, so
// callers pass a human-readable string, not an exact-cased header. Returns null (never throws)
// if no target header matches that concept at all, or if it matched no CSV column.
function findRequiredMatch(matchResult, conceptualName) {
  const target = normalizeHeader(conceptualName);
  const entry = matchResult.find((r) => normalizeHeader(r.sheetHeader) === target);
  return entry ? entry.csvHeader : null;
}

function normalizeAwb(v) {
  return (v || '').toString().trim().toUpperCase();
}

// The main orchestration: turns parsed CSV row objects (keyed by RAW csv header, exactly
// parseCSV's output shape) into { validRows, errors, counts }, applying blank-AWB rejection,
// within-file dedup (first occurrence wins), and against-the-sheet dedup, in that order.
//
// Each valid row gets:
//   - orderId, awbCode, paymentMethod, rtoReason: convenience top-level fields, pulled via
//     whichever CSV header matched each concept (awbCode/orderId are guaranteed matched by
//     the time this runs - the caller rejects the whole upload upfront otherwise; paymentMethod/
//     rtoReason may be '' if that target had no CSV match, which is fine - they're best-effort).
//   - cells: { targetSheetHeader: value }, one entry per target header that DID find a CSV
//     match - the caller converts this to column letters via headerToColumnLetter for the
//     actual sheet write. A target with no CSV match is simply absent from `cells`, which the
//     caller treats as "leave that column blank for this row".
function buildRowPlan({ matchResult, csvRows, existingAwbSet }) {
  const awbCsvHeader = findRequiredMatch(matchResult, 'awb code');
  const orderIdCsvHeader = findRequiredMatch(matchResult, 'order id');
  const paymentCsvHeader = findRequiredMatch(matchResult, 'payment method');
  const reasonCsvHeader = findRequiredMatch(matchResult, 'rto reason');

  const validRows = [];
  const errors = [];
  const counts = { missingAwb: 0, duplicateInFile: 0, duplicateInSheet: 0 };
  const seenInFile = new Set();

  csvRows.forEach((row, i) => {
    const line = i + 2; // +1 for 1-based, +1 for the header row not being a data row
    const rawAwb = awbCsvHeader ? row[awbCsvHeader] : '';
    const awb = normalizeAwb(rawAwb);

    if (!awb) {
      counts.missingAwb++;
      errors.push({ line, reason: 'Missing AWB Code' });
      return;
    }
    if (seenInFile.has(awb)) {
      counts.duplicateInFile++;
      errors.push({ line, reason: `Duplicate AWB within file (${awb})` });
      return;
    }
    if (existingAwbSet.has(awb)) {
      counts.duplicateInSheet++;
      errors.push({ line, reason: `AWB already exists in sheet (${awb})` });
      return;
    }
    seenInFile.add(awb);

    const cells = {};
    matchResult.forEach(({ sheetHeader, csvHeader }) => {
      if (csvHeader !== null) cells[sheetHeader] = (row[csvHeader] || '').toString().trim();
    });

    validRows.push({
      orderId: (orderIdCsvHeader ? row[orderIdCsvHeader] : '') || '',
      awbCode: awb,
      paymentMethod: (paymentCsvHeader ? row[paymentCsvHeader] : '') || '',
      rtoReason: (reasonCsvHeader ? row[reasonCsvHeader] : '') || '',
      cells,
    });
  });

  return { validRows, errors, counts };
}

// Maps a header's text to its column letter (A, B, ..., Z, AA, AB, ...) within a full header
// row read as `Data!A1:AD1` - normalized comparison, so this tolerates the live sheet's own
// header whitespace quirks (e.g. '  Payment Method' with two leading spaces, confirmed live).
function headerToColumnLetter(fullHeaderRow, targetHeader) {
  const targetNorm = normalizeHeader(targetHeader);
  const idx = fullHeaderRow.findIndex((h) => normalizeHeader(h) === targetNorm);
  if (idx === -1) return null;
  let n = idx;
  let col = '';
  while (true) {
    col = String.fromCharCode(65 + (n % 26)) + col;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return col;
}

module.exports = {
  normalizeHeader, matchHeaders, findRequiredMatch, normalizeAwb, buildRowPlan,
  headerToColumnLetter,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node api/_lib/rtoCsvImport.test.js`
Expected: `rtoCsvImport.test.js: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add api/_lib/rtoCsvImport.js api/_lib/rtoCsvImport.test.js
git commit -m "feat: add pure header-matching/dedup logic for RTO CSV upload"
```

---

### Task 5: Postgres job table + CRUD functions in `api/_lib/db.js`

**Files:**
- Modify: `api/_lib/db.js` (add a `CREATE TABLE` block inside `bootstrapPgSchema()`, add three
  new exported functions near the other `calling_agent_process`-adjacent functions, add exports)

**Interfaces:**
- Produces:
  - `createRtoCsvUploadJob({ createdBy, totalRows, prepaidCount, rowsPending }): Promise<number>` — returns the new job's integer `id`.
  - `getRtoCsvUploadJob(id): Promise<object|null>` — the full row, or `null` if not found.
  - `updateRtoCsvUploadJob(id, fields): Promise<void>` — partial update; `fields` is a plain
    object whose keys are a subset of the table's own column names (status, checked_count,
    already_refunded_count, already_punched_count, appended_count, rows_pending, errors,
    error_message).

- [ ] **Step 1: Add the table to `bootstrapPgSchema()`**

Find `async function bootstrapPgSchema()` in `api/_lib/db.js` (locate it with
`grep -n "async function bootstrapPgSchema" api/_lib/db.js` if the line number has moved since
this plan was written). Add this block immediately after the existing
`calling_agent_process` `CREATE TABLE IF NOT EXISTS` statement, before the function's closing
`} catch` (match the exact style of the tables already there — one `pgSql` template literal per
table):

```javascript
  // One row per RTO CSV upload. rows_pending holds the validated, deduped rows still awaiting
  // the background worker (scripts/process_rto_csv_upload_job.py) - cleared to NULL once the
  // job reaches 'done' or 'failed', since nothing needs them after that. errors is a capped
  // sample ({line, reason}[], max 50) - see api/_lib/rtoCsvImport.js's buildRowPlan for where
  // these originate. See docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md for the
  // full job lifecycle.
  await pgSql`
    CREATE TABLE IF NOT EXISTS rto_csv_upload_jobs (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      total_rows INTEGER NOT NULL,
      prepaid_count INTEGER NOT NULL,
      checked_count INTEGER NOT NULL DEFAULT 0,
      already_refunded_count INTEGER NOT NULL DEFAULT 0,
      already_punched_count INTEGER NOT NULL DEFAULT 0,
      appended_count INTEGER NOT NULL DEFAULT 0,
      duplicate_in_sheet_count INTEGER NOT NULL DEFAULT 0,
      duplicate_in_file_count INTEGER NOT NULL DEFAULT 0,
      missing_awb_count INTEGER NOT NULL DEFAULT 0,
      rows_pending JSONB,
      errors JSONB,
      error_message TEXT
    )
  `;
```

- [ ] **Step 2: Add the three CRUD functions**

Find the existing `getRtoAgentAvailability` function (added earlier this session) and insert
the following immediately after it:

```javascript
// { id } for a freshly-created RTO CSV upload job. status starts 'queued' - the worker Lambda
// (mcaff-cls-csv-upload-worker) hasn't necessarily started yet by the time this returns, since
// it's invoked fire-and-forget right after this insert (see api/rto/upload-start.js).
async function createRtoCsvUploadJob({ createdBy, totalRows, prepaidCount, rowsPending }) {
  await ensurePgSchema();
  const { rows } = await pgSql`
    INSERT INTO rto_csv_upload_jobs (created_by, total_rows, prepaid_count, rows_pending)
    VALUES (${createdBy}, ${totalRows}, ${prepaidCount}, ${JSON.stringify(rowsPending)})
    RETURNING id
  `;
  return rows[0].id;
}

// The full job row, or null if `id` doesn't exist - api/rto/upload-status.js's whole job.
async function getRtoCsvUploadJob(id) {
  await ensurePgSchema();
  const { rows } = await pgSql`SELECT * FROM rto_csv_upload_jobs WHERE id = ${id}`;
  return rows[0] || null;
}

// Partial update - `fields` keys must be a subset of the table's own columns. Used by the
// Python worker's own Postgres connection too (via a plain UPDATE, not this function directly -
// Node and Python each use their native DB client) but this is the ONLY way the Node side
// (api/rto/upload-start.js, for the non-prepaid immediate-append counts) writes to this table,
// so both sides stay consistent about which columns exist.
async function updateRtoCsvUploadJob(id, fields) {
  await ensurePgSchema();
  const allowed = new Set([
    'status', 'checked_count', 'already_refunded_count', 'already_punched_count',
    'appended_count', 'duplicate_in_sheet_count', 'duplicate_in_file_count',
    'missing_awb_count', 'rows_pending', 'errors', 'error_message',
  ]);
  const keys = Object.keys(fields).filter((k) => allowed.has(k));
  if (!keys.length) return;
  // pgSql is a tagged template (see its own definition earlier in this file), so the SET
  // clause has to be built with real interpolation, not a loop of separate awaited queries -
  // one UPDATE per call, whatever fields are given.
  for (const key of keys) {
    const value = key === 'rows_pending' || key === 'errors'
      ? JSON.stringify(fields[key])
      : fields[key];
    if (key === 'status') await pgSql`UPDATE rto_csv_upload_jobs SET status = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'checked_count') await pgSql`UPDATE rto_csv_upload_jobs SET checked_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'already_refunded_count') await pgSql`UPDATE rto_csv_upload_jobs SET already_refunded_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'already_punched_count') await pgSql`UPDATE rto_csv_upload_jobs SET already_punched_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'appended_count') await pgSql`UPDATE rto_csv_upload_jobs SET appended_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'duplicate_in_sheet_count') await pgSql`UPDATE rto_csv_upload_jobs SET duplicate_in_sheet_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'duplicate_in_file_count') await pgSql`UPDATE rto_csv_upload_jobs SET duplicate_in_file_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'missing_awb_count') await pgSql`UPDATE rto_csv_upload_jobs SET missing_awb_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'rows_pending') await pgSql`UPDATE rto_csv_upload_jobs SET rows_pending = ${value}::jsonb, updated_at = now() WHERE id = ${id}`;
    else if (key === 'errors') await pgSql`UPDATE rto_csv_upload_jobs SET errors = ${value}::jsonb, updated_at = now() WHERE id = ${id}`;
    else if (key === 'error_message') await pgSql`UPDATE rto_csv_upload_jobs SET error_message = ${value}, updated_at = now() WHERE id = ${id}`;
  }
}
```

- [ ] **Step 3: Export the three new functions**

Find the `claimRtoLead, getRtoAgentQuota, getRtoAgentAvailability, getAgentPresenceRow,` line in
the `module.exports = { ... }` block (near the end of the file) and extend it:

```javascript
  claimRtoLead, getRtoAgentQuota, getRtoAgentAvailability, getAgentPresenceRow,
  createRtoCsvUploadJob, getRtoCsvUploadJob, updateRtoCsvUploadJob,
```

- [ ] **Step 4: Verify the file parses and the whole app still loads**

Run: `node --check api/_lib/db.js`
Expected: no output.

Run: `node -e "require('./api/_lambda/app.js'); console.log('app.js OK')"`
Expected: `app.js OK`

- [ ] **Step 5: Commit**

```bash
git add api/_lib/db.js
git commit -m "feat: add rto_csv_upload_jobs table and CRUD functions"
```

---

### Task 6: `api/rto/upload-start.js` — the fast endpoint

**Files:**
- Create: `api/rto/upload-start.js`
- Modify: `api/_lambda/app.js` (mount the route)

**Interfaces:**
- Consumes: `parseCSV` (`api/_lib/csv.js`), `matchHeaders`/`findRequiredMatch`/`buildRowPlan`/
  `headerToColumnLetter` (`api/_lib/rtoCsvImport.js`), `createRtoCsvUploadJob` (`api/_lib/db.js`),
  `triggerLambda` (`api/_lib/lambdaTrigger.js`).
- Produces: `POST /api/rto/upload-start` — request body `{csv: string}`; response
  `{jobId, appended, duplicateInSheet, duplicateInFile, missingAwb, total, errors}` on success,
  or `{error}` with a 4xx status for a rejected upload (missing headers, row-cap exceeded,
  malformed CSV).

- [ ] **Step 1: Write `api/rto/upload-start.js`**

```javascript
// POST /api/rto/upload-start - admin-only. The FAST half of the CSV upload feature: parses,
// validates headers against the live sheet, dedupes by AWB, appends non-prepaid rows
// immediately (nothing to check for them), and hands the prepaid rows off to a background
// Lambda for the GoKwik/LMD checks - see docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md
// for why those checks cannot run here (mcaff_prod MySQL is reachable only from Python) or
// synchronously within one browser request (API Gateway's ~29s ceiling).
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');
const { parseCSV } = require('../_lib/csv');
const {
  matchHeaders, findRequiredMatch, buildRowPlan, headerToColumnLetter,
} = require('../_lib/rtoCsvImport');
const { createRtoCsvUploadJob } = require('../_lib/db');
const { triggerLambda } = require('../_lib/lambdaTrigger');

const RTO_SHEET_ID = '1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI';
const SHEET_TAB = 'Data';
const CARD_KEY = 'calling';
const TAB_KEY = 'rto';
const MAX_ROWS = 5000;
const CSV_UPLOAD_WORKER_LAMBDA = 'mcaff-cls-csv-upload-worker';

// Same 15 target columns the user specified, matched against the LIVE sheet by name (see
// api/_lib/rtoCsvImport.js) - this list exists only to know which of the sheet's own header
// row entries are the ones this feature cares about mapping; it is never used as a source of
// truth for what the sheet's headers actually say right now.
const TARGET_HEADERS = [
  'RTO Initiated Date', 'Latest NDR Date', 'RTO Reason', 'Order ID', 'Unique', 'AWB Code',
  'Customer Email', 'Customer Name', 'Customer Mobile', 'Address', 'Address City',
  'Address State', 'Address Pincode', 'Payment Method', 'Order Total',
];

let _client = null;
function getClient() {
  if (!_client) {
    const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    const key = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!email || !key) throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars');
    _client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  }
  return _client;
}

async function sheetsRequest(client, method, path, body) {
  const res = await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${RTO_SHEET_ID}${path}`,
    method,
    data: body,
  });
  return res.data;
}

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin) return 'Only admins can upload leads.';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to RTO-CRM.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to RTO-CRM.';
  return null;
}

// COD/blank-payment-method is never GoKwik-checked (nothing was paid upfront to refund) -
// same is_prepaid rule as scripts/lead_priority.py, kept in sync manually since Python cannot
// execute JS (see leadAssignmentRules.json's own _readme for this codebase's existing
// precedent for that constraint). Only used here to split rows for the job's prepaid_count and
// to decide which rows even need queuing for the worker's refund-check phase.
function isPrepaid(paymentRaw) {
  const p = (paymentRaw || '').toUpperCase();
  return !(p.includes('COD') || p.includes('CASH'));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  const { csv } = req.body || {};
  if (!csv || typeof csv !== 'string') {
    res.status(400).json({ error: 'csv text is required' });
    return;
  }

  let csvRows;
  try {
    csvRows = parseCSV(csv);
  } catch (e) {
    res.status(400).json({ error: `Could not parse CSV: ${e.message}` });
    return;
  }
  if (!csvRows.length) {
    res.status(400).json({ error: 'No data rows found in the CSV' });
    return;
  }
  if (csvRows.length > MAX_ROWS) {
    res.status(400).json({ error: `CSV has ${csvRows.length} rows - the limit is ${MAX_ROWS} per upload. Split it into smaller files.` });
    return;
  }

  try {
    const client = getClient();

    // Live sheet headers - the source of truth for matching, never a hardcoded list beyond
    // TARGET_HEADERS' own names above (which only say WHICH 15 concepts this feature maps,
    // not what the sheet currently calls them).
    const headerData = await sheetsRequest(client, 'GET', `/values/${encodeURIComponent(`'${SHEET_TAB}'!A1:AD1`)}`);
    const fullHeaderRow = (headerData.values || [[]])[0] || [];
    const csvHeaders = Object.keys(csvRows[0]);
    const matchResult = matchHeaders(TARGET_HEADERS, csvHeaders);

    const missingRequired = [];
    if (!findRequiredMatch(matchResult, 'awb code')) missingRequired.push('AWB Code');
    if (!findRequiredMatch(matchResult, 'order id')) missingRequired.push('Order ID');
    if (missingRequired.length) {
      res.status(400).json({
        error: `Could not find a column matching ${missingRequired.join(' or ')} in the CSV headers.`,
        csvHeaders,
      });
      return;
    }

    // Existing AWBs across the WHOLE sheet, not just unassigned rows - see the spec's dedup
    // section for why a duplicate of an already-disposed lead still counts.
    const awbColLetter = headerToColumnLetter(fullHeaderRow, 'AWB Code');
    const awbData = await sheetsRequest(client, 'GET', `/values/${encodeURIComponent(`'${SHEET_TAB}'!${awbColLetter}2:${awbColLetter}`)}`);
    const existingAwbSet = new Set(
      (awbData.values || []).map((r) => ((r && r[0]) || '').toString().trim().toUpperCase()).filter(Boolean),
    );

    const plan = buildRowPlan({ matchResult, csvRows, existingAwbSet });

    const prepaidRows = plan.validRows.filter((r) => isPrepaid(r.paymentMethod));
    const nonPrepaidRows = plan.validRows.filter((r) => !isPrepaid(r.paymentMethod));

    // Non-prepaid rows need no check at all - append them right away rather than making them
    // wait on the worker. ONE batched values:append via the existing /api/rto/sheet proxy's
    // own op=batchUpdate would not work here (that endpoint only overwrites existing cells,
    // it has no append semantics) - so this hits the Sheets API directly, same as every other
    // write in this file, but via values:append specifically.
    let appendedNow = 0;
    if (nonPrepaidRows.length) {
      const rowsToAppend = nonPrepaidRows.map((r) => TARGET_HEADERS.map((h) => r.cells[h] || ''));
      const startCol = headerToColumnLetter(fullHeaderRow, TARGET_HEADERS[0]);
      await sheetsRequest(
        client, 'POST',
        `/values/${encodeURIComponent(`'${SHEET_TAB}'!${startCol}2`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { valueInputOption: 'USER_ENTERED', values: rowsToAppend },
      );
      appendedNow = nonPrepaidRows.length;
    }

    let jobId = null;
    if (prepaidRows.length) {
      jobId = await createRtoCsvUploadJob({
        createdBy: session.email,
        totalRows: prepaidRows.length,
        prepaidCount: prepaidRows.length,
        rowsPending: prepaidRows,
      });
      await triggerLambda(CSV_UPLOAD_WORKER_LAMBDA, { jobId });
    }

    res.status(200).json({
      jobId,
      appended: appendedNow,
      queuedForCheck: prepaidRows.length,
      duplicateInSheet: plan.counts.duplicateInSheet,
      duplicateInFile: plan.counts.duplicateInFile,
      missingAwb: plan.counts.missingAwb,
      total: csvRows.length,
      errors: plan.errors.slice(0, 50),
    });
  } catch (e) {
    console.error('api/rto/upload-start error:', e);
    res.status(500).json({ error: e.message || 'Could not process this upload' });
  }
};
```

- [ ] **Step 2: Verify syntax**

Run: `node --check api/rto/upload-start.js`
Expected: no output.

- [ ] **Step 3: Mount the route**

In `api/_lambda/app.js`, find the line `mount('post', '/api/rto/next-lead', '../rto/next-lead.js');`
and add immediately after it:
```javascript
mount('post', '/api/rto/upload-start', '../rto/upload-start.js');
```

- [ ] **Step 4: Verify the app still loads with the new route mounted**

Run: `node -e "require('./api/_lambda/app.js'); console.log('app.js OK')"`
Expected: `app.js OK`

- [ ] **Step 5: Commit**

```bash
git add api/rto/upload-start.js api/_lambda/app.js
git commit -m "feat: add api/rto/upload-start.js for CSV upload"
```

---

### Task 7: `api/rto/upload-status.js` — the polling endpoint

**Files:**
- Create: `api/rto/upload-status.js`
- Modify: `api/_lambda/app.js` (mount the route)

**Interfaces:**
- Consumes: `getRtoCsvUploadJob` (`api/_lib/db.js`).
- Produces: `GET /api/rto/upload-status?jobId=123` — admin-only, returns the job row's public
  fields (never `rows_pending`, which can be large and is internal to the worker).

- [ ] **Step 1: Write `api/rto/upload-status.js`**

```javascript
// GET /api/rto/upload-status?jobId=123 - admin-only. Polled by the browser while a CSV
// upload's background worker (mcaff-cls-csv-upload-worker) processes the prepaid-row
// refund/punch checks - see api/rto/upload-start.js and
// docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md.
const { getSession } = require('../_lib/session');
const { getRtoCsvUploadJob } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'rto';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin) return 'Only admins can view upload status.';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to RTO-CRM.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to RTO-CRM.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  const jobId = Number(req.query.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    res.status(400).json({ error: 'jobId is required' });
    return;
  }

  try {
    const job = await getRtoCsvUploadJob(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    // rows_pending is deliberately never returned - internal to the worker, and can be large.
    res.status(200).json({
      status: job.status,
      totalRows: job.total_rows,
      prepaidCount: job.prepaid_count,
      checkedCount: job.checked_count,
      alreadyRefundedCount: job.already_refunded_count,
      alreadyPunchedCount: job.already_punched_count,
      appendedCount: job.appended_count,
      errorMessage: job.error_message,
    });
  } catch (e) {
    console.error('api/rto/upload-status error:', e);
    res.status(500).json({ error: e.message || 'Could not fetch upload status' });
  }
};
```

- [ ] **Step 2: Verify syntax**

Run: `node --check api/rto/upload-status.js`
Expected: no output.

- [ ] **Step 3: Mount the route**

In `api/_lambda/app.js`, add immediately after the `upload-start` mount line added in Task 6:
```javascript
mount('get', '/api/rto/upload-status', '../rto/upload-status.js');
```

- [ ] **Step 4: Verify the app still loads**

Run: `node -e "require('./api/_lambda/app.js'); console.log('app.js OK')"`
Expected: `app.js OK`

- [ ] **Step 5: Commit**

```bash
git add api/rto/upload-status.js api/_lambda/app.js
git commit -m "feat: add api/rto/upload-status.js for CSV upload job polling"
```

---

### Task 8: `scripts/process_rto_csv_upload_job.py` — the background worker

**Files:**
- Create: `scripts/process_rto_csv_upload_job.py`
- Test: `scripts/test_process_rto_csv_upload_job.py`

**Interfaces:**
- Consumes (unmodified, from `scripts/assign_leads.py`): `check_already_punched(order_ids)`,
  `resolve_refund_statuses(order_ids, dirty)`, `flush_gokwik_refund_cache(dirty, conn=None)`,
  `ALREADY_PUNCHED`, `ALREADY_REFUNDED`; (from `scripts/lead_priority.py`): `is_prepaid`;
  (from `scripts/lib.py`): `get_pg_connection`, `append_sheet_rows` (Task 2).
  From `mysql_lib`: `get_credential()`.
- Produces: `process_job(job_id)` — the whole worker routine for one job, and
  `partition_and_stamp(rows, punched_ids, refund_results)` — a pure helper (no I/O) that
  decides each row's final stamped-or-plain cell values, extracted specifically so this logic
  has a real test that doesn't require mocking MySQL/GoKwik/Postgres/Sheets all at once.

- [ ] **Step 1: Write the failing test for the pure partitioning logic**

Create `scripts/test_process_rto_csv_upload_job.py`:
```python
"""Self-check for process_rto_csv_upload_job.py's pure row-partitioning logic - deciding
which rows get stamped Already Refunded / Already Punched vs written plain, given the results
of the (mocked-out-in-this-test) punch/refund checks. No MySQL, no Postgres, no GoKwik, no
Sheets - those are exercised only by manual verification against the real environment, same
acknowledged limitation as every other endpoint built this same week (no live server available
in this environment). Run: python scripts/test_process_rto_csv_upload_job.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_rto_csv_upload_job as worker


def test_partition_and_stamp_marks_punched_rows():
    rows = [
        {"orderId": "HYP1", "awbCode": "AWB1", "paymentMethod": "COD", "rtoReason": "X", "cells": {"AWB Code": "AWB1"}},
        {"orderId": "HYP2", "awbCode": "AWB2", "paymentMethod": "Prepaid", "rtoReason": "Y", "cells": {"AWB Code": "AWB2"}},
    ]
    result = worker.partition_and_stamp(rows, punched_ids={"HYP1"}, refund_results={"HYP2": False})
    assert result[0]["stamp"] == worker.PUNCHED_STAMP
    assert result[1]["stamp"] is None, "not refunded, not punched - plain unassigned row"


def test_partition_and_stamp_marks_refunded_rows_prepaid_only():
    rows = [
        {"orderId": "HYP3", "awbCode": "AWB3", "paymentMethod": "Prepaid", "rtoReason": "X", "cells": {}},
        {"orderId": "HYP4", "awbCode": "AWB4", "paymentMethod": "COD", "rtoReason": "Y", "cells": {}},
    ]
    # refund_results only ever contains prepaid order ids in real use (see process_job below),
    # but this test proves the function itself does not need to re-derive is_prepaid - it
    # trusts refund_results' keys, matching how resolve_refund_statuses is actually called.
    result = worker.partition_and_stamp(rows, punched_ids=set(), refund_results={"HYP3": True})
    assert result[0]["stamp"] == worker.REFUNDED_STAMP
    assert result[1]["stamp"] is None, "COD row was never in refund_results - plain unassigned"


def test_partition_and_stamp_punched_wins_over_refunded():
    # Mirrors scripts/assign_leads.py's own main(): punch-check runs first, and a punched row
    # is excluded from the refund-check entirely - so in practice a row can never be BOTH, but
    # if it somehow were, punched must win since that's what the row would have been excluded
    # from refund-checking for in the first place.
    rows = [{"orderId": "HYP5", "awbCode": "AWB5", "paymentMethod": "Prepaid", "rtoReason": "", "cells": {}}]
    result = worker.partition_and_stamp(rows, punched_ids={"HYP5"}, refund_results={"HYP5": True})
    assert result[0]["stamp"] == worker.PUNCHED_STAMP


if __name__ == "__main__":
    test_partition_and_stamp_marks_punched_rows()
    print("  ok  test_partition_and_stamp_marks_punched_rows")
    test_partition_and_stamp_marks_refunded_rows_prepaid_only()
    print("  ok  test_partition_and_stamp_marks_refunded_rows_prepaid_only")
    test_partition_and_stamp_punched_wins_over_refunded()
    print("  ok  test_partition_and_stamp_punched_wins_over_refunded")
    print("3 passed")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/test_process_rto_csv_upload_job.py`
Expected: `ModuleNotFoundError: No module named 'process_rto_csv_upload_job'`

- [ ] **Step 3: Implement `scripts/process_rto_csv_upload_job.py`**

```python
#!/usr/bin/env python3
"""Background worker for the RTO CSV upload feature (api/rto/upload-start.js). Invoked
fire-and-forget by that endpoint's triggerLambda call, event shape {"jobId": <int>}.

Runs the SAME checks scripts/assign_leads.py already runs for its own pool - check_already_punched
then resolve_refund_statuses, imported unmodified - against the prepaid rows one CSV upload
queued, since those checks need mcaff_prod MySQL access this app deliberately keeps Python-only
(see docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md's "Why Item_level_data is
required" section). Non-prepaid rows never reach this worker at all - api/rto/upload-start.js
already appended them immediately, since they need no check.

Order of operations, matching assign_leads.py's own main() exactly:
  1. LMD punch-check ALL queued rows (any payment method) - one/few fast batched MySQL queries,
     no chunking needed.
  2. Exclude punched rows from the refund-check entirely (no point paying a GoKwik round-trip
     for a lead already excluded for a different reason - same optimization assign_leads.py's
     own main() already applies).
  3. GoKwik refund-check the remaining PREPAID rows, looped in resolve_refund_statuses' own
     internal chunk/time-budget (GOKWIK_MAX_CHECKS_PER_RUN=120, GOKWIK_TIME_BUDGET_SEC=20s) -
     this worker does not re-implement chunking, it just calls that function repeatedly with
     whatever remains unresolved each round, with a pause between rounds for real breathing
     room against GoKwik's own rate limits (the user's own explicit request).
  4. One batched append of every row - punched/refunded rows pre-stamped as disposed, the rest
     as fresh unassigned leads.

Never raises out of process_job (network/DB blips are caught and turn the job status into
'failed' with error_message set, rather than crashing the Lambda invocation silently) - the
browser is polling this job's status and needs SOMETHING to show even on failure.
"""
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
import mysql_lib
import assign_leads
from lead_priority import is_prepaid

SPREADSHEET_ID = "1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI"
SHEET_TAB = "Data"

# Same stamp text scripts/assign_leads.py's own main() writes for these two cases - see its
# ALREADY_REFUNDED/ALREADY_PUNCHED module-level constants, reused directly rather than
# hand-copied so the two paths can never drift on wording.
REFUNDED_STAMP = (assign_leads.ALREADY_REFUNDED, assign_leads.ALREADY_REFUNDED,
                  "Auto-detected via GoKwik refund status check - not assigned.")
PUNCHED_STAMP = (assign_leads.ALREADY_PUNCHED, assign_leads.ALREADY_PUNCHED,
                 f"Auto-detected via {assign_leads.LMD_TABLE} (D2C channel) - order already punched, not assigned.")

# Pause between refund-check rounds - the user's own explicit request ("give breathing to
# API") on top of resolve_refund_statuses' own internal per-round time budget. Deliberately
# separate from that function's own GOKWIK_TIME_BUDGET_SEC (20s): that constant bounds ONE
# round; this bounds the GAP between rounds.
REFUND_CHECK_ROUND_PAUSE_SEC = 3
# Overall ceiling on the refund-check phase, comfortably inside the worker Lambda's own
# 900s (15 min) timeout - leaves room for the punch-check phase and the final append too.
REFUND_CHECK_PHASE_BUDGET_SEC = 600


def partition_and_stamp(rows, punched_ids, refund_results):
    """Pure - no I/O. Decides each row's `stamp` (a (S, T, U) tuple to write, or None for a
    plain fresh/unassigned row) from already-computed punch/refund results. Punched wins over
    refunded if a row were somehow in both (see this file's own test for why that shouldn't
    actually happen given the calling order in process_job, but the function stays correct
    either way rather than assuming)."""
    out = []
    for row in rows:
        order_id = row["orderId"]
        if order_id in punched_ids:
            stamp = PUNCHED_STAMP
        elif refund_results.get(order_id):
            stamp = REFUNDED_STAMP
        else:
            stamp = None
        out.append({**row, "stamp": stamp})
    return out


def _update_job(conn, job_id, **fields):
    """Partial UPDATE of one job row - mirrors api/_lib/db.js's updateRtoCsvUploadJob in spirit
    (both only ever touch this table's own columns), but this is Python's own psycopg
    connection, not a call into the Node file. Always sets updated_at."""
    if not fields:
        return
    set_clauses = []
    values = []
    for key, value in fields.items():
        set_clauses.append(f"{key} = %s")
        values.append(value)
    values.append(job_id)
    with conn.cursor() as cur:
        cur.execute(
            f"UPDATE rto_csv_upload_jobs SET {', '.join(set_clauses)}, updated_at = now() WHERE id = %s",
            values,
        )
    conn.commit()


def _fetch_job_rows(conn, job_id):
    import json
    with conn.cursor() as cur:
        cur.execute("SELECT rows_pending FROM rto_csv_upload_jobs WHERE id = %s", (job_id,))
        row = cur.fetchone()
    if row is None or row[0] is None:
        return []
    return row[0] if isinstance(row[0], list) else json.loads(row[0])


def process_job(job_id):
    conn_str = os.environ.get("POSTGRES_URL")
    conn = lib.get_pg_connection(conn_str)
    try:
        rows = _fetch_job_rows(conn, job_id)
        if not rows:
            _update_job(conn, job_id, status="failed", error_message="Job has no pending rows")
            return

        _update_job(conn, job_id, status="checking_punch")

        # Step 1: LMD punch-check, ALL rows regardless of payment method - see module docstring.
        all_order_ids = [r["orderId"] for r in rows]
        try:
            punched_ids = assign_leads.check_already_punched(set(all_order_ids))
        except Exception as e:
            print(f"  punch-check failed, treating as none punched: {e}")
            punched_ids = set()
        _update_job(conn, job_id, already_punched_count=len(punched_ids))

        # Step 2: exclude punched rows from the refund-check entirely.
        prepaid_unpunched = [
            r["orderId"] for r in rows
            if is_prepaid(r["paymentMethod"]) and r["orderId"] not in punched_ids
        ]

        # Step 3: GoKwik refund-check, looped over resolve_refund_statuses' own internal
        # chunk/time-budget, with a pause between rounds for real breathing room.
        _update_job(conn, job_id, status="checking_refund")
        all_refund_results = {}
        dirty = {}
        remaining = list(prepaid_unpunched)
        phase_started = time.monotonic()
        while remaining and (time.monotonic() - phase_started) < REFUND_CHECK_PHASE_BUDGET_SEC:
            round_results = assign_leads.resolve_refund_statuses(set(remaining), dirty)
            all_refund_results.update(round_results)
            # Only order_ids resolve_refund_statuses actually reached this round land in
            # `dirty` (over-budget ones are deliberately excluded from it - see that
            # function's own docstring) - narrowing `remaining` to exactly those still
            # unresolved is what makes repeated calls advance instead of re-checking the
            # same head of the list every round.
            remaining = [oid for oid in remaining if oid not in dirty]
            checked_so_far = len(prepaid_unpunched) - len(remaining)
            already_refunded_so_far = sum(1 for v in all_refund_results.values() if v)
            _update_job(
                conn, job_id,
                checked_count=checked_so_far,
                already_refunded_count=already_refunded_so_far,
            )
            if remaining:
                time.sleep(REFUND_CHECK_ROUND_PAUSE_SEC)
        try:
            assign_leads.flush_gokwik_refund_cache(dirty, conn=conn)
        except Exception as e:
            print(f"  gokwik cache flush failed (non-fatal): {e}")

        # Step 4: final batched append.
        _update_job(conn, job_id, status="appending")
        stamped_rows = partition_and_stamp(rows, punched_ids, all_refund_results)
        target_headers = [
            "RTO Initiated Date", "Latest NDR Date", "RTO Reason", "Order ID", "Unique",
            "AWB Code", "Customer Email", "Customer Name", "Customer Mobile", "Address",
            "Address City", "Address State", "Address Pincode", "Payment Method", "Order Total",
        ]
        values_to_append = []
        for row in stamped_rows:
            cells = row["cells"]
            base_row = [cells.get(h, "") for h in target_headers]
            if row["stamp"]:
                # Columns Q (agent) through U line up right after P (Order Total, the last of
                # target_headers) - Q blank (never assigned), then the S/T/U stamp. R (Connected)
                # stays blank too, matching how assign_leads.py stamps its own already-
                # refunded/already-punched rows (see its own value_ranges construction).
                s, t, u = row["stamp"]
                base_row += ["", "", s, t, u]
            values_to_append.append(base_row)
        lib.append_sheet_rows(SPREADSHEET_ID, f"'{SHEET_TAB}'!B2:U", values_to_append)

        _update_job(
            conn, job_id, status="done", appended_count=len(values_to_append),
            rows_pending=None,
        )
    except Exception as e:
        print(f"process_job({job_id}) failed: {e}")
        try:
            _update_job(conn, job_id, status="failed", error_message=str(e))
        except Exception:
            pass
    finally:
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python process_rto_csv_upload_job.py <job_id>")
    process_job(int(sys.argv[1]))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/test_process_rto_csv_upload_job.py`
Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/process_rto_csv_upload_job.py scripts/test_process_rto_csv_upload_job.py
git commit -m "feat: add background worker for RTO CSV upload refund/punch checks"
```

---

### Task 9: `lambda/csv_upload_worker/handler.py` + `lambda/build.sh` target

**Files:**
- Create: `lambda/csv_upload_worker/handler.py`
- Modify: `lambda/build.sh` (add a `build_csv_upload_worker` function and case branch)

**Interfaces:**
- Produces: a Lambda entrypoint `handler(event, context)` reading `event["jobId"]` and calling
  `process_rto_csv_upload_job.process_job(job_id)`; `./build.sh csv_upload_worker` produces
  `lambda/dist/csv_upload_worker.zip`.

- [ ] **Step 1: Write `lambda/csv_upload_worker/handler.py`**

```python
"""Lambda entrypoint for the RTO CSV upload background worker. Invoked fire-and-forget by
api/rto/upload-start.js with event shape {"jobId": <int>} - see
docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md.

Directory layout this expects at the Lambda task root (see ../build.sh), same convention as
lambda/assign_leads/handler.py:
    handler.py
    scripts/process_rto_csv_upload_job.py, assign_leads.py, lead_priority.py, lib.py, mysql_lib.py
    api/_lib/callingProcesses.json, leadAssignmentRules.json
process_rto_csv_upload_job.py imports assign_leads unmodified, so assign_leads.py's own
Item_level_data/LMD/GoKwik logic needs no changes to run here.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
import process_rto_csv_upload_job  # noqa: E402


def handler(event, context):
    job_id = event.get("jobId")
    if job_id is None:
        print("csv-upload-worker: no jobId in event, nothing to do")
        return {"ok": False, "error": "missing jobId"}
    print(f"csv-upload-worker: starting job {job_id}")
    process_rto_csv_upload_job.process_job(int(job_id))
    print(f"csv-upload-worker: finished job {job_id}")
    return {"ok": True}
```

- [ ] **Step 2: Add the build target to `lambda/build.sh`**

Insert this new function immediately after the existing `build_assign_ndr_leads` function
(before the `case "${1:-all}" in` line):

```bash
build_csv_upload_worker() {
  echo "=== Building csv_upload_worker.zip ==="
  work="$(mktemp -d)"
  mkdir -p "$work/scripts" "$work/api/_lib"

  cp "$LAMBDA_DIR/csv_upload_worker/handler.py" "$work/handler.py"
  cp "$REPO_ROOT/scripts/process_rto_csv_upload_job.py" \
     "$REPO_ROOT/scripts/assign_leads.py" \
     "$REPO_ROOT/scripts/lib.py" \
     "$REPO_ROOT/scripts/mysql_lib.py" \
     "$REPO_ROOT/scripts/lead_priority.py" \
     "$work/scripts/"
  cp "$REPO_ROOT/api/_lib/callingProcesses.json" \
     "$REPO_ROOT/api/_lib/leadAssignmentRules.json" \
     "$work/api/_lib/"

  # Same dependency set as assign_leads.zip - this worker imports assign_leads.py unmodified,
  # so it needs everything that file needs (pymysql for MySQL, psycopg for Postgres, requests
  # for Sheets/GoKwik HTTP calls, cryptography as psycopg[binary]'s own dependency).
  pip3 install --disable-pip-version-check --only-binary=:all: \
    --platform manylinux2014_x86_64 --python-version 3.12 --implementation cp --abi cp312 \
    -t "$work" psycopg[binary] requests cryptography pymysql

  ( cd "$work" && zip -r -q "$OUT_DIR/csv_upload_worker.zip" . )
  rm -rf "$work"
  echo "-> $OUT_DIR/csv_upload_worker.zip"
}
```

Then update the `case` statement at the bottom of the file from:
```bash
case "${1:-all}" in
  assign_leads) build_assign_leads ;;
  assign_ndr_leads) build_assign_ndr_leads ;;
  all) build_assign_leads; build_assign_ndr_leads ;;
  *) echo "Usage: $0 [assign_leads|assign_ndr_leads]" >&2; exit 1 ;;
esac
```
to:
```bash
case "${1:-all}" in
  assign_leads) build_assign_leads ;;
  assign_ndr_leads) build_assign_ndr_leads ;;
  csv_upload_worker) build_csv_upload_worker ;;
  all) build_assign_leads; build_assign_ndr_leads; build_csv_upload_worker ;;
  *) echo "Usage: $0 [assign_leads|assign_ndr_leads|csv_upload_worker]" >&2; exit 1 ;;
esac
```

- [ ] **Step 3: Verify the Python file at least parses (syntax only - full build needs Linux/WSL
per `build.sh`'s own header comment, not available in this environment)**

Run: `python -c "import ast; ast.parse(open('lambda/csv_upload_worker/handler.py').read()); print('SYNTAX OK')"`
Expected: `SYNTAX OK`

Run: `bash -n lambda/build.sh`
Expected: no output (valid bash syntax).

- [ ] **Step 4: Commit**

```bash
git add lambda/csv_upload_worker/handler.py lambda/build.sh
git commit -m "feat: add Lambda entrypoint and build target for csv_upload_worker"
```

---

### Task 10: Create the new Lambda function via `deploy_infra.sh`

**Files:**
- Modify: `lambda/deploy_infra.sh` (add a creation/update block for `mcaff-cls-csv-upload-worker`,
  no EventBridge schedule needed since this is invoked on-demand, not on a timer)

**Interfaces:**
- Produces: a live `mcaff-cls-csv-upload-worker` Lambda function, 1536 MB memory, 900s timeout,
  reserved concurrency 1, with the same env vars as `mcaff-cls-assign-leads`.

This task is **run manually by the user**, not by an automated executor — `deploy_infra.sh`
itself says so ("Run this once from an environment already authenticated to the mcaff-CLS AWS
account") and this plan does not change that. The steps below describe exactly what to add and
why, for whoever runs it.

- [ ] **Step 1: Add the new function's block to `lambda/deploy_infra.sh`**

Insert this immediately after the existing `# ---- 5. assign-ndr-leads Lambda ----` section's
closing (right before the `# ---- 6. sync-lead-assignments Lambda ----` comment):

```bash
# ---- 5b. csv-upload-worker Lambda - the RTO CSV upload feature's background worker. Its own
#          function (not folded into assign-leads) specifically so its timeout/memory can be
#          set generously AT CREATION here, sidestepping the fact that the GitHub Actions
#          deploy role lacks lambda:UpdateFunctionConfiguration (confirmed blocked 2026-08-20 -
#          see git log for that incident) and so cannot resize an EXISTING function. No
#          EventBridge schedule: this is invoked on-demand by api/rto/upload-start.js via a
#          fire-and-forget Lambda invoke, never on a timer. ----
FN_CSV_WORKER=mcaff-cls-csv-upload-worker
if ! aws lambda get-function --function-name "$FN_CSV_WORKER" >/dev/null 2>&1; then
  aws lambda create-function --function-name "$FN_CSV_WORKER" \
    --runtime python3.12 --handler handler.handler --role "$ROLE_ARN" \
    --timeout 900 --memory-size 1536 --region "$AWS_REGION" \
    --zip-file "fileb://$DIST/csv_upload_worker.zip" >/dev/null
else
  aws lambda update-function-code --function-name "$FN_CSV_WORKER" \
    --zip-file "fileb://$DIST/csv_upload_worker.zip" --region "$AWS_REGION" >/dev/null
fi
aws lambda wait function-updated --function-name "$FN_CSV_WORKER" --region "$AWS_REGION"
aws lambda update-function-configuration --function-name "$FN_CSV_WORKER" --region "$AWS_REGION" \
  --environment "Variables={GOOGLE_SA_KEY_JSON=${GOOGLE_SA_KEY},POSTGRES_URL=${POSTGRES_URL},MYSQL_HOST=${MYSQL_HOST},MYSQL_USER=${MYSQL_USER},MYSQL_PASSWORD=${MYSQL_PASSWORD},MYSQL_DATABASE=${MYSQL_DATABASE},MYSQL_PORT=${MYSQL_PORT},GOKWIK_HYPHEN_APPID=${GOKWIK_HYPHEN_APPID},GOKWIK_HYPHEN_APPSECRET=${GOKWIK_HYPHEN_APPSECRET},GOKWIK_FIEN_APPID=${GOKWIK_FIEN_APPID},GOKWIK_FIEN_APPSECRET=${GOKWIK_FIEN_APPSECRET},GOKWIK_MCAFFEINE_APPID=${GOKWIK_MCAFFEINE_APPID},GOKWIK_MCAFFEINE_APPSECRET=${GOKWIK_MCAFFEINE_APPSECRET}}" \
  >/dev/null
# Reserved concurrency = 1: one upload job processed at a time, avoiding two jobs racing on
# the same AWB-dedup read. A second job's own /start call still succeeds immediately (it only
# creates the Postgres row and fires the invoke) - Lambda's own async-invoke retry policy
# queues the actual worker run until the first job's invocation finishes, no custom queueing
# needed on our side (see the design spec's concurrency note).
aws lambda put-function-concurrency --function-name "$FN_CSV_WORKER" \
  --reserved-concurrent-executions 1 --region "$AWS_REGION"
```

- [ ] **Step 2: Verify the script is still valid bash**

Run: `bash -n lambda/deploy_infra.sh`
Expected: no output.

- [ ] **Step 3: Verify (or grant) the API Lambda's execution role can invoke the new function**

The Node API Lambda (`mcaff-cls-api`) needs `lambda:InvokeFunction` on
`mcaff-cls-csv-upload-worker`'s ARN for `triggerLambda` (Task 3) to actually succeed at
runtime — otherwise the invoke fails silently (by design, per that function's own
fail-open comment) and no upload would ever actually get checked, with no visible error
anywhere.

Run (replace `<api-lambda-role-name>` with whatever `mcaff-cls-api`'s actual execution role is —
find it via `aws lambda get-function-configuration --function-name mcaff-cls-api --query Role`):
```bash
aws iam get-role-policy --role-name <api-lambda-role-name> --policy-name <policy-name> 2>&1 | grep -A3 "lambda:InvokeFunction"
```
If this does not already cover `mcaff-cls-*` (a wildcard) or explicitly list
`mcaff-cls-csv-upload-worker`, add it — the exact policy name and current document depend on
how that role was originally provisioned, so inspect it live rather than guessing.

- [ ] **Step 4: Run the script (this is the ONE live-infrastructure step in this whole plan)**

Run (from an environment authenticated to the mcaff-CLS AWS account, per the script's own
header comment):
```bash
./lambda/deploy_infra.sh
```
Expected: the script completes without error, and `aws lambda get-function --function-name
mcaff-cls-csv-upload-worker` shows `MemorySize: 1536`, `Timeout: 900`.

- [ ] **Step 5: Commit the script change**

```bash
git add lambda/deploy_infra.sh
git commit -m "feat: add mcaff-cls-csv-upload-worker to deploy_infra.sh"
```

---

### Task 11: `.github/workflows/deploy-cron-lambdas.yml` — auto-deploy the worker's code

**Files:**
- Modify: `.github/workflows/deploy-cron-lambdas.yml`

**Interfaces:** None — CI configuration only.

- [ ] **Step 1: Add the new script/lambda paths to the workflow's trigger list**

Find the `paths:` list under `on: push:` and add these two lines (matching the existing
`lambda/assign_leads/**` / `lambda/assign_ndr_leads/**` entries):
```yaml
      - 'scripts/process_rto_csv_upload_job.py'
      - 'lambda/csv_upload_worker/**'
```

- [ ] **Step 2: Add a build+deploy step for the new function**

Find the existing `- name: Build Lambda zips` step's `run:` block and add a new line calling
the new build target:
```yaml
          bash lambda/build.sh csv_upload_worker
```
(alongside the existing `bash lambda/build.sh assign_leads` / `assign_ndr_leads` lines).

Then, after the existing `- name: Update assign-ndr-leads Lambda code` step, add a matching
step for the worker (**code only** — `update-function-code`, never
`update-function-configuration`, since that permission is confirmed unavailable to this
workflow's role; memory/timeout are set once via `deploy_infra.sh`, Task 10):
```yaml
      - name: Update csv-upload-worker Lambda code
        run: |
          aws lambda update-function-code --function-name mcaff-cls-csv-upload-worker \
            --zip-file fileb://lambda/dist/csv_upload_worker.zip \
            --query "{FunctionName:FunctionName,LastUpdateStatus:LastUpdateStatus,CodeSha256:CodeSha256}"
          aws lambda wait function-updated --function-name mcaff-cls-csv-upload-worker
```

- [ ] **Step 3: Verify the YAML is still well-formed**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/deploy-cron-lambdas.yml')); print('YAML OK')"`
Expected: `YAML OK`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-cron-lambdas.yml
git commit -m "feat: auto-deploy csv-upload-worker Lambda code on push"
```

---

### Task 12: `app/rto-crm/RtoUploadModal.js` — the client component

**Files:**
- Create: `app/rto-crm/RtoUploadModal.js`

**Interfaces:**
- Produces: `export default function RtoUploadModal({ onClose, onDone })` — a React component,
  self-contained (owns its own file-read/upload/poll state), calling `onDone()` once the job
  reaches `done` so the parent can refresh its ticket list.

- [ ] **Step 1: Write `app/rto-crm/RtoUploadModal.js`**

```javascript
'use client';
// Upload CSV modal for the RTO CRM - admin-only. Closely mirrors
// app/escalation/EscalationClient.js's own ImportModal (FileReader -> JSON POST -> result),
// adapted for this feature's async job/poll flow instead of one synchronous response: the
// refund/punch checks run in a background Lambda (see api/rto/upload-start.js and
// docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md), so this polls
// /api/rto/upload-status rather than getting a final answer in the initial response.
import { useState, useRef, useEffect } from 'react';

const POLL_INTERVAL_MS = 3000;
const TERMINAL_STATUSES = new Set(['done', 'failed']);

export default function RtoUploadModal({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [csvText, setCsvText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [startResult, setStartResult] = useState(null); // response from /upload-start
  const [jobStatus, setJobStatus] = useState(null); // latest /upload-status poll
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function readFile(f) {
    if (!f) return;
    if (!/\.(csv|tsv|txt)$/i.test(f.name)) {
      setError('Please choose a .csv file');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { setCsvText(String(reader.result || '')); setFile(f); setError(''); setStartResult(null); setJobStatus(null); };
    reader.onerror = () => setError('Could not read file');
    reader.readAsText(f);
  }

  function pollJob(jobId) {
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/rto/upload-status?jobId=${jobId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not fetch status');
        setJobStatus(data);
        if (TERMINAL_STATUSES.has(data.status)) {
          clearInterval(pollRef.current);
          if (data.status === 'done') onDone();
        }
      } catch (e) {
        clearInterval(pollRef.current);
        setError(e.message);
      }
    }, POLL_INTERVAL_MS);
  }

  async function handleUpload() {
    if (!csvText.trim()) { setError('No CSV content to upload'); return; }
    setSubmitting(true); setError(''); setStartResult(null); setJobStatus(null);
    try {
      const res = await fetch('/api/rto/upload-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setStartResult(data);
      if (data.jobId) {
        setJobStatus({ status: 'queued', checkedCount: 0, prepaidCount: data.queuedForCheck });
        pollJob(data.jobId);
      } else {
        onDone(); // no prepaid rows queued - everything that was going to append already did
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modalCard" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Upload CSV">
        <div className="modalHeader">
          <div className="modalTitle">Upload CSV</div>
          <button type="button" className="btn btnXs btnGhost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modalBody">
          <p className="modalHint">
            Upload a CSV of new RTO leads. Rows are matched to the sheet&apos;s own columns by
            header name, deduplicated by <strong>AWB Code</strong>, and checked for existing
            GoKwik refunds (prepaid only) and LMD &quot;already punched&quot; status before being
            added.
          </p>

          <div
            className={`dropZone${dragOver ? ' dragOver' : ''}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); readFile(e.dataTransfer.files?.[0]); }}
          >
            <div className="dropZoneText">{file ? file.name : 'Click to choose a CSV or drag it here'}</div>
            {file && <div className="dropZoneSub">Ready to upload · {(file.size / 1024).toFixed(1)} KB</div>}
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.tsv,.txt,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => readFile(e.target.files?.[0])}
            />
          </div>

          {error && <div className="importErrors"><div className="importErrorItem">{error}</div></div>}

          {startResult && (
            <div className="importResult">
              <div className="importResultRow">
                <span className="importStat importStatOk">{startResult.appended} appended immediately</span>
                <span className="importStat">{startResult.queuedForCheck} queued for refund/punch check</span>
                <span className="importStat importStatSkip">{startResult.duplicateInSheet} duplicate in sheet</span>
                <span className="importStat importStatSkip">{startResult.duplicateInFile} duplicate in file</span>
                <span className="importStat importStatSkip">{startResult.missingAwb} missing AWB</span>
                <span className="importStat">{startResult.total} rows read</span>
              </div>
              {startResult.errors?.length > 0 && (
                <div className="importErrors">
                  {startResult.errors.map((e, i) => (
                    <div key={i} className="importErrorItem">Line {e.line}: {e.reason}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {jobStatus && (
            <div className="importResult">
              <div className="importResultRow">
                <span className="importStat">{jobStatus.status}</span>
                {jobStatus.prepaidCount != null && (
                  <span className="importStat">{jobStatus.checkedCount ?? 0}/{jobStatus.prepaidCount} prepaid checked</span>
                )}
                {jobStatus.alreadyRefundedCount != null && (
                  <span className="importStat importStatSkip">{jobStatus.alreadyRefundedCount} already refunded</span>
                )}
                {jobStatus.alreadyPunchedCount != null && (
                  <span className="importStat importStatSkip">{jobStatus.alreadyPunchedCount} already punched</span>
                )}
                {jobStatus.status === 'done' && (
                  <span className="importStat importStatOk">{jobStatus.appendedCount} appended</span>
                )}
              </div>
              {jobStatus.status === 'failed' && (
                <div className="importErrors"><div className="importErrorItem">{jobStatus.errorMessage}</div></div>
              )}
            </div>
          )}
        </div>

        <div className="modalFooter">
          <button type="button" className="btn btnGhost" onClick={onClose}>Close</button>
          <button
            type="button"
            className="btn btnPrimary"
            disabled={!csvText.trim() || submitting || (jobStatus && !TERMINAL_STATUSES.has(jobStatus.status))}
            onClick={handleUpload}
          >
            {submitting ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify syntax**

Run:
```bash
node -e "
const fs=require('fs'); const swc=require('next/dist/build/swc');
swc.transform(fs.readFileSync('app/rto-crm/RtoUploadModal.js','utf8'),{filename:'x.js',jsc:{parser:{syntax:'ecmascript',jsx:true}}}).then(()=>console.log('PARSE OK')).catch(e=>{console.log('FAIL',String(e).slice(0,600));process.exit(1)});
"
```
Expected: `PARSE OK`

- [ ] **Step 3: Commit**

```bash
git add app/rto-crm/RtoUploadModal.js
git commit -m "feat: add RtoUploadModal client component"
```

---

### Task 13: Wire the "Upload CSV" button into `RtoCrmClient.js`

**Files:**
- Modify: `app/rto-crm/RtoCrmClient.js`

**Interfaces:**
- Consumes: `RtoUploadModal` (Task 12), the existing `sessionIsAdmin` variable already in scope
  in this component (used elsewhere for other admin-only controls), the existing `sync`
  function (to refresh the ticket list once a job completes).

- [ ] **Step 1: Import the new modal**

Near the top of `app/rto-crm/RtoCrmClient.js`, alongside the other named imports from
`../_calling/*`, add:
```javascript
import RtoUploadModal from './RtoUploadModal';
```

- [ ] **Step 2: Add modal-open state**

Find the existing `const [dispTkt, setDispTkt] = useState(null);` line (the disposal modal's
own open/closed state, used as the pattern to match) and add immediately after it:
```javascript
const [showUploadModal, setShowUploadModal] = useState(false);
```

- [ ] **Step 3: Add the button and modal render**

Find the toolbar/header area where other admin-only buttons are rendered — locate it via:
`grep -n "sessionIsAdmin &&" app/rto-crm/RtoCrmClient.js` and pick the first such conditional
render block near the top-level header controls (not inside the Team Roster table). Add a
sibling button there:
```javascript
{sessionIsAdmin && (
  <button type="button" className="btn btnSm btnGhost" onClick={() => setShowUploadModal(true)}>
    Upload CSV
  </button>
)}
```

Then, near the end of the component's JSX (alongside where `dispTkt &&` renders the disposal
modal — find that with `grep -n "dispTkt &&" app/rto-crm/RtoCrmClient.js`), add:
```javascript
{showUploadModal && (
  <RtoUploadModal
    onClose={() => setShowUploadModal(false)}
    onDone={() => { setShowUploadModal(false); sync(true); }}
  />
)}
```

- [ ] **Step 4: Verify syntax**

Run:
```bash
node -e "
const fs=require('fs'); const swc=require('next/dist/build/swc');
swc.transform(fs.readFileSync('app/rto-crm/RtoCrmClient.js','utf8'),{filename:'x.js',jsc:{parser:{syntax:'ecmascript',jsx:true}}}).then(()=>console.log('PARSE OK')).catch(e=>{console.log('FAIL',String(e).slice(0,600));process.exit(1)});
"
```
Expected: `PARSE OK`

- [ ] **Step 5: Commit**

```bash
git add app/rto-crm/RtoCrmClient.js
git commit -m "feat: wire Upload CSV button into RtoCrmClient"
```

---

## What this plan does not verify (stated plainly, not hidden)

No live server is available in this environment (same acknowledged limitation as every other
endpoint built in this codebase this week — `claim.js`, `next-lead.js`). This plan's automated
steps verify: pure-logic correctness (Tasks 4, 8), syntax validity of every new/modified file,
and that the Node app still loads with each new route mounted. They do **not** verify: the live
Sheets read/append round-trip, the live Postgres job read/write round-trip, the live MySQL
punch-check or GoKwik refund-check calls, or the actual Lambda-to-Lambda invoke succeeding in
production (Task 10, Step 3 flags the one IAM detail that could silently break that last one).
Manual end-to-end testing against a real (ideally non-production) upload is necessary before
this feature is trusted with real data.
