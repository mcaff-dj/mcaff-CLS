// Run with `node api/_lib/orderPunchRows.test.js`.
const assert = require('assert');
const { validateRows, isJobStalled, STALL_AFTER_MS } = require('./orderPunchRows');

// 1. A blank/missing doc is rejected; valid rows around it still come through.
{
  const { validRows, errors } = validateRows([
    { doc: 'HYP1001', reason: 'wrong address', facility_code: 'HYP_SRKOL' },
    { doc: '  ', reason: 'x' },
    { doc: 'HYP1002' },
  ]);
  assert.deepStrictEqual(validRows, [
    { doc: 'HYP1001', reason: 'wrong address', facility_code: 'HYP_SRKOL' },
    { doc: 'HYP1002', reason: '', facility_code: '' },
  ]);
  assert.deepStrictEqual(errors, [{ line: 2, reason: 'Missing order code' }]);
}

// 2. Whitespace is trimmed on every field.
{
  const { validRows } = validateRows([{ doc: '  HYP2001  ', reason: '  late delivery  ', facility_code: ' HYP_AHMD ' }]);
  assert.deepStrictEqual(validRows, [{ doc: 'HYP2001', reason: 'late delivery', facility_code: 'HYP_AHMD' }]);
}

// 3. reason/facility_code are optional - default to ''.
{
  const { validRows } = validateRows([{ doc: 'HYP3001' }]);
  assert.deepStrictEqual(validRows, [{ doc: 'HYP3001', reason: '', facility_code: '' }]);
}

// 4. Empty input -> empty output, no crash.
{
  const { validRows, errors } = validateRows([]);
  assert.deepStrictEqual(validRows, []);
  assert.deepStrictEqual(errors, []);
}

// 5. isJobStalled: only a live status can stall, and only after the window.
{
  const now = Date.parse('2026-08-21T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();

  assert.strictEqual(isJobStalled('queued', ago(STALL_AFTER_MS + 1000), now), true,
    'a queued job untouched past the window is stalled - the worker never started it');
  assert.strictEqual(isJobStalled('running', ago(STALL_AFTER_MS + 1000), now), true,
    'a running job untouched past the window is stalled - the worker died mid-job');
  assert.strictEqual(isJobStalled('running', ago(60 * 1000), now), false,
    'a job that wrote a counter a minute ago is just working');

  // Terminal statuses are never stalled, however old: 'failed'/'done' rows are what the
  // results CSV is downloaded from, sometimes days later.
  for (const st of ['done', 'failed', 'stopped']) {
    assert.strictEqual(isJobStalled(st, ago(30 * 24 * 3600 * 1000), now), false, st + ' must never read as stalled');
  }

  // A Date instance (what pg actually hands back for TIMESTAMPTZ) and a string must agree.
  assert.strictEqual(isJobStalled('queued', new Date(now - STALL_AFTER_MS - 1000), now), true);
  // An unparseable/absent timestamp must not invent a stall.
  assert.strictEqual(isJobStalled('queued', null, now), false);
  assert.strictEqual(isJobStalled('queued', 'not a date', now), false);
}

console.log('orderPunchRows.test.js: all assertions passed');
