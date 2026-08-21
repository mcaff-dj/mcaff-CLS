// Run with `node api/_lib/orderPunchRows.test.js`.
const assert = require('assert');
const { validateRows } = require('./orderPunchRows');

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

console.log('orderPunchRows.test.js: all assertions passed');
