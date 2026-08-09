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
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
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

/* ---------- summary ---------- */
process.on('exit', () => {
  console.log(`\n${passed} passed${process.exitCode ? ', FAILURES ABOVE' : ''}`);
});
