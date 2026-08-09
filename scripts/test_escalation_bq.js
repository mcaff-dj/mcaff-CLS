// Self-check for the Escalation BigQuery layer used by the API. No framework, no live BigQuery:
// every test stubs globalThis.fetch, so this is safe to run anywhere.
//
//   npm run test:escalation
//
// Ingest is not tested here - it lives in Python, checked by scripts/test_escalation_ingest.py.
'use strict';
const assert = require('assert');

process.env.BQ_PROJECT_ID = 'test-project';
process.env.BQ_DATASET = 'escalation';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}
// Async tests are QUEUED, not run inline. Each one stubs globalThis.fetch for the whole test -
// tests spanning more than one fetch call (updateOrder's UPDATE + event insert, a reassignment's
// several calls) suspend between calls, and running two such tests "concurrently" (unawaited at
// module scope) lets a later test's stubFetch overwrite an earlier test's still-pending queue
// mid-flight. Queuing and awaiting them one at a time below removes the race entirely.
const asyncTests = [];
function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}
async function runAsyncTests() {
  for (const { name, fn } of asyncTests) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
  }
}

function stubFetch(responses) {
  const calls = [];
  const queue = responses.slice();
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    return { ok: next.ok !== false, status: next.status || 200, json: async () => next.body };
  };
  return calls;
}

const bq = require('../api/_lib/bigquery');
bq._setAuthHeaderForTests(async () => ({ Authorization: 'Bearer test-token' }));

/* ---------- Task 6: transport ---------- */

test('strParam encodes a named STRING parameter', () => {
  assert.deepStrictEqual(bq.strParam('brand', 'HYPHEN'), {
    name: 'brand',
    parameterType: { type: 'STRING' },
    parameterValue: { value: 'HYPHEN' },
  });
});

test('strParam passes null through instead of stringifying it', () => {
  assert.strictEqual(bq.strParam('notes', null).parameterValue.value, null);
});

test('structArrayParam encodes an array of all-STRING structs', () => {
  const p = bq.structArrayParam('items', ['parent_order', 'status'], [
    { parent_order: 'HYP1', status: 'Delivered' },
  ]);
  assert.strictEqual(p.parameterType.arrayType.type, 'STRUCT');
  assert.deepStrictEqual(p.parameterType.arrayType.structTypes, [
    { name: 'parent_order', type: { type: 'STRING' } },
    { name: 'status', type: { type: 'STRING' } },
  ]);
  assert.strictEqual(p.parameterValue.arrayValues[0].structValues.parent_order.value, 'HYP1');
});

testAsync('query posts NAMED parameters and maps the row shape', async () => {
  const calls = stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [{ name: 'parent_order' }, { name: 'status' }] },
    rows: [{ f: [{ v: 'HYP1' }, { v: 'Delivered' }] }],
  } }]);
  const out = await bq.query('SELECT 1', [bq.strParam('brand', 'HYPHEN')]);
  const sent = JSON.parse(calls[0].init.body);
  assert.strictEqual(sent.useLegacySql, false);
  assert.strictEqual(sent.parameterMode, 'NAMED');
  assert.deepStrictEqual(out.rows, [{ parent_order: 'HYP1', status: 'Delivered' }]);
});

testAsync('query reports DML affected rows', async () => {
  stubFetch([{ body: { jobComplete: true, numDmlAffectedRows: '7' } }]);
  const out = await bq.query('UPDATE x SET y = 1');
  assert.strictEqual(out.affectedRows, 7);
  assert.deepStrictEqual(out.rows, []);
});

testAsync('query surfaces the BigQuery error message, not a bare status code', async () => {
  stubFetch([{ ok: false, status: 400, body: { error: { message: 'Syntax error near MERGE' } } }]);
  await assert.rejects(bq.query('MERGE bad'), /Syntax error near MERGE/);
});

test('the transport exposes no ingest surface', () => {
  assert.strictEqual(bq.loadNdjson, undefined, 'ingest belongs to Python, not the request path');
});

/* ---------- Task 7: reads ---------- */

const ebq = require('../api/_lib/escalationBq');

test('the queue predicate matches the old JS filter, including the forced-RTO TAT case', () => {
  const sql = ebq.buildQueueQuery('queue');
  assert.match(sql, /LOWER\(status_as_per_awb\)\s+LIKE\s+'%rto%'/);
  assert.match(sql, /LOWER\(update_from_logistics\)\s+LIKE\s+'%rto%'/);
  assert.match(sql, /COALESCE\(status,\s*''\)\s*=\s*''/);
  assert.match(sql, /deleted_from_sheet_at IS NULL/);
  // Deliberately NOT filtered on tat: every pending RTO row carries "Forced to be marked as
  // RTO" there, so gating the queue on the open-TAT values empties it.
  assert.ok(!/\btat\b/.test(sql.slice(sql.indexOf('WHERE'))), 'queue must not filter on tat');
});

test('the fresh-leads predicate filters on tat alone', () => {
  const sql = ebq.buildQueueQuery('freshLeads');
  assert.match(sql, /LOWER\(TRIM\(COALESCE\(tat,\s*''\)\)\)\s+IN\s+\('',\s*'unresolved',\s*'#n\/a'\)/);
  const where = sql.slice(sql.indexOf('WHERE'));
  assert.ok(!/status_as_per_awb/.test(where), 'fresh leads ignore the RTO columns');
  assert.ok(!/COALESCE\(status,/.test(where), 'fresh leads ignore resolution status');
});

testAsync('order objects expose brand as sheetTab so the client is unchanged', async () => {
  stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [
      { name: 'brand' }, { name: 'parent_order' }, { name: 'awb_number' },
      { name: 'status_as_per_awb' }, { name: 'query_category' }, { name: 'row_number' },
      { name: 'ticket_number' },
    ] },
    rows: [{ f: [
      { v: 'HYPHEN' }, { v: 'HYP32557370' }, { v: 'AWB1' }, { v: 'RTO' },
      { v: 'Delayed Order' }, { v: '2' }, { v: 'TKT-9' },
    ] }],
  } }]);
  const [order] = await ebq.getEligibleOrders();
  assert.strictEqual(order.sheetTab, 'HYPHEN', 'brand is surfaced under the key rowKey() uses');
  assert.strictEqual(order.parentOrder, 'HYP32557370');
  assert.strictEqual(order.awbNumber, 'AWB1');
  assert.strictEqual(order.statusAsPerAwb, 'RTO');
  assert.strictEqual(order.rowNumber, 2, 'row_number comes back as a number');
  assert.strictEqual(order.ticketNumber, 'TKT-9');
});

testAsync('getLiveEscalationAssignments reads orders, not the event log', async () => {
  const calls = stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [{ name: 'parent_order' }, { name: 'assigned_to' }] },
    rows: [{ f: [{ v: 'HYP1' }, { v: 'a@x.com' }] }],
  } }]);
  const live = await ebq.getLiveEscalationAssignments();
  assert.deepStrictEqual(live, [{ parentOrder: 'HYP1', email: 'a@x.com' }]);
  const sql = JSON.parse(calls[0].init.body).query;
  assert.ok(!/assignment_events/.test(sql), 'the live map must not scan the event log');
  assert.match(sql, /assigned_to IS NOT NULL/);
  assert.match(sql, /resolved_at IS NULL/);
});

testAsync('getEscalationAssignments pivots events into assignment cycles', async () => {
  const calls = stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [
      { name: 'parent_order' }, { name: 'email' }, { name: 'assigned_at' },
      { name: 'reassigned_away_at' }, { name: 'resolved_at' }, { name: 'resolution' },
      { name: 'agent_remarks' },
    ] },
    rows: [{ f: [
      { v: 'HYP1' }, { v: 'a@x.com' }, { v: '2026-08-09T05:00:00Z' },
      { v: null }, { v: '2026-08-09T06:00:00Z' }, { v: 'Delivered' }, { v: 'ok' },
    ] }],
  } }]);
  const [row] = await ebq.getEscalationAssignments();
  assert.deepStrictEqual(row, {
    parentOrder: 'HYP1', email: 'a@x.com', assignedAt: '2026-08-09T05:00:00Z',
    reassignedAwayAt: null, resolvedAt: '2026-08-09T06:00:00Z',
    resolution: 'Delivered', agentRemarks: 'ok',
  });
  assert.match(JSON.parse(calls[0].init.body).query, /LIMIT 5000/);
});

testAsync('getOrderIndex builds the parent and parent+awb maps the CSV import needs', async () => {
  stubFetch([{ body: {
    jobComplete: true,
    schema: { fields: [{ name: 'brand' }, { name: 'parent_order' }, { name: 'awb_number' }, { name: 'awb_key' }] },
    rows: [
      { f: [{ v: 'HYPHEN' }, { v: 'HYP1' }, { v: 'AWB1' }, { v: 'awb1' }] },
      { f: [{ v: 'HYPHEN' }, { v: 'HYP1' }, { v: 'AWB9' }, { v: 'awb9' }] },
    ],
  } }]);
  const { byParent, byParentAwb } = await ebq.getOrderIndex();
  assert.deepStrictEqual(byParent.get('hyp1'),
    { sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: 'AWB1' });
  assert.strictEqual(byParentAwb.get('hyp1||awb9').awbNumber, 'AWB9',
    'the exact key still resolves the second row');
});

test('the data layer creates no tables', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../api/_lib/escalationBq.js'), 'utf8');
  assert.ok(!/CREATE TABLE/i.test(src), 'DDL belongs to scripts/escalation_bq_schema.py only');
});

/* ---------- Task 8: writes ---------- */

// The column groups the app must never write. Kept in sync with
// scripts/escalation_bq_schema.py's TICKET_COLUMNS and SHEET_COLUMNS by these tests failing loudly
// if a write statement ever names one.
const TICKET_COLUMNS = [
  'added_date', 'query_class', 'query_category', 'delivery_partner_name', 'order_date',
  'order_month', 'query_date', 'query_month', 'wh_name', 'ticket_number',
];
const SHEET_OWNED_COLUMNS = [
  'total_times_consumer_reached', 'delivered_date', 'status_as_per_awb', 'solv_date',
  'tat', 'update_from_logistics', 'city', 'state',
];

test('write statements never name a column owned by an ingest path', () => {
  const statements = [ebq.buildBulkUpdateMerge(), ebq.buildBulkAssignMerge()];
  statements.forEach((sql) => {
    [...TICKET_COLUMNS, ...SHEET_OWNED_COLUMNS].forEach((c) => {
      assert.ok(!new RegExp(`\\b${c}\\b`).test(sql),
        `write statement must not touch ingest-owned "${c}"`);
    });
  });
});

testAsync('updateOrder issues one UPDATE on the row key, plus one event', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
  ]);
  const affected = await ebq.updateOrder(
    { sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: ' AWB1 ' },
    { newOrderId: 'HYP2', newAwb: 'AWB9', newStatus: 'Reshipped', notes: 'done', resolvedBy: 'a@x.com' }
  );
  assert.strictEqual(affected, 1);
  const update = JSON.parse(calls[0].init.body);
  assert.match(update.query, /^UPDATE/);
  assert.match(update.query, /brand\s*=\s*@brand/);
  assert.match(update.query, /awb_key\s*=\s*@awb_key/);
  assert.strictEqual(update.queryParameters.find((p) => p.name === 'brand').parameterValue.value, 'HYPHEN');
  assert.strictEqual(update.queryParameters.find((p) => p.name === 'awb_key').parameterValue.value, 'awb1');
  const event = JSON.parse(calls[1].init.body);
  assert.match(event.query, /INSERT INTO `assignment_events`/);
  assert.strictEqual(event.queryParameters.find((p) => p.name === 'event').parameterValue.value, 'resolved');
});

testAsync('batchUpdateOrders compiles N items into ONE statement', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, numDmlAffectedRows: '3' } },
    { body: { jobComplete: true, numDmlAffectedRows: '3' } },
  ]);
  const items = ['HYP1', 'HYP2', 'HYP3'].map((p) => ({
    sheetTab: 'HYPHEN', parentOrder: p, awbNumber: `awb-${p}`,
    newOrderId: '-', newAwb: '-', newStatus: 'Delivered', notes: '', resolvedBy: 'a@x.com',
  }));
  assert.strictEqual(await ebq.batchUpdateOrders(items), 3);
  assert.strictEqual(calls.length, 2, 'one MERGE and one event insert, never one per item');
  assert.match(JSON.parse(calls[0].init.body).query, /UNNEST\(@items\)/);
});

testAsync('batchUpdateOrders with an empty list makes no BigQuery calls', async () => {
  const calls = stubFetch([]);
  assert.strictEqual(await ebq.batchUpdateOrders([]), 0);
  assert.strictEqual(calls.length, 0);
});

testAsync('assignEscalationOrdersBulk compiles 4048 assignments into ONE statement', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, numDmlAffectedRows: '4048' } },
    { body: { jobComplete: true, numDmlAffectedRows: '4048' } },
  ]);
  const items = Array.from({ length: 4048 }, (_, i) => ({
    sheetTab: 'HYPHEN', parentOrder: `HYP${i}`, awbNumber: `AWB${i}`, agentId: 'a@x.com',
  }));
  assert.strictEqual(await ebq.assignEscalationOrdersBulk(items), 4048);
  assert.strictEqual(calls.length, 2, '4048 rows must not become 4048 DML statements');
});

testAsync('reassignment closes the previous cycle before opening the new one', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, schema: { fields: [{ name: 'assigned_to' }] }, rows: [{ f: [{ v: 'old@x.com' }] }] } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
  ]);
  await ebq.assignEscalationOrder({ sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: 'AWB1' }, 'new@x.com');
  const away = JSON.parse(calls[1].init.body);
  assert.strictEqual(away.queryParameters.find((p) => p.name === 'event').parameterValue.value, 'reassigned_away');
  assert.strictEqual(away.queryParameters.find((p) => p.name === 'email').parameterValue.value, 'old@x.com');
  const assigned = JSON.parse(calls[3].init.body);
  assert.strictEqual(assigned.queryParameters.find((p) => p.name === 'event').parameterValue.value, 'assigned');
});

testAsync('re-assigning to the same agent writes no reassigned_away event', async () => {
  const calls = stubFetch([
    { body: { jobComplete: true, schema: { fields: [{ name: 'assigned_to' }] }, rows: [{ f: [{ v: 'same@x.com' }] }] } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
    { body: { jobComplete: true, numDmlAffectedRows: '1' } },
  ]);
  await ebq.assignEscalationOrder({ sheetTab: 'HYPHEN', parentOrder: 'HYP1', awbNumber: 'AWB1' }, 'same@x.com');
  const inserts = calls
    .map((c) => JSON.parse(c.init.body).query)
    .filter((q) => /INSERT INTO/.test(q));
  assert.strictEqual(inserts.length, 1, 'only the assigned event');
});

/* ---------- summary ---------- */
runAsyncTests().then(() => {
  console.log(`\n${passed} passed${process.exitCode ? ', FAILURES ABOVE' : ''}`);
});
