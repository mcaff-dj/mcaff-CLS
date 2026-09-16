# Product Calling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Product Calling" round-robin calling workspace to the Calling Team sidebar, below NPS-Calling — reusing the already-scaffolded `productkyc` process key, with CSV-based lead intake until the real lead source is confirmed.

**Architecture:** Mirrors NPS-Calling's (`detractor`) round-robin auto-assign stack (single MySQL table, no external DWH join, no manual claim) but simplified: no lead_type/team split, and leads arrive via admin CSV upload directly into the process's own table instead of copy-on-assign from a read-only source table.

**Tech Stack:** Next.js (pages under `app/`), Node.js API routes under `api/`, MySQL via the `sql` tagged-template helper in `api/_lib/db.js`, plain React (no extra libraries) for the client.

**Spec:** `docs/superpowers/specs/2026-09-16-product-calling-design.md`

## Global Constraints

- Process key stays `productkyc` (existing entry in `api/_lib/callingProcesses.json`) — do not introduce a second key.
- No live-DB or dev-server runs during implementation (user tests live) — every step's own verification is either a `node` self-check script or a read-through.
- No `lead_type`/`team_id` split on this process — one shared pool, one shared quota.
- Never trust `req.body.email`/`req.body.processKey` for identity — session email and a hardcoded `PROCESS_KEY`/`TAB_KEY` only, matching every existing calling route.
- Card key for permissions is `'calling'`, tab key is `'productkyc'` throughout.

---

### Task 1: `CLS_productcalling` table

**Files:**
- Modify: `api/_lib/db.js:2331` (insert new `CREATE TABLE` block immediately after `getAllDetractorTickets`'s closing `}` at line 2331, before the `// Delivery-Escalation's own durable record...` comment at line 2333 — actually the table itself belongs in `ensureSchema()`, near `CLS_NPS_calling`'s own `CREATE TABLE`, which ends at db.js:528. Add the new `CREATE TABLE IF NOT EXISTS CLS_productcalling` block right after that closing backtick, before the `calling_process_dispositions` comment block that starts at db.js:529.)
- Test: `api/_lib/db.productCallingSchema.test.js`

**Interfaces:**
- Produces: table `CLS_productcalling` with columns `id, lead_ref, customer_name, customer_phone, customer_email, product_key, product_category, notes, imported_at, imported_by, agent_email, assigned_at, reassigned_away_at, disposed_at, disposition, agent_remarks, connected, attempt, live_lead_ref`. Every later task's SQL depends on this exact column list.

- [ ] **Step 1: Add the table to `ensureSchema()`**

In `api/_lib/db.js`, immediately after line 528 (the closing `` ` `` of `CLS_NPS_calling`'s `CREATE TABLE`) and before line 529's comment block, insert:

```js
  // Product Calling ('productkyc' process key) - unlike CLS_NPS_calling this table has no
  // read-only source table to copy from: leads arrive via admin CSV upload
  // (api/productcalling/upload.js) directly as unassigned rows (agent_email IS NULL). Claiming
  // a lead is therefore a single UPDATE...LIMIT 1, not an INSERT...SELECT copy - see
  // claimNextProductCallingLead. live_lead_ref is the same live-cycle trick CLS_NPS_calling's
  // live_response_id and CLS_RTO_calling's live_order_id already use (NULL once reassigned, so
  // a retired cycle and its replacement can coexist under one UNIQUE KEY).
  await sql`
    CREATE TABLE IF NOT EXISTS CLS_productcalling (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      lead_ref VARCHAR(64) NOT NULL,
      customer_name VARCHAR(255),
      customer_phone VARCHAR(32) NOT NULL,
      customer_email VARCHAR(255),
      product_key VARCHAR(100),
      product_category VARCHAR(100),
      notes TEXT,
      imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      imported_by VARCHAR(320),
      agent_email VARCHAR(320) NULL,
      assigned_at TIMESTAMP NULL,
      reassigned_away_at TIMESTAMP NULL,
      disposed_at TIMESTAMP NULL,
      disposition TEXT,
      agent_remarks TEXT,
      connected VARCHAR(10),
      attempt INT,
      live_lead_ref VARCHAR(80) GENERATED ALWAYS AS
        (IF(reassigned_away_at IS NULL, lead_ref, NULL)) VIRTUAL,
      UNIQUE KEY cls_productcalling_live_lead_ref_key (live_lead_ref)
    )
  `;
```

- [ ] **Step 2: Write a self-check that `ensureSchema()` runs without throwing on the new block**

This cannot hit a live database (no live-DB runs), so the self-check is a static one: parse `api/_lib/db.js` as JS and confirm the new `CREATE TABLE` string is well-formed template literal syntax (i.e. the file still loads). Create `api/_lib/db.productCallingSchema.test.js`:

```js
// Static self-check: db.js must still load (no syntax errors from the new CREATE TABLE block)
// and must export the functions later tasks in this plan add. Extended by Task 2's own test as
// those exports land - for now this only checks the module loads.
const assert = require('assert');
const db = require('./db');
assert.strictEqual(typeof db.ensureSchema, 'function', 'db.js must still export ensureSchema');
console.log('db.productCallingSchema.test.js: all assertions passed');
```

- [ ] **Step 3: Run it**

Run: `node api/_lib/db.productCallingSchema.test.js`
Expected: `db.productCallingSchema.test.js: all assertions passed`

- [ ] **Step 4: Commit**

```bash
git add api/_lib/db.js api/_lib/db.productCallingSchema.test.js
git commit -m "feat(product-calling): add CLS_productcalling table"
```

---

### Task 2: Claim / assign / dispose / list functions

**Files:**
- Modify: `api/_lib/db.js` — insert new functions immediately after `getAllDetractorTickets` (ends at db.js:2331), before the `// Delivery-Escalation's own durable record...` comment (db.js:2333). Also modify the `module.exports` block at db.js:5919-5920 to add the new names.
- Test: `api/_lib/db.productCallingAssign.test.js`

**Interfaces:**
- Consumes: `sql` tagged template, `ensureSchema()`, `safeLimit(value, fallback)`, `raw(text)`, `getCallingDefaultQuota(processKey)`, `getCallingLeadOrder(processKey)` — all already defined earlier in `api/_lib/db.js` (db.js:126-127, 4166, 4194).
- Produces (consumed by Task 4/5/6/7's API routes):
  - `PRODUCTCALLING_FALLBACK_QUOTA` (number, `15`)
  - `getProductCallingAgentQuota(email): Promise<number|null>`
  - `getProductCallingAgentAvailability(email): Promise<string|null>` (`'Online'|'Busy'|'OnCall'|'Offline'|null`)
  - `getProductCallingLoadByAgent(email): Promise<number>`
  - `getProductCallingQuotaAndLoad(email): Promise<{quota:number, load:number}>`
  - `claimNextProductCallingLead(email): Promise<object|null>` (the claimed row, or `null` if the pool is empty)
  - `assignProductCallingLeadsToAgent(email, maxCount, claimFn = claimNextProductCallingLead): Promise<object[]>`
  - `topUpProductCallingAgent(email, deps = {}): Promise<object[]>`
  - `disposeProductCallingLead(leadRef, disposition, agentRemarks, connected, attempt, email, {allowAnyAgent = false} = {}): Promise<{originalAgentEmail: string|null}>`
  - `insertProductCallingLeads(rows, importedBy): Promise<{inserted:number, duplicates:number}>` (`rows`: array of `{leadRef, customerName, customerPhone, customerEmail, productKey, productCategory, notes}`)
  - `getProductCallingTicketsForAgent(email): Promise<object[]>`
  - `getAllProductCallingTickets(): Promise<object[]>`
  - `getUnassignedProductCallingLeads(limit = 20): Promise<object[]>`

- [ ] **Step 1: Add the functions to `api/_lib/db.js`**

Insert immediately after line 2331 (the closing `}` of `getAllDetractorTickets`), before line 2333's comment:

```js
// Falls back to this only when no admin has ever set calling_process_settings.default_quota for
// 'productkyc' - same pattern as DETRACTOR_FALLBACK_QUOTA above.
const PRODUCTCALLING_FALLBACK_QUOTA = 15;

async function getProductCallingAgentQuota(email) {
  try {
    await ensureSchema();
    const { rows } = await sql`
      SELECT max_quota FROM calling_agent_process
      WHERE process_key = 'productkyc' AND LOWER(email) = LOWER(${email})
    `;
    return rows.length && rows[0].max_quota != null ? rows[0].max_quota : null;
  } catch (e) {
    console.error('getProductCallingAgentQuota: calling_agent_process unavailable, using default quota:', e.message);
    return null;
  }
}

async function getProductCallingAgentAvailability(email) {
  try {
    await ensureSchema();
    const { rows } = await sql`
      SELECT status FROM calling_agent_process
      WHERE process_key = 'productkyc' AND LOWER(email) = LOWER(${email})
    `;
    return rows.length ? rows[0].status : 'Offline';
  } catch (e) {
    console.error('getProductCallingAgentAvailability: calling_agent_process unavailable:', e.message);
    return null;
  }
}

async function getProductCallingLoadByAgent(email) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT COUNT(*) AS n FROM CLS_productcalling
    WHERE LOWER(agent_email) = LOWER(${email}) AND live_lead_ref IS NOT NULL AND disposed_at IS NULL
  `;
  return Number(rows[0].n) || 0;
}

async function getProductCallingQuotaAndLoad(email) {
  const quotaOverride = await getProductCallingAgentQuota(email);
  const processDefault = await getCallingDefaultQuota('productkyc');
  const quota = quotaOverride != null ? quotaOverride : (processDefault != null ? processDefault : PRODUCTCALLING_FALLBACK_QUOTA);
  const load = await getProductCallingLoadByAgent(email);
  return { quota, load };
}

// Unlike getNextDetractorLead (peek a read-only source table, then INSERT a copy), leads here
// already live in this table from the CSV import - claiming is a single UPDATE...LIMIT 1
// against the unassigned rows, then a SELECT (MySQL has no UPDATE...RETURNING). The UPDATE
// alone is not race-free across two concurrent callers picking the same row - the ER_DUP_ENTRY
// retry in assignProductCallingLeadsToAgent's loop (same shape as
// assignDetractorLeadsToAgent's) covers that, same reasoning as RTO's claim path.
async function claimNextProductCallingLead(email) {
  await ensureSchema();
  const sortDirection = (await getCallingLeadOrder('productkyc')) === 'newest' ? 'DESC' : 'ASC';
  const { rows: candidates } = await sql`
    SELECT id, lead_ref FROM CLS_productcalling
    WHERE agent_email IS NULL
    ORDER BY ${raw(sortDirection === 'DESC' ? 'imported_at DESC' : 'imported_at ASC')}
    LIMIT 1
  `;
  if (!candidates.length) return null;
  const { id, lead_ref: leadRef } = candidates[0];
  const { rowCount } = await sql`
    UPDATE CLS_productcalling SET agent_email = ${email}, assigned_at = NOW()
    WHERE id = ${id} AND agent_email IS NULL
  `;
  // Someone else claimed this exact row between the SELECT and the UPDATE - report it as a dup
  // race so the caller's retry loop (assignProductCallingLeadsToAgent) tries the next row rather
  // than silently returning nothing for a pool that isn't actually empty.
  if (!rowCount) {
    const e = new Error(`Duplicate claim race on lead ${leadRef}`);
    e.code = 'ER_DUP_ENTRY';
    throw e;
  }
  const { rows: claimed } = await sql`SELECT * FROM CLS_productcalling WHERE id = ${id}`;
  return claimed[0];
}

// Same claim-loop shape as assignDetractorLeadsToAgent (db.js:2183) - stops at maxCount, retries
// a duplicate-claim race on the same slot, gives up on that one slot after
// DETRACTOR_CLAIM_DUP_RETRIES retries without aborting the whole batch, stops immediately (no
// more retries) the moment claimFn cleanly returns null (pool genuinely empty).
async function assignProductCallingLeadsToAgent(email, maxCount, claimFn = claimNextProductCallingLead) {
  const claimed = [];
  for (let i = 0; i < maxCount; i++) {
    let lead = null;
    let gaveUpOnDup = false;
    for (let attempt = 0; attempt <= DETRACTOR_CLAIM_DUP_RETRIES; attempt++) {
      try {
        lead = await claimFn(email);
        break;
      } catch (e) {
        if (!(e && e.code === 'ER_DUP_ENTRY')) throw e;
        if (attempt === DETRACTOR_CLAIM_DUP_RETRIES) { gaveUpOnDup = true; break; }
      }
    }
    if (gaveUpOnDup) continue;
    if (!lead) break;
    claimed.push(lead);
  }
  return claimed;
}

// Same shape as topUpDetractorAgent (db.js:2229) - the shared entry point both auto-assign
// triggers (going Online, 2-minute heartbeat) go through. deps exists only for this file's own
// test, same injectable-seam reasoning as claimFn above.
async function topUpProductCallingAgent(email, deps = {}) {
  const availabilityFn = deps.availabilityFn || getProductCallingAgentAvailability;
  const quotaLoadFn = deps.quotaLoadFn || getProductCallingQuotaAndLoad;
  const assignFn = deps.assignFn || assignProductCallingLeadsToAgent;
  if (!email) return [];
  if ((await availabilityFn(email)) !== 'Online') return [];
  const { quota, load } = await quotaLoadFn(email);
  if (load >= quota) return [];
  return assignFn(email, quota - load);
}

// Same shape as disposeDetractorLead (db.js:2294). Ownership + not-already-disposed enforced in
// the WHERE clause; allowAnyAgent (admin/process-admin override, checked by the caller - see
// api/productcalling/lead-assignment.js) drops the ownership check. Returns the lead's
// agent_email either way so the caller can log an override.
async function disposeProductCallingLead(leadRef, disposition, agentRemarks, connected, attempt, email, { allowAnyAgent = false } = {}) {
  await ensureSchema();
  const { rows: existing } = await sql`SELECT agent_email FROM CLS_productcalling WHERE lead_ref = ${leadRef}`;
  const originalAgentEmail = existing.length ? existing[0].agent_email : null;
  if (allowAnyAgent) {
    await sql`
      UPDATE CLS_productcalling
      SET disposed_at = NOW(), disposition = ${disposition || null}, agent_remarks = ${agentRemarks || null},
          connected = ${connected || null}, attempt = ${attempt || null}
      WHERE lead_ref = ${leadRef} AND disposed_at IS NULL
    `;
  } else {
    await sql`
      UPDATE CLS_productcalling
      SET disposed_at = NOW(), disposition = ${disposition || null}, agent_remarks = ${agentRemarks || null},
          connected = ${connected || null}, attempt = ${attempt || null}
      WHERE lead_ref = ${leadRef} AND LOWER(agent_email) = LOWER(${email}) AND disposed_at IS NULL
    `;
  }
  return { originalAgentEmail };
}

// Bulk-inserts CSV-imported rows as unassigned leads (agent_email left NULL). INSERT IGNORE on
// lead_ref (via CLS_productcalling's own UNIQUE KEY on live_lead_ref, which for a fresh row
// equals lead_ref since reassigned_away_at is NULL) means a re-upload of the same export does
// not duplicate live rows - same convention every CSV importer in this codebase uses. Sequential,
// not a single multi-row statement - this codebase's other per-row importers (e.g. NDR's
// disposeNdrLead insert loop, db.js:1850) follow the same shape, and admin CSV uploads here are
// expected to be small (tens to low hundreds of rows), not RTO/NDR's thousands.
async function insertProductCallingLeads(rows, importedBy) {
  await ensureSchema();
  let inserted = 0;
  let duplicates = 0;
  for (const row of rows) {
    const { rowCount } = await sql`
      INSERT IGNORE INTO CLS_productcalling
        (lead_ref, customer_name, customer_phone, customer_email, product_key, product_category, notes, imported_by)
      VALUES (${row.leadRef}, ${row.customerName || null}, ${row.customerPhone}, ${row.customerEmail || null},
              ${row.productKey || null}, ${row.productCategory || null}, ${row.notes || null}, ${importedBy || null})
    `;
    if (rowCount) inserted += 1; else duplicates += 1;
  }
  return { inserted, duplicates };
}

async function getProductCallingTicketsForAgent(email) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT * FROM CLS_productcalling WHERE LOWER(agent_email) = LOWER(${email}) ORDER BY assigned_at DESC
  `;
  return rows;
}

async function getAllProductCallingTickets() {
  await ensureSchema();
  const { rows } = await sql`SELECT * FROM CLS_productcalling ORDER BY assigned_at DESC`;
  return rows;
}

async function getUnassignedProductCallingLeads(limit = 20) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT id, lead_ref, customer_name, customer_phone, product_key, product_category, imported_at
    FROM CLS_productcalling
    WHERE agent_email IS NULL
    ORDER BY imported_at ASC
    LIMIT ${raw(safeLimit(limit, 20))}
  `;
  return rows;
}
```

**Note on `rowCount`:** `sql` (the tagged-template helper wrapping this codebase's MySQL driver) returns `{ rows, rowCount }` for `SELECT`s and `{ rowCount }`-shaped results for `UPDATE`/`INSERT` — confirm this against any other `UPDATE ... `sql`` call already in `api/_lib/db.js` (e.g. `disposeDetractorLead`'s `UPDATE` at db.js:2299-2304, which discards the result) before relying on `rowCount` being present; if the helper does not surface affected-row count, use `SELECT ROW_COUNT()` immediately after the `UPDATE`/`INSERT IGNORE` instead, matching whatever pattern the rest of `db.js` already uses for "did this write actually change a row".

- [ ] **Step 2: Add the new names to `module.exports`**

In `api/_lib/db.js`, modify the block at lines 5918-5920 from:

```js
  getDetractorAgentQuota, getDetractorAgentAvailability, getDetractorLoadByAgent, getDetractorQuotaAndLoad,
  getNextDetractorLead, getUnassignedDetractorLeads, disposeDetractorLead, getDetractorTicketsForAgent, getAllDetractorTickets,
  assignDetractorLeadsToAgent, topUpDetractorAgent, safeLimit, raw, buildSqlText,
```

to:

```js
  getDetractorAgentQuota, getDetractorAgentAvailability, getDetractorLoadByAgent, getDetractorQuotaAndLoad,
  getNextDetractorLead, getUnassignedDetractorLeads, disposeDetractorLead, getDetractorTicketsForAgent, getAllDetractorTickets,
  assignDetractorLeadsToAgent, topUpDetractorAgent, safeLimit, raw, buildSqlText,
  PRODUCTCALLING_FALLBACK_QUOTA, getProductCallingAgentQuota, getProductCallingAgentAvailability,
  getProductCallingLoadByAgent, getProductCallingQuotaAndLoad, claimNextProductCallingLead,
  assignProductCallingLeadsToAgent, topUpProductCallingAgent, disposeProductCallingLead,
  insertProductCallingLeads, getProductCallingTicketsForAgent, getAllProductCallingTickets,
  getUnassignedProductCallingLeads,
```

- [ ] **Step 3: Write the failing test**

Create `api/_lib/db.productCallingAssign.test.js` (same shape as `api/_lib/db.detractorAssign.test.js`, targeting the new claim-loop and top-up functions):

```js
// Self-check for assignProductCallingLeadsToAgent's loop control and topUpProductCallingAgent's
// guard order - pure once claimFn/deps are stubbed out, no database involved.
// Run with `node api/_lib/db.productCallingAssign.test.js`.
const assert = require('assert');
const { assignProductCallingLeadsToAgent, topUpProductCallingAgent } = require('./db');

(async () => {
  {
    let calls = 0;
    const claimFn = async () => { calls += 1; return { lead_ref: `L${calls}` }; };
    const claimed = await assignProductCallingLeadsToAgent('a@x.com', 3, claimFn);
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(claimed.map((c) => c.lead_ref), ['L1', 'L2', 'L3']);
  }
  {
    let calls = 0;
    const claimFn = async () => { calls += 1; return calls <= 2 ? { lead_ref: `L${calls}` } : null; };
    const claimed = await assignProductCallingLeadsToAgent('a@x.com', 5, claimFn);
    assert.strictEqual(calls, 3, 'must stop at the first null, not keep calling for the remaining slots');
    assert.strictEqual(claimed.length, 2);
  }
  {
    let calls = 0;
    const claimFn = async () => { calls += 1; return { lead_ref: 'L1' }; };
    const claimed = await assignProductCallingLeadsToAgent('a@x.com', 0, claimFn);
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(claimed, []);
  }
  {
    let calls = 0;
    const claimFn = async () => {
      calls += 1;
      if (calls === 1) {
        const e = new Error('Duplicate entry');
        e.code = 'ER_DUP_ENTRY';
        throw e;
      }
      return { lead_ref: `L${calls}` };
    };
    const claimed = await assignProductCallingLeadsToAgent('a@x.com', 2, claimFn);
    assert.strictEqual(calls, 3, 'must retry the colliding slot, not abort the loop');
    assert.deepStrictEqual(claimed.map((c) => c.lead_ref), ['L2', 'L3']);
  }
  {
    const claimFn = async () => { throw new Error('connection reset'); };
    await assert.rejects(
      () => assignProductCallingLeadsToAgent('a@x.com', 2, claimFn),
      /connection reset/,
    );
  }
  {
    let quotaCalls = 0, assignCalls = 0;
    const claimed = await topUpProductCallingAgent('a@x.com', {
      availabilityFn: async () => 'Offline',
      quotaLoadFn: async () => { quotaCalls += 1; return { quota: 15, load: 0 }; },
      assignFn: async () => { assignCalls += 1; return [{ lead_ref: 'L1' }]; },
    });
    assert.deepStrictEqual(claimed, []);
    assert.strictEqual(quotaCalls, 0, 'must short-circuit before the quota lookup');
    assert.strictEqual(assignCalls, 0);
  }
  {
    let assignCalls = 0;
    const claimed = await topUpProductCallingAgent('a@x.com', {
      availabilityFn: async () => 'Online',
      quotaLoadFn: async () => ({ quota: 10, load: 12 }),
      assignFn: async () => { assignCalls += 1; return []; },
    });
    assert.deepStrictEqual(claimed, []);
    assert.strictEqual(assignCalls, 0, 'over-quota must not reach assignProductCallingLeadsToAgent');
  }
  {
    let asked = null;
    const claimed = await topUpProductCallingAgent('a@x.com', {
      availabilityFn: async () => 'Online',
      quotaLoadFn: async () => ({ quota: 15, load: 11 }),
      assignFn: async (email, count) => { asked = { email, count }; return [{ lead_ref: 'L1' }]; },
    });
    assert.deepStrictEqual(asked, { email: 'a@x.com', count: 4 });
    assert.strictEqual(claimed.length, 1);
  }
  {
    let availabilityCalls = 0;
    const claimed = await topUpProductCallingAgent('', {
      availabilityFn: async () => { availabilityCalls += 1; return 'Online'; },
    });
    assert.deepStrictEqual(claimed, []);
    assert.strictEqual(availabilityCalls, 0);
  }

  console.log('db.productCallingAssign.test.js: all assertions passed');
})();
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node api/_lib/db.productCallingAssign.test.js`
Expected: `db.productCallingAssign.test.js: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add api/_lib/db.js api/_lib/db.productCallingAssign.test.js
git commit -m "feat(product-calling): add claim/assign/dispose/list functions"
```

---

### Task 3: CSV import validation helper

**Files:**
- Create: `api/_lib/productCallingCsvImport.js`
- Test: `api/_lib/productCallingCsvImport.test.js`

**Interfaces:**
- Consumes: nothing (pure function over already-`parseCSV`'d row objects).
- Produces (consumed by Task 4): `planProductCallingImport(csvRows: Array<{[header:string]:string}>): {validRows: Array<{leadRef, customerName, customerPhone, customerEmail, productKey, productCategory, notes}>, errors: Array<{line:number, reason:string}>, counts: {missingPhone:number, duplicateInFile:number}}`
  - `PRODUCTCALLING_REQUIRED_CSV_HEADERS: string[]` (`['Customer Name', 'Customer Phone']`)

- [ ] **Step 1: Write the failing test**

Create `api/_lib/productCallingCsvImport.test.js`:

```js
// Self-check for planProductCallingImport - pure, no database. Run with
// `node api/_lib/productCallingCsvImport.test.js`.
const assert = require('assert');
const { planProductCallingImport } = require('./productCallingCsvImport');

// A valid row with every optional field, plus an explicit Lead Ref.
{
  const { validRows, errors, counts } = planProductCallingImport([
    { 'Lead Ref': 'R1', 'Customer Name': 'Asha', 'Customer Phone': '9876543210', 'Customer Email': 'a@x.com', Product: 'Balm', 'Product Category': 'lipbalms', Notes: 'Left VM' },
  ]);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(counts.missingPhone, 0);
  assert.deepStrictEqual(validRows, [{
    leadRef: 'R1', customerName: 'Asha', customerPhone: '9876543210', customerEmail: 'a@x.com',
    productKey: 'Balm', productCategory: 'lipbalms', notes: 'Left VM',
  }]);
}

// No Lead Ref column at all: falls back to the phone number as the dedup key.
{
  const { validRows } = planProductCallingImport([
    { 'Customer Name': 'Bala', 'Customer Phone': '9000000001' },
  ]);
  assert.strictEqual(validRows[0].leadRef, '9000000001');
}

// Missing phone: skipped and reported, not written.
{
  const { validRows, errors, counts } = planProductCallingImport([
    { 'Customer Name': 'No Phone', 'Customer Phone': '' },
  ]);
  assert.strictEqual(validRows.length, 0);
  assert.strictEqual(counts.missingPhone, 1);
  assert.strictEqual(errors.length, 1);
  assert.ok(/phone/i.test(errors[0].reason));
}

// Two rows with the same lead ref (explicit) in one file: second is a duplicate-in-file, not
// silently dropped without a reason.
{
  const { validRows, errors, counts } = planProductCallingImport([
    { 'Lead Ref': 'R1', 'Customer Name': 'A', 'Customer Phone': '111' },
    { 'Lead Ref': 'R1', 'Customer Name': 'A again', 'Customer Phone': '111' },
  ]);
  assert.strictEqual(validRows.length, 1);
  assert.strictEqual(counts.duplicateInFile, 1);
  assert.ok(errors.some((e) => /duplicate/i.test(e.reason)));
}

console.log('productCallingCsvImport.test.js: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node api/_lib/productCallingCsvImport.test.js`
Expected: FAIL with `Cannot find module './productCallingCsvImport'`

- [ ] **Step 3: Write the implementation**

Create `api/_lib/productCallingCsvImport.js`:

```js
// Pure CSV-row validation/planning for the Product Calling admin upload
// (api/productcalling/upload.js). Deliberately not built on rtoCsvImport.js's engine - that
// engine's job is syncing rows into a live Google Sheet (column-letter mapping, header-drift
// detection), which does not apply here: Product Calling has no backing Sheet, leads land
// straight into CLS_productcalling (see api/_lib/db.js's insertProductCallingLeads). Lives here,
// next to nothing but its own logic, so it can be unit-tested without a session/DB - the caller
// (api/productcalling/upload.js) is an HTTP handler that needs both before any of this runs.
const PRODUCTCALLING_REQUIRED_CSV_HEADERS = ['Customer Name', 'Customer Phone'];

// line is 1-based and counts the header row as line 1, matching every other CSV importer in
// this codebase (see ndrCsvImport.js's own `line` convention) - csvRows here is already
// header-stripped (parseCSV's output), so row index 0 is line 2.
function planProductCallingImport(csvRows) {
  const validRows = [];
  const errors = [];
  const counts = { missingPhone: 0, duplicateInFile: 0 };
  const seenLeadRefs = new Set();

  csvRows.forEach((row, idx) => {
    const line = idx + 2;
    const phone = (row['Customer Phone'] || '').trim();
    if (!phone) {
      counts.missingPhone += 1;
      errors.push({ line, reason: 'Skipped - Customer Phone is required and was blank' });
      return;
    }
    const leadRef = (row['Lead Ref'] || '').trim() || phone;
    if (seenLeadRefs.has(leadRef)) {
      counts.duplicateInFile += 1;
      errors.push({ line, reason: `Skipped - duplicate lead ref/phone "${leadRef}" already seen earlier in this file` });
      return;
    }
    seenLeadRefs.add(leadRef);
    validRows.push({
      leadRef,
      customerName: (row['Customer Name'] || '').trim() || null,
      customerPhone: phone,
      customerEmail: (row['Customer Email'] || '').trim() || null,
      productKey: (row['Product'] || '').trim() || null,
      productCategory: (row['Product Category'] || '').trim() || null,
      notes: (row['Notes'] || '').trim() || null,
    });
  });

  return { validRows, errors, counts };
}

module.exports = { planProductCallingImport, PRODUCTCALLING_REQUIRED_CSV_HEADERS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node api/_lib/productCallingCsvImport.test.js`
Expected: `productCallingCsvImport.test.js: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add api/_lib/productCallingCsvImport.js api/_lib/productCallingCsvImport.test.js
git commit -m "feat(product-calling): add CSV import validation helper"
```

---

### Task 4: `api/productcalling/upload.js`

**Files:**
- Create: `api/productcalling/upload.js`

**Interfaces:**
- Consumes: `getSession(req)` (`api/_lib/session.js`), `parseCSV(text)` (`api/_lib/csv.js`), `planProductCallingImport`/`PRODUCTCALLING_REQUIRED_CSV_HEADERS` (Task 3), `insertProductCallingLeads(rows, importedBy)`/`isCallingProcessAdmin(email, processKey)` (Task 2 / existing db.js).
- Produces: `POST /api/productcalling/upload` — request `{csv: string}`, response `{inserted, duplicates, missingPhone, duplicateInFile, total, errors: Array<{line,reason}>}` on 200, `{error}` on 400/401/403/500.

- [ ] **Step 1: Write the route**

Create `api/productcalling/upload.js`:

```js
// POST /api/productcalling/upload - admin or this process's admin only. Bulk-adds leads from a
// CSV straight into CLS_productcalling as unassigned rows. Interim lead-intake mechanism until
// the real lead source is confirmed (see docs/superpowers/specs/2026-09-16-product-calling-design.md)
// - deliberately NOT built on rtoCsvImport.js's Sheet-sync engine, since there is no Sheet here.
const { getSession } = require('../_lib/session');
const { parseCSV } = require('../_lib/csv');
const { planProductCallingImport, PRODUCTCALLING_REQUIRED_CSV_HEADERS } = require('../_lib/productCallingCsvImport');
const { insertProductCallingLeads, isCallingProcessAdmin } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'productkyc';
const MAX_ROWS = 5000;

async function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, TAB_KEY))) {
    return 'Only admins or this process\'s admin can upload leads.';
  }
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Product Calling.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Product Calling.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  const denied = await checkAccess(session);
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

  const csvHeaders = Object.keys(csvRows[0]);
  const missingCsvHeaders = PRODUCTCALLING_REQUIRED_CSV_HEADERS.filter((h) => !csvHeaders.includes(h));
  if (missingCsvHeaders.length) {
    res.status(400).json({
      error: `This CSV is missing required column(s): ${missingCsvHeaders.join(', ')}.`,
      csvHeaders,
    });
    return;
  }

  try {
    const plan = planProductCallingImport(csvRows);
    const { inserted, duplicates } = plan.validRows.length
      ? await insertProductCallingLeads(plan.validRows, session.email)
      : { inserted: 0, duplicates: 0 };

    const MAX_REPORTED_ERRORS = 50;
    res.status(200).json({
      inserted,
      duplicates,
      missingPhone: plan.counts.missingPhone,
      duplicateInFile: plan.counts.duplicateInFile,
      total: csvRows.length,
      errors: plan.errors.slice(0, MAX_REPORTED_ERRORS),
    });
  } catch (e) {
    console.error('api/productcalling/upload error:', e);
    res.status(500).json({ error: e.message || 'Could not process this upload' });
  }
};
```

- [ ] **Step 2: Write a self-check for the access gate logic**

Since this handler needs a session/DB to run end-to-end (no live-DB runs), verify the module loads and exports a function:

```js
// api/productcalling/upload.test.js
const assert = require('assert');
const handler = require('./upload');
assert.strictEqual(typeof handler, 'function', 'api/productcalling/upload.js must export a request handler');
console.log('api/productcalling/upload.test.js: all assertions passed');
```

- [ ] **Step 3: Run it**

Run: `node api/productcalling/upload.test.js`
Expected: `api/productcalling/upload.test.js: all assertions passed`

- [ ] **Step 4: Commit**

```bash
git add api/productcalling/upload.js api/productcalling/upload.test.js
git commit -m "feat(product-calling): add CSV upload API route"
```

---

### Task 5: `api/productcalling/lead-assignment.js`

**Files:**
- Create: `api/productcalling/lead-assignment.js`

**Interfaces:**
- Consumes: `getSession(req)`, `disposeProductCallingLead`, `isCallingProcessAdmin`, `getProductCallingAgentAvailability`, `getProductCallingQuotaAndLoad`, `assignProductCallingLeadsToAgent` (all Task 2).
- Produces: `POST /api/productcalling/lead-assignment` — request `{action: 'dispose', leadRef, disposition, agentRemarks, connected, attempt}`, response `{ok: true, assignedLeads: object[]}`.

- [ ] **Step 1: Write the route**

Create `api/productcalling/lead-assignment.js` (same shape as `api/detractor/lead-assignment.js`, minus `affectedProducts`/override-audit-log, which have no Product-Calling equivalent):

```js
// The only way the browser disposes a Product Calling lead. No 'claim' action - a lead only
// ever becomes this agent's via the two auto-assign triggers (going Online, in
// api/auth/[action].js; and this file's own post-dispose self-refill below), same as NPS-Calling.
const { getSession } = require('../_lib/session');
const {
  disposeProductCallingLead, isCallingProcessAdmin,
  getProductCallingAgentAvailability, getProductCallingQuotaAndLoad, assignProductCallingLeadsToAgent,
} = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'productkyc';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Product Calling.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Product Calling.';
  return null;
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

  const { action, leadRef, disposition, agentRemarks, connected, attempt } = req.body || {};
  if (!leadRef) {
    res.status(400).json({ error: 'leadRef is required' });
    return;
  }
  if (action !== 'dispose') {
    res.status(400).json({ error: 'Unknown action' });
    return;
  }

  try {
    const allowAnyAgent = session.isAdmin || (await isCallingProcessAdmin(session.email, TAB_KEY));
    const { originalAgentEmail } = await disposeProductCallingLead(
      leadRef, disposition, agentRemarks, connected, attempt, session.email, { allowAnyAgent },
    );
    const isOverrideOntoSomeoneElse = allowAnyAgent && originalAgentEmail
      && originalAgentEmail.toLowerCase() !== session.email.toLowerCase();

    let assignedLeads = [];
    try {
      if (!isOverrideOntoSomeoneElse) {
        const stillOnline = (await getProductCallingAgentAvailability(session.email)) === 'Online';
        if (stillOnline) {
          const { quota, load } = await getProductCallingQuotaAndLoad(session.email);
          if (load < quota) {
            assignedLeads = await assignProductCallingLeadsToAgent(session.email, 1);
          }
        }
      }
    } catch (e) {
      console.error('api/productcalling/lead-assignment: self-refill failed:', e.message || e);
    }
    res.status(200).json({ ok: true, assignedLeads });
  } catch (e) {
    console.error('api/productcalling/lead-assignment error:', e);
    res.status(500).json({ error: e.message || 'Could not record disposition' });
  }
};
```

- [ ] **Step 2: Self-check module loads**

Create `api/productcalling/lead-assignment.test.js`:

```js
const assert = require('assert');
const handler = require('./lead-assignment');
assert.strictEqual(typeof handler, 'function');
console.log('api/productcalling/lead-assignment.test.js: all assertions passed');
```

- [ ] **Step 3: Run it**

Run: `node api/productcalling/lead-assignment.test.js`
Expected: `all assertions passed`

- [ ] **Step 4: Commit**

```bash
git add api/productcalling/lead-assignment.js api/productcalling/lead-assignment.test.js
git commit -m "feat(product-calling): add dispose API route with self-refill"
```

---

### Task 6: `api/productcalling/tickets.js`

**Files:**
- Create: `api/productcalling/tickets.js`

**Interfaces:**
- Consumes: `getSession(req)`, `getProductCallingTicketsForAgent`, `getAllProductCallingTickets`, `getUnassignedProductCallingLeads`, `isCallingProcessAdmin` (Task 2).
- Produces: `GET /api/productcalling/tickets` (own tickets), `?scope=all` (every ticket, admin/process-admin only), `?scope=unassigned` (pool preview, admin/process-admin only) — response `{tickets: object[]}` or `{leads: object[]}`.

- [ ] **Step 1: Write the route**

Create `api/productcalling/tickets.js` (same shape as `api/detractor/tickets.js`):

```js
// GET-only: lists Product Calling tickets for the "Fresh Leads"/"All Leads" tabs (own tickets)
// and the admin/process-admin scopes (?scope=all, ?scope=unassigned pool preview).
const { getSession } = require('../_lib/session');
const { getProductCallingTicketsForAgent, getAllProductCallingTickets, getUnassignedProductCallingLeads, isCallingProcessAdmin } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'productkyc';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Product Calling.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Product Calling.';
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

  try {
    if (req.query.scope === 'all' || req.query.scope === 'unassigned') {
      const allowed = session.isAdmin || (await isCallingProcessAdmin(session.email, TAB_KEY));
      if (!allowed) {
        res.status(403).json({ error: 'Only an admin or Product Calling process admin can view this.' });
        return;
      }
      if (req.query.scope === 'unassigned') {
        res.status(200).json({ leads: await getUnassignedProductCallingLeads(20) });
        return;
      }
      res.status(200).json({ tickets: await getAllProductCallingTickets() });
      return;
    }
    res.status(200).json({ tickets: await getProductCallingTicketsForAgent(session.email) });
  } catch (e) {
    console.error('api/productcalling/tickets error:', e);
    res.status(500).json({ error: e.message || 'Could not load tickets' });
  }
};
```

- [ ] **Step 2: Self-check module loads**

Create `api/productcalling/tickets.test.js`:

```js
const assert = require('assert');
const handler = require('./tickets');
assert.strictEqual(typeof handler, 'function');
console.log('api/productcalling/tickets.test.js: all assertions passed');
```

- [ ] **Step 3: Run it**

Run: `node api/productcalling/tickets.test.js`
Expected: `all assertions passed`

- [ ] **Step 4: Commit**

```bash
git add api/productcalling/tickets.js api/productcalling/tickets.test.js
git commit -m "feat(product-calling): add tickets list API route"
```

---

### Task 7: Auto-assign trigger wiring in `api/auth/[action].js`

**Files:**
- Modify: `api/auth/[action].js:1-21` (add helper + import), `api/auth/[action].js:355-379` (heartbeat branch), and the twin `processKey === 'detractor'` branch at `api/auth/[action].js:588` region.

**Interfaces:**
- Consumes: `topUpProductCallingAgent` (Task 2).
- Produces: an Online agent on Product Calling now gets auto-filled on going-Online and on the 2-minute heartbeat, same as NPS-Calling.

- [ ] **Step 1: Add the import and access helper**

In `api/auth/[action].js`, find the existing import at the top that includes `topUpDetractorAgent` (line 6) and add `topUpProductCallingAgent` to the same `require`:

```js
  topUpDetractorAgent, topUpProductCallingAgent } = require('../_lib/db');
```

Immediately after `hasDetractorAccess` (api/auth/[action].js:17-21), add:

```js
function hasProductCallingAccess(session) {
  const callingTabs = session.tabPerms && session.tabPerms.calling;
  return (session.perms || []).includes('calling')
    && !(Array.isArray(callingTabs) && callingTabs.length && !callingTabs.includes('productkyc'));
}
```

- [ ] **Step 2: Add the heartbeat branch**

In `api/auth/[action].js`, immediately after the existing block at lines 368-375:

```js
  if (body.processKey === 'detractor' && body.status === 'Online'
      && !(session.isAdmin && body.email) && hasDetractorAccess(session)) {
    try {
      await topUpDetractorAgent(session.email);
    } catch (e) {
      console.error('handlePresence: detractor heartbeat top-up failed:', e.message || e);
    }
  }
```

add:

```js
  if (body.processKey === 'productkyc' && body.status === 'Online'
      && !(session.isAdmin && body.email) && hasProductCallingAccess(session)) {
    try {
      await topUpProductCallingAgent(session.email);
    } catch (e) {
      console.error('handlePresence: productkyc heartbeat top-up failed:', e.message || e);
    }
  }
```

- [ ] **Step 3: Add the going-Online branch**

Read `api/auth/[action].js` around line 588 (the twin `body.status === 'Online' && body.processKey === 'detractor'` check, inside `handleProcessPresence`) before editing, to match its exact surrounding structure (it may be an `if/else if` chain rather than a standalone `if`, unlike the heartbeat's standalone block above). Add an equivalent `body.processKey === 'productkyc'` branch there calling `topUpProductCallingAgent(session.email)`, following whichever control-flow shape (chained `else if` vs. separate `if`) the existing `detractor` branch uses, so `productkyc` is handled consistently rather than falling through to something the `detractor` branch intentionally skips.

- [ ] **Step 4: Self-check the file still loads**

Run: `node -e "require('./api/auth/[action].js')"`
Expected: no output, exit code 0 (module loads without throwing)

- [ ] **Step 5: Commit**

```bash
git add "api/auth/[action].js"
git commit -m "feat(product-calling): wire auto-assign triggers for productkyc"
```

---

### Task 8: `callingProcesses.json` — flip the process live

**Files:**
- Modify: `api/_lib/callingProcesses.json:106-118`

**Interfaces:**
- Produces: `productkyc` process entry with `label: "Product Calling"`, `implemented: true` — read by `api/_lib/tabs.js` (permissions checkbox) and `app/rto-crm/RtoCrmClient.js` (unaffected, since this process was already excluded from RTO's Process switcher by having its own page per Task 10).

- [ ] **Step 1: Edit the entry**

In `api/_lib/callingProcesses.json`, change:

```json
    {
      "key": "productkyc",
      "label": "Product KYC Calling",
      "icon": "🧪",
      "implemented": false,
      "blurb": "Product feedback KYC calls. Source is the \"Product feedback KYC\" workbook (see scripts/productkyc_config.py), where every product tab has its own bespoke question schema - so the calling form is per-product, not one fixed set of fields.",
```

to:

```json
    {
      "key": "productkyc",
      "label": "Product Calling",
      "icon": "🧪",
      "implemented": true,
      "blurb": "Product feedback follow-up calls. Leads arrive via admin CSV upload into CLS_productcalling (app/product-calling/) until the real lead source - eventually the \"Product feedback KYC\" workbook, see scripts/productkyc_config.py - is confirmed and wired in. Disposition tree is admin-configured from scratch, not the per-product bespoke question schema that workbook implies.",
```

(businessHours block is unchanged.)

- [ ] **Step 2: Self-check the JSON is still valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('api/_lib/callingProcesses.json','utf8'))"`
Expected: no output, exit code 0

- [ ] **Step 3: Commit**

```bash
git add api/_lib/callingProcesses.json
git commit -m "feat(product-calling): flip productkyc process live as Product Calling"
```

---

### Task 9: Sidebar entry

**Files:**
- Modify: `app/HomeClient.js:71-82`

**Interfaces:**
- Produces: "Product Calling" appears in the Calling Team sidebar, directly below "NPS-Calling", above "Exports".

- [ ] **Step 1: Edit `CALLING_TEAM_SUBITEMS`**

In `app/HomeClient.js`, change:

```js
var CALLING_TEAM_SUBITEMS = {
  overview: { label: 'Overview', text: 'Calling Team Overview', url: '/calling-overview' },
  rto: { label: 'RTO-Calling', text: 'RTO CRM Agent & Refund Portal', url: '/rto-crm' },
  ndr: { label: 'NDR-Calling', text: 'NDR Calling Agent Portal', url: '/ndr-calling' },
  escalation: { label: 'Escalation', text: 'Escalation Agent Portal', url: '/escalation' },
  deliveryescalation: { label: 'Delivery-Escalation', text: 'Delivery-Escalation Agent Portal', url: '/delivery-escalation' },
  // Key is 'detractor' (the process key from api/_lib/callingProcesses.json), not 'nps' - this
  // object's keys double as tab_key values checked against userTabPerms.calling, so it must match
  // the process key exactly even though the user-facing label is "NPS-Calling".
  detractor: { label: 'NPS-Calling', text: 'NPS Detractor Calling Agent Portal', url: '/nps-calling' },
  exports: { label: 'Exports', text: 'Exports', url: '/exports' }
};
```

to:

```js
var CALLING_TEAM_SUBITEMS = {
  overview: { label: 'Overview', text: 'Calling Team Overview', url: '/calling-overview' },
  rto: { label: 'RTO-Calling', text: 'RTO CRM Agent & Refund Portal', url: '/rto-crm' },
  ndr: { label: 'NDR-Calling', text: 'NDR Calling Agent Portal', url: '/ndr-calling' },
  escalation: { label: 'Escalation', text: 'Escalation Agent Portal', url: '/escalation' },
  deliveryescalation: { label: 'Delivery-Escalation', text: 'Delivery-Escalation Agent Portal', url: '/delivery-escalation' },
  // Key is 'detractor' (the process key from api/_lib/callingProcesses.json), not 'nps' - this
  // object's keys double as tab_key values checked against userTabPerms.calling, so it must match
  // the process key exactly even though the user-facing label is "NPS-Calling".
  detractor: { label: 'NPS-Calling', text: 'NPS Detractor Calling Agent Portal', url: '/nps-calling' },
  // Key is 'productkyc' (the process key from api/_lib/callingProcesses.json), same tab_key
  // convention as 'detractor' above - the user-facing label is "Product Calling".
  productkyc: { label: 'Product Calling', text: 'Product Calling Agent Portal', url: '/product-calling' },
  exports: { label: 'Exports', text: 'Exports', url: '/exports' }
};
```

Object key insertion order is render order (see `app/HomeClient.js:229,236`), so this alone places "Product Calling" directly below "NPS-Calling" with no other change needed.

- [ ] **Step 2: Self-check the file still loads**

Run: `node -e "require('./app/HomeClient.js')"` — this will likely fail with a JSX/`'use client'`-related error since it's a client component, not plain Node-loadable; if so, instead run a syntax-only check:

Run: `node --check app/HomeClient.js`
Expected: no output, exit code 0 (valid JS syntax)

- [ ] **Step 3: Commit**

```bash
git add app/HomeClient.js
git commit -m "feat(product-calling): add Product Calling sidebar entry"
```

---

### Task 10: Frontend scaffold — page, loader, core client (Fresh queue + dispose)

**Files:**
- Create: `app/product-calling/page.js`
- Create: `app/product-calling/ProductCallingClientLoader.js`
- Create: `app/product-calling/ProductCallingClient.js`

**Interfaces:**
- Consumes: `useCallingSession`, `STATUS_OPTIONS` (`app/_calling/useCallingSession.js`), `CallingShell` (`app/_calling/CallingShell.js`), `CustomSelect, Overlay, PhoneIcon, CheckIcon, XIcon` (`app/_calling/ui.js`), `scopeToDateBounds` (`app/_calling/util.js`), `useProcessDispositions` (Task 11 also uses this — imported here already since the dispose modal needs it).
- Produces: default export `ProductCallingClient` (Fresh Leads tab: ticket list + dispose modal). Task 11 extends this same file with the Admin tab; this task's `tab` state and `PROCESS_KEY` constant are what Task 11 builds on, so keep both exactly named `tab`/`PROCESS_KEY`.

- [ ] **Step 1: Create the page wrapper**

Create `app/product-calling/page.js`:

```js
import ProductCallingClient from './ProductCallingClientLoader';

export const metadata = {
  title: 'Product Calling — Agent Portal',
};

export default function Page() {
  return <ProductCallingClient />;
}
```

- [ ] **Step 2: Create the SSR-off loader**

Create `app/product-calling/ProductCallingClientLoader.js`:

```js
'use client';

// Same reasoning as app/nps-calling/NpsCallingClientLoader.js: the client's first render depends
// on localStorage (via useCallingSession), which doesn't exist during SSR. ssr:false sidesteps
// the resulting hydration-mismatch class of bug entirely.
import dynamic from 'next/dynamic';

const ProductCallingClient = dynamic(() => import('./ProductCallingClient'), { ssr: false });

export default ProductCallingClient;
```

- [ ] **Step 3: Create the core client**

Create `app/product-calling/ProductCallingClient.js`:

```js
'use client';

// Product Calling's own workspace (process key 'productkyc' - see
// api/_lib/callingProcesses.json). Built on the same shared app/_calling/ pieces as every other
// calling page. Unlike NPS-Calling, leads arrive via admin CSV upload (Task 11's Admin tab), not
// copy-on-assign from a read-only source table - see
// docs/superpowers/specs/2026-09-16-product-calling-design.md.
import { useState, useEffect, useCallback } from 'react';
import { XIcon, CheckIcon, PhoneIcon, CustomSelect, Overlay } from '../_calling/ui';
import { useCallingSession } from '../_calling/useCallingSession';
import { useProcessDispositions } from '../_calling/CallingAdminPanel';
import { CallingShell } from '../_calling/CallingShell';
import { scopeToDateBounds } from '../_calling/util';

const PROCESS_KEY = 'productkyc';

export default function ProductCallingClient() {
  const session = useCallingSession(PROCESS_KEY, {
    getDateBounds: () => scopeToDateBounds('ALL_TIME', '', ''),
  });
  const { googleUser, sessionIsAdmin, isProcessAdmin, showToast } = session;

  const disp = useProcessDispositions(PROCESS_KEY, { googleUser, showToast, strict: true });

  useEffect(() => {
    document.documentElement.className = 'light';
    document.body.className = 'font-sans antialiased min-h-screen theme-light';
  }, []);

  const canAdminTab = sessionIsAdmin || isProcessAdmin;
  const [tab, setTab] = useState('fresh');
  useEffect(() => {
    if (tab === 'admin' && !canAdminTab) setTab('fresh');
  }, [tab, canAdminTab]);

  const [tickets, setTickets] = useState([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const [lastSync, setLastSync] = useState('—');
  const fetchMyTickets = useCallback(async () => {
    setTicketsLoading(true);
    try {
      const r = await fetch('/api/productcalling/tickets');
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setTickets(d.tickets || []);
        setLastSync(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      } else {
        showToast(`⚠️ ${d.error || 'Could not load tickets'}`);
      }
    } catch (e) {
      showToast(`⚠️ ${e.message}`);
    } finally {
      setTicketsLoading(false);
    }
  }, [showToast]);
  useEffect(() => { if (googleUser?.email) fetchMyTickets(); }, [googleUser, fetchMyTickets]);

  const freshTickets = tickets.filter((t) => !t.disposed_at);
  const disposedTickets = tickets.filter((t) => t.disposed_at);

  // Dispose modal state - a simple two-level pick (category, then leaf) against the admin-
  // configured disposition tree, rather than NPS-Calling's multi-select-with-path tree: this
  // process has no per-area survey/affected-products concern to justify that complexity (see
  // the design spec's "Out of scope" section).
  const [detailTkt, setDetailTkt] = useState(null);
  const [categoryId, setCategoryId] = useState('');
  const [leafId, setLeafId] = useState('');
  const [dispRemarks, setDispRemarks] = useState('');
  const [connected, setConnected] = useState('');
  const [attempt, setAttempt] = useState(1);
  const [dispSaving, setDispSaving] = useState(false);

  const openDispose = (t) => {
    setDetailTkt(t);
    setCategoryId('');
    setLeafId('');
    setDispRemarks(t.agent_remarks || '');
    setConnected(t.connected || '');
    setAttempt(t.attempt || 1);
  };
  const closeDispose = () => setDetailTkt(null);

  const categories = (disp.processDispositions || []).filter((n) => !n.parent_id);
  const leaves = (disp.processDispositions || []).filter((n) => String(n.parent_id) === String(categoryId));
  const selectedLeaf = leaves.find((l) => String(l.id) === String(leafId));

  const submitDispose = async () => {
    if (!detailTkt || !selectedLeaf) { showToast('⚠️ Pick a disposition first'); return; }
    setDispSaving(true);
    try {
      const r = await fetch('/api/productcalling/lead-assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'dispose',
          leadRef: detailTkt.lead_ref,
          disposition: selectedLeaf.label,
          agentRemarks: dispRemarks,
          connected,
          attempt,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(`⚠️ ${d.error || 'Could not save'}`); return; }
      showToast(d.assignedLeads?.length ? '✅ Saved - next lead assigned' : '✅ Saved');
      closeDispose();
      fetchMyTickets();
    } catch (e) {
      showToast(`⚠️ ${e.message}`);
    } finally {
      setDispSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50">
      <CallingShell
        logoLabel="PC"
        title="Product Calling"
        lastSync={lastSync}
        syncing={ticketsLoading}
        onSync={fetchMyTickets}
        session={session}
      >
        <div className="max-w-[1440px] mx-auto px-3 sm:px-5 py-4">
          <div className="flex gap-2 mb-4">
            <button onClick={() => setTab('fresh')} className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${tab === 'fresh' ? 'bg-indigo-600 text-white' : 'bg-white text-zinc-600 border border-zinc-200'}`}>
              Fresh Leads ({freshTickets.length})
            </button>
            <button onClick={() => setTab('disposed')} className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${tab === 'disposed' ? 'bg-indigo-600 text-white' : 'bg-white text-zinc-600 border border-zinc-200'}`}>
              Disposed ({disposedTickets.length})
            </button>
            {canAdminTab && (
              <button onClick={() => setTab('admin')} className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${tab === 'admin' ? 'bg-indigo-600 text-white' : 'bg-white text-zinc-600 border border-zinc-200'}`}>
                Admin
              </button>
            )}
          </div>

          {(tab === 'fresh' || tab === 'disposed') && (
            <div className="bg-white rounded-xl border border-zinc-200 divide-y divide-zinc-100">
              {(tab === 'fresh' ? freshTickets : disposedTickets).length === 0 && (
                <div className="p-8 text-center text-sm text-zinc-400">
                  {ticketsLoading ? 'Loading…' : (tab === 'fresh' ? 'No leads assigned yet.' : 'Nothing disposed yet.')}
                </div>
              )}
              {(tab === 'fresh' ? freshTickets : disposedTickets).map((t) => (
                <div key={t.id} className="p-3 sm:p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm text-zinc-800 truncate">{t.customer_name || '—'}</div>
                    <div className="text-xs text-zinc-500 flex items-center gap-1.5">
                      <PhoneIcon /> {t.customer_phone}
                      {t.product_key && <span className="ml-2 px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">{t.product_key}</span>}
                    </div>
                    {t.disposed_at && <div className="text-xs text-emerald-600 mt-1">{t.disposition}</div>}
                  </div>
                  {tab === 'fresh' && (
                    <button onClick={() => openDispose(t)} className="shrink-0 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold">
                      Dispose
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'admin' && canAdminTab && (
            <div id="product-calling-admin-tab" className="text-sm text-zinc-500">
              {/* Populated by Task 11: roster/hours/quota/lead-order/dispositions cards + CSV upload. */}
            </div>
          )}
        </div>
      </CallingShell>

      {detailTkt && (
        <Overlay onClose={closeDispose}>
          <div className="bg-white rounded-2xl p-5 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-zinc-800">Dispose — {detailTkt.customer_name || detailTkt.customer_phone}</h3>
              <button onClick={closeDispose}><XIcon /></button>
            </div>

            <label className="block text-xs font-semibold text-zinc-500 mb-1">Connected?</label>
            <CustomSelect
              value={connected}
              onChange={setConnected}
              options={[{ value: 'Yes', label: 'Connected' }, { value: 'No', label: 'Not Connected' }]}
              placeholder="Select…"
              className="mb-3 w-full"
            />

            <label className="block text-xs font-semibold text-zinc-500 mb-1">Category</label>
            <CustomSelect
              value={categoryId}
              onChange={(v) => { setCategoryId(v); setLeafId(''); }}
              options={categories.map((c) => ({ value: String(c.id), label: c.label }))}
              placeholder="Select a category…"
              className="mb-3 w-full"
            />

            {categoryId && (
              <>
                <label className="block text-xs font-semibold text-zinc-500 mb-1">Disposition</label>
                <CustomSelect
                  value={leafId}
                  onChange={setLeafId}
                  options={leaves.map((l) => ({ value: String(l.id), label: l.label }))}
                  placeholder="Select a disposition…"
                  className="mb-3 w-full"
                />
              </>
            )}

            <label className="block text-xs font-semibold text-zinc-500 mb-1">Remarks</label>
            <textarea
              value={dispRemarks}
              onChange={(e) => setDispRemarks(e.target.value)}
              className="w-full border border-zinc-200 rounded-lg p-2 text-sm mb-4"
              rows={3}
            />

            <button
              onClick={submitDispose}
              disabled={dispSaving || !leafId}
              className="w-full py-2 rounded-lg bg-indigo-600 text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              <CheckIcon /> {dispSaving ? 'Saving…' : 'Save Disposition'}
            </button>
          </div>
        </Overlay>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Self-check syntax**

Run: `node --check app/product-calling/page.js && node --check app/product-calling/ProductCallingClientLoader.js && node --check app/product-calling/ProductCallingClient.js`
Expected: no output, exit code 0 for all three (JSX requires the project's own build/transpile step to fully verify — this check only catches gross syntax errors; the user verifies live rendering per the spec's manual verification steps)

- [ ] **Step 3: Commit**

```bash
git add app/product-calling/page.js app/product-calling/ProductCallingClientLoader.js app/product-calling/ProductCallingClient.js
git commit -m "feat(product-calling): add agent workspace (Fresh queue + dispose)"
```

---

### Task 11: Admin tab — roster/hours/quota/lead-order/dispositions + CSV upload

**Files:**
- Modify: `app/product-calling/ProductCallingClient.js` (the `tab === 'admin'` block from Task 10, and its imports)

**Interfaces:**
- Consumes: `useBusinessHours, CallingHoursCard, useDefaultQuota, DefaultQuotaCard, useLeadOrder, LeadOrderCard, ProcessDispositionsCard` (`app/_calling/CallingAdminPanel.js`) — `useProcessDispositions`/`disp` already wired in Task 10.
- Produces: a working Admin tab — business hours, default quota, lead order, disposition-tree editor (all generic, zero new backend), plus a CSV upload control posting to `/api/productcalling/upload` (Task 4).

- [ ] **Step 1: Extend the imports**

In `app/product-calling/ProductCallingClient.js`, change:

```js
import { useProcessDispositions } from '../_calling/CallingAdminPanel';
```

to:

```js
import {
  useBusinessHours, CallingHoursCard, useDefaultQuota, DefaultQuotaCard,
  useLeadOrder, LeadOrderCard, useProcessDispositions, ProcessDispositionsCard,
} from '../_calling/CallingAdminPanel';
```

- [ ] **Step 2: Add the admin hooks**

Immediately after the existing `const disp = useProcessDispositions(...)` line, add:

```js
  const hours = useBusinessHours(PROCESS_KEY, { userRole: session.userRole, isProcessAdmin, showToast });
  const defaultQuota = useDefaultQuota(PROCESS_KEY, { userRole: session.userRole, isProcessAdmin, showToast });
  const leadOrder = useLeadOrder(PROCESS_KEY, { userRole: session.userRole, isProcessAdmin, showToast });
```

- [ ] **Step 3: Add CSV upload state**

Immediately after the dispose-modal state block (after the `submitDispose` function), add:

```js
  const [csvText, setCsvText] = useState('');
  const [uploadResult, setUploadResult] = useState(null);
  const [uploading, setUploading] = useState(false);
  const submitUpload = async () => {
    if (!csvText.trim()) { showToast('⚠️ Paste or load a CSV first'); return; }
    setUploading(true);
    setUploadResult(null);
    try {
      const r = await fetch('/api/productcalling/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(`⚠️ ${d.error || 'Upload failed'}`); return; }
      setUploadResult(d);
      showToast(`✅ Imported ${d.inserted} lead(s)`);
      setCsvText('');
    } catch (e) {
      showToast(`⚠️ ${e.message}`);
    } finally {
      setUploading(false);
    }
  };
  const onCsvFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ''));
    reader.readAsText(file);
  };
```

- [ ] **Step 4: Replace the placeholder Admin tab block**

Replace the Task 10 placeholder:

```jsx
          {tab === 'admin' && canAdminTab && (
            <div id="product-calling-admin-tab" className="text-sm text-zinc-500">
              {/* Populated by Task 11: roster/hours/quota/lead-order/dispositions cards + CSV upload. */}
            </div>
          )}
```

with:

```jsx
          {tab === 'admin' && canAdminTab && (
            <div className="space-y-4">
              <div className="bg-white rounded-xl border border-zinc-200 p-4">
                <h3 className="font-bold text-zinc-800 mb-2 text-sm">Upload Leads (CSV)</h3>
                <p className="text-xs text-zinc-500 mb-2">
                  Required columns: Customer Name, Customer Phone. Optional: Lead Ref, Customer Email, Product, Product Category, Notes.
                </p>
                <input type="file" accept=".csv" onChange={onCsvFile} className="text-xs mb-2 block" />
                <textarea
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  placeholder="Or paste CSV text here"
                  className="w-full border border-zinc-200 rounded-lg p-2 text-xs mb-2 font-mono"
                  rows={4}
                />
                <button
                  onClick={submitUpload}
                  disabled={uploading}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold disabled:opacity-50"
                >
                  {uploading ? 'Uploading…' : 'Upload'}
                </button>
                {uploadResult && (
                  <div className="mt-2 text-xs text-zinc-600">
                    Imported {uploadResult.inserted}, duplicates {uploadResult.duplicates}, missing phone {uploadResult.missingPhone}, of {uploadResult.total} rows.
                    {uploadResult.errors?.length > 0 && (
                      <ul className="mt-1 list-disc pl-4 text-rose-600">
                        {uploadResult.errors.slice(0, 10).map((e, i) => <li key={i}>Line {e.line}: {e.reason}</li>)}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              <CallingHoursCard processLabel="Product Calling" hours={hours} />
              <DefaultQuotaCard processLabel="Product Calling" fallback={15} quota={defaultQuota} />
              <LeadOrderCard processLabel="Product Calling" order={leadOrder} />
              <ProcessDispositionsCard processLabel="Product Calling" disp={disp} />
            </div>
          )}
```

- [ ] **Step 5: Self-check syntax**

Run: `node --check app/product-calling/ProductCallingClient.js`
Expected: no output, exit code 0

- [ ] **Step 6: Commit**

```bash
git add app/product-calling/ProductCallingClient.js
git commit -m "feat(product-calling): add Admin tab (CSV upload, hours, quota, lead order, dispositions)"
```

---

## Manual verification (user performs — no live-DB/dev-server runs during implementation)

1. Admin uploads a CSV of leads on the Product Calling Admin tab; rows appear as unassigned in `CLS_productcalling`.
2. An agent going Online fills to quota from those rows; a 2-minute heartbeat top-up picks up rows uploaded after they went Online.
3. Disposing a ticket removes it from the agent's Fresh queue and immediately backfills one more, if available.
4. Admin Panel's Disposition List, Business Hours, Default Quota, and Lead Order cards all work for `productkyc` exactly as they do for the other processes.
5. Sidebar shows "Product Calling" directly below "NPS-Calling", above "Exports".
6. Admin → Permissions → Calling shows a "Product Calling" checkbox (from `callingProcesses.json`, no new code).
