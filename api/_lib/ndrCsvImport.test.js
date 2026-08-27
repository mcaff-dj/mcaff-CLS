// Self-check for the NDR CSV upload's column configuration - that it drives the shared engine in
// rtoCsvImport.js correctly, writes only the columns it should, and dedupes on AWB + Attempt
// Count rather than AWB alone. No network, no DB. Run: node api/_lib/ndrCsvImport.test.js
const assert = require('assert');
const { buildRowPlan, dedupKey, columnLetterToIndex, checkSheetLayout } = require('./rtoCsvImport');
const {
  NDR_IMPORT, NDR_CSV_TO_COLUMN, NDR_EXPECTED_SHEET_HEADER, NDR_ROW_WIDTH,
  NDR_LAST_COLUMN_LETTER, NDR_AWB_COLUMN, NDR_ATTEMPT_COLUMN,
} = require('./ndrCsvImport');

function csvRow(overrides) {
  const row = {};
  Object.keys(NDR_CSV_TO_COLUMN).forEach((h) => { row[h] = `v-${h}`; });
  return { ...row, ...overrides };
}

// 1. The row array is exactly wide enough for A..Q - nothing reaches the agent columns (R-V, AB)
// or the downstream CS columns (W-AA) that this upload must never write.
assert.strictEqual(NDR_LAST_COLUMN_LETTER, 'Q');
assert.strictEqual(NDR_ROW_WIDTH, 17);
assert.strictEqual(columnLetterToIndex('Q'), 16);
Object.values(NDR_CSV_TO_COLUMN).forEach((col) => {
  assert.ok(columnLetterToIndex(col) < NDR_ROW_WIDTH, `${col} must fit inside A..Q`);
});

// 2. The columns written are precisely the lead-source ones. C/K/N are unknown to this codebase
// and R onward belong to agents or the CS process - a regression that starts writing any of them
// would corrupt live data silently, so the set is pinned.
assert.deepStrictEqual(
  Object.values(NDR_CSV_TO_COLUMN).slice().sort(),
  ['A', 'B', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'L', 'M', 'O', 'P', 'Q'],
);
['C', 'K', 'N', 'R', 'S', 'T', 'U', 'V'].forEach((col) => {
  assert.ok(!Object.values(NDR_CSV_TO_COLUMN).includes(col), `must never write column ${col}`);
});

// 3. Dedup is AWB + Attempt Count. Attempt 2 of a shipment already in the sheet at attempt 1 is a
// genuinely new lead and must survive - deduping on AWB alone would have rejected it, which is
// the whole reason this config differs from RTO's (the sheet carried 358 repeated AWBs on
// 2026-08-25, per scripts/test_assign_ndr_leads.py).
{
  const inSheet = new Set([
    dedupKey('AWBX', { 'Attempt Count': '1' }, NDR_IMPORT.dedupExtraCsvHeaders),
  ]);
  const plan = buildRowPlan({
    csvRows: [
      csvRow({ 'AWB Code': 'AWBX', 'Attempt Count': '1' }), // already in the sheet
      csvRow({ 'AWB Code': 'AWBX', 'Attempt Count': '2' }), // new attempt, same shipment
      csvRow({ 'AWB Code': 'AWBX', 'Attempt Count': '2' }), // exact repeat inside the file
      csvRow({ 'AWB Code': 'AWBZ', 'Attempt Count': '1' }),
    ],
    existingKeySet: inSheet,
    config: NDR_IMPORT,
  });
  assert.strictEqual(plan.validRows.length, 2);
  assert.strictEqual(plan.counts.duplicateInSheet, 1);
  assert.strictEqual(plan.counts.duplicateInFile, 1);
  assert.deepStrictEqual(plan.validRows.map((r) => r.cellsByColumn[NDR_ATTEMPT_COLUMN]), ['2', '1']);
  assert.deepStrictEqual(plan.validRows.map((r) => r.awbCode), ['AWBX', 'AWBZ']);
}

// 4. NDR keeps the whole Order ID - brandOf() in NdrCallingClient.js reads it entire, unlike
// RTO which truncates at the first "_".
{
  const plan = buildRowPlan({
    csvRows: [csvRow({ 'Order ID': 'HYP44089510_SP/G3/2627/984539' })],
    existingKeySet: new Set(),
    config: NDR_IMPORT,
  });
  assert.strictEqual(plan.validRows[0].cellsByColumn.A, 'HYP44089510_SP/G3/2627/984539');
  assert.strictEqual(plan.validRows[0].orderId, 'HYP44089510_SP/G3/2627/984539');
}

// 5. Blanks stay blank - no literal "NA". Payment Mode (L) and Latest NDR Reason (Q) are matched
// as data against an agent's filters, so "NA" there would be a value, not an absence.
{
  const plan = buildRowPlan({
    csvRows: [csvRow({ 'Payment Method': '', 'Latest NDR Reason': '', 'Customer Name': '' })],
    existingKeySet: new Set(),
    config: NDR_IMPORT,
  });
  const cells = plan.validRows[0].cellsByColumn;
  assert.strictEqual(cells.L, '');
  assert.strictEqual(cells.Q, '');
  assert.strictEqual(cells.B, '');
  assert.strictEqual(plan.validRows[0].paymentMethod, '');
}

// 6. An all-digit AWB is text-forced so Sheets cannot store it as a number and render 5.4E+13,
// and one that already arrived mangled is rejected rather than imported.
{
  const plan = buildRowPlan({
    csvRows: [
      csvRow({ 'AWB Code': '54012345678901', 'Attempt Count': '1' }),
      csvRow({ 'AWB Code': '5.40E+13', 'Attempt Count': '1' }),
      csvRow({ 'AWB Code': '', 'Attempt Count': '1' }),
    ],
    existingKeySet: new Set(),
    config: NDR_IMPORT,
  });
  assert.strictEqual(plan.validRows.length, 1);
  assert.strictEqual(plan.validRows[0].cellsByColumn[NDR_AWB_COLUMN], "'54012345678901");
  assert.strictEqual(plan.counts.scientificAwb, 1);
  assert.strictEqual(plan.counts.missingAwb, 1);
}

// 7. The drift check uses NDR's own expectations, and every mapped column has one - a column in
// the map with no expected header would be written with no drift protection at all.
Object.values(NDR_CSV_TO_COLUMN).forEach((col) => {
  assert.ok(NDR_EXPECTED_SHEET_HEADER[col], `column ${col} is written but has no expected header`);
});
{
  const header = [];
  Object.entries(NDR_EXPECTED_SHEET_HEADER).forEach(([letter, text]) => {
    header[columnLetterToIndex(letter)] = text;
  });
  assert.deepStrictEqual(checkSheetLayout(header, NDR_IMPORT.expectedHeader), []);
  header[columnLetterToIndex('O')] = 'Something Else';
  const issues = checkSheetLayout(header, NDR_IMPORT.expectedHeader);
  assert.strictEqual(issues.length, 1);
  assert.ok(issues[0].includes('Column O'));
}

// 8. Every CSV header the map needs is in the required set - otherwise a file could be accepted
// while a mapped column silently received blanks for every row.
assert.deepStrictEqual(
  NDR_IMPORT.requiredCsvHeaders.slice().sort(),
  Object.keys(NDR_CSV_TO_COLUMN).slice().sort(),
);
assert.ok(NDR_IMPORT.requiredCsvHeaders.includes(NDR_IMPORT.awbCsvHeader));
NDR_IMPORT.dedupExtraCsvHeaders.forEach((h) => {
  assert.ok(NDR_IMPORT.requiredCsvHeaders.includes(h), `dedup field ${h} must be a required CSV column`);
});

// 9. The real header row of both live NDR sheets, read from the Sheets API on 2026-08-26. Pinned
// here so a future edit to NDR_EXPECTED_SHEET_HEADER that drifts from the live sheet fails
// loudly instead of silently 500-ing every upload, which is exactly what shipped in 71a84ea.
{
  const LIVE_NDR_HEADER_ROW = [
    'Order ID', 'Customer Name', 'Customer Email', 'Customer Mobile', 'AWB', 'Partner name',
    'Address ', 'Pincode', 'City', 'State', 'Order Value', 'Payment Mode', 'Status',
    'Is Buyer Response Received', 'Attempt Count', 'Latest NDR Date', 'Latest NDR Reason',
  ];
  const issues = checkSheetLayout(LIVE_NDR_HEADER_ROW, NDR_IMPORT.expectedHeader);
  assert.deepStrictEqual(issues, [], `expected no layout drift against the live header, got: ${issues.join('; ')}`);
}

console.log('ndrCsvImport.test.js: all assertions passed');
