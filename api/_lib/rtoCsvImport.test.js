// Self-check for the RTO CSV upload's pure logic - fixed column mapping, dedup, row planning,
// sheet-layout drift detection. No network, no DB. Run with `node api/_lib/rtoCsvImport.test.js`.
const assert = require('assert');
const {
  normalizeHeader, normalizeAwb, columnLetterToIndex, indexToColumnLetter,
  CSV_TO_COLUMN, checkSheetLayout, buildRowPlan,
} = require('./rtoCsvImport');

// 1. columnLetterToIndex / indexToColumnLetter - bijective base-26, round-trips past Z.
assert.strictEqual(columnLetterToIndex('A'), 0);
assert.strictEqual(columnLetterToIndex('G'), 6);
assert.strictEqual(columnLetterToIndex('P'), 15);
assert.strictEqual(columnLetterToIndex('AB'), 27);
assert.strictEqual(columnLetterToIndex('AC'), 28);
assert.strictEqual(indexToColumnLetter(28), 'AC');
assert.strictEqual(indexToColumnLetter(columnLetterToIndex('AC')), 'AC');

// 2. normalizeAwb - trim + uppercase, the dedup key everywhere else in this module uses.
assert.strictEqual(normalizeAwb('  awb123 '), 'AWB123');
assert.strictEqual(normalizeAwb(''), '');

// 3. buildRowPlan - Order ID is split on the first "_", only the part before it is kept -
// this is the real value shape seen in production ("HYP44089510_SP/G3/2627/984539").
{
  const csvRows = [{
    'Order ID': 'HYP44089510_SP/G3/2627/984539',
    'AWB Code': 'GS4593447281',
    'Shiprocket Created At': '2026-08-22 10:09:47',
    'RTO Initiated Date': '2026-08-22 16:14:32',
    'Latest NDR Date': '',
    'Latest NDR Reason': '',
    'Customer Email': 'gunjan.r@rishihood.edu.in',
    'Customer Name': 'Gunjan .',
    'Customer Mobile': '8392939313',
    'Address Line 1': 'Rishihood University Gate No 2',
    'Address City': 'Sonipat',
    'Address State': 'Haryana',
    'Address Pincode': '131001',
    'Payment Method': 'prepaid',
    'Order Total': '778.00',
    'Pickup Address Name': 'mCaff_Gurgaon3',
    'Courier Company': 'Blitz Intercity NDD',
  }];
  const plan = buildRowPlan({ csvRows, existingAwbSet: new Set() });
  assert.strictEqual(plan.validRows.length, 1);
  const row = plan.validRows[0];
  assert.strictEqual(row.orderId, 'HYP44089510', 'Order ID must be split on first "_", tail dropped');
  assert.strictEqual(row.awbCode, 'GS4593447281');
  assert.strictEqual(row.paymentMethod, 'prepaid');
  assert.strictEqual(row.cellsByColumn.A, '2026-08-22 10:09:47', 'Shiprocket Created At -> A');
  assert.strictEqual(row.cellsByColumn.B, '2026-08-22 16:14:32', 'RTO Initiated Date -> B');
  assert.strictEqual(row.cellsByColumn.E, 'HYP44089510', 'split Order ID -> E');
  assert.strictEqual(row.cellsByColumn.G, 'GS4593447281', 'AWB Code -> G');
  assert.strictEqual(row.cellsByColumn.H, 'gunjan.r@rishihood.edu.in', 'Customer Email -> H');
  assert.strictEqual(row.cellsByColumn.I, 'Gunjan .', 'Customer Name -> I');
  assert.strictEqual(row.cellsByColumn.J, '8392939313', 'Customer Mobile -> J');
  assert.strictEqual(row.cellsByColumn.K, 'Rishihood University Gate No 2', 'Address Line 1 -> K');
  assert.strictEqual(row.cellsByColumn.AB, 'mCaff_Gurgaon3', 'Pickup Address Name -> AB');
  assert.strictEqual(row.cellsByColumn.AC, 'Blitz Intercity NDD', 'Courier Company -> AC');
  assert.strictEqual(row.cellsByColumn.C, 'NA', 'blank source value is written as "NA", not empty');
  assert.strictEqual(row.cellsByColumn.D, 'NA', 'blank source value is written as "NA", not empty');
}

// 4. buildRowPlan - blank AWB rejected, in-file duplicate rejected (first occurrence wins),
// already-in-sheet duplicate rejected.
{
  const base = (orderId, awb, payment) => ({
    'Order ID': orderId, 'AWB Code': awb, 'Payment Method': payment,
  });
  const csvRows = [
    base('HYP1_X', 'awb1', 'prepaid'),
    base('HYP2_X', '', 'cod'), // blank AWB
    base('HYP3_X', 'AWB1', 'cod'), // dup of row 1 (case-insensitive)
    base('HYP4_X', 'awb4', 'cod'), // already in sheet
    base('HYP5_X', 'awb5', 'cod'), // valid
  ];
  const existingAwbSet = new Set(['AWB4']);
  const plan = buildRowPlan({ csvRows, existingAwbSet });

  assert.strictEqual(plan.validRows.length, 2, 'only HYP1 and HYP5 survive');
  assert.deepStrictEqual(plan.validRows.map((r) => r.orderId), ['HYP1', 'HYP5']);
  assert.strictEqual(plan.validRows[0].awbCode, 'AWB1');
  assert.strictEqual(plan.validRows[0].paymentMethod, 'prepaid');

  assert.strictEqual(plan.counts.missingAwb, 1);
  assert.strictEqual(plan.counts.duplicateInFile, 1);
  assert.strictEqual(plan.counts.duplicateInSheet, 1);
  assert.strictEqual(plan.errors.length, 3);
  assert.ok(plan.errors.some((e) => e.reason.toLowerCase().includes('missing') && e.line === 3),
    'line numbers are 1-based data rows (header is not counted), so the blank-AWB row (2nd data row) is line 3');
}

// 5. checkSheetLayout - clean when the live header row matches EXPECTED_SHEET_HEADER exactly
// at every relevant column (including real whitespace quirks), and reports every mismatch when
// a column has drifted.
{
  const fullHeaderRow = [
    ' CXB CV', 'RTO Initiated Date', 'Latest NDR Date', 'RTO Reason', 'Order ID', 'Unique',
    'AWB Code', 'Customer Email', 'Customer Name', 'Customer Mobile', 'Address', 'Address City',
    'Address State', 'Address Pincode', '  Payment Method', 'Order Total', 'Agent Name',
    'Connected', 'Attempt', '', 'New product needed', 'New  order ID', 'Change in address',
    'x', 'Calling Date', ' Remark', 'Key', 'Facility Name', 'Courier Company',
  ];
  assert.deepStrictEqual(checkSheetLayout(fullHeaderRow), [], 'matches production layout exactly');

  const drifted = [...fullHeaderRow];
  drifted[6] = 'Some New Column'; // column G, was 'AWB Code'
  const issues = checkSheetLayout(drifted);
  assert.strictEqual(issues.length, 1);
  assert.ok(issues[0].includes('Column G'), 'must name the drifted column');
}

console.log('rtoCsvImport.test.js: all assertions passed');
