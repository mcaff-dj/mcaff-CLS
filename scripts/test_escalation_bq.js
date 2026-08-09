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

/* ---------- summary ---------- */
process.on('exit', () => {
  console.log(`\n${passed} passed${process.exitCode ? ', FAILURES ABOVE' : ''}`);
});
