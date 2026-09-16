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
