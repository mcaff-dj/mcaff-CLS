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

// 3. matchHeaders - fuzzy fallback for a genuine substring-containment case.
{
  const result = matchHeaders(['RTO Reason'], ['RTO Reason Code']);
  assert.strictEqual(result[0].csvHeader, 'RTO Reason Code', 'RTO Reason Code must fuzzy-match RTO Reason (substring: rtoreason is contained in rtoreasoncode)');
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
  const matchResult = matchHeaders(['RTO Reason', 'Order ID'], ['RTO Reason Code', 'Order ID']);
  assert.strictEqual(findRequiredMatch(matchResult, 'rto reason'), 'RTO Reason Code');
  assert.strictEqual(findRequiredMatch(matchResult, 'order id'), 'Order ID');
  assert.strictEqual(findRequiredMatch(matchResult, 'payment method'), null,
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
