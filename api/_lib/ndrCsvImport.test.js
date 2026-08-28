// Self-check for the NDR CSV upload's column configuration - that it drives the shared engine in
// rtoCsvImport.js correctly, writes only the columns it should, and dedupes on AWB + Attempt
// Count rather than AWB alone. No network, no DB. Run: node api/_lib/ndrCsvImport.test.js
const assert = require('assert');
const {
  buildRowPlan, dedupKey, columnLetterToIndex, checkSheetLayout, applyHeaderAliases,
} = require('./rtoCsvImport');
const {
  NDR_IMPORT, NDR_CSV_TO_COLUMN, NDR_EXPECTED_SHEET_HEADER, NDR_ROW_WIDTH,
  NDR_LAST_COLUMN_LETTER, NDR_AWB_COLUMN, NDR_ATTEMPT_COLUMN, NDR_CSV_HEADER_ALIASES,
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
  ['A', 'B', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'],
);
// C stays off-limits, as do every agent column (R-V) and the CS process's own (W-AA). K and N are
// deliberately absent from this list - they are written now, on explicit instruction.
['C', 'R', 'S', 'T', 'U', 'V'].forEach((col) => {
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

// 4. Order ID is truncated at the first "_" before it reaches the sheet, like RTO's.
// "HYP43558080_SP/G3/2627/924677" is written as "HYP43558080".
{
  const plan = buildRowPlan({
    csvRows: [csvRow({ 'Order ID': 'HYP43558080_SP/G3/2627/924677' })],
    existingKeySet: new Set(),
    config: NDR_IMPORT,
  });
  assert.strictEqual(plan.validRows[0].cellsByColumn.A, 'HYP43558080');
  assert.strictEqual(plan.validRows[0].orderId, 'HYP43558080');
}

// 4b. The truncation must not break brand detection, which is the reason column A was written
// verbatim before this. Both brandOf() in NdrCallingClient.js and brand_of() in
// scripts/assign_ndr_leads.py test the "HYP" PREFIX only, so everything before the first "_"
// is exactly what they need - but a future truncation that cut anywhere else would silently
// reclassify every Hyphen lead as mCaffeine, which nothing else would catch.
{
  const written = (orderId) => buildRowPlan({
    csvRows: [csvRow({ 'Order ID': orderId })], existingKeySet: new Set(), config: NDR_IMPORT,
  }).validRows[0].cellsByColumn.A;
  const brandOf = (v) => (String(v || '').toUpperCase().startsWith('HYP') ? 'Hyphen' : 'mCaffeine');
  assert.strictEqual(brandOf(written('HYP43558080_SP/G3/2627/924677')), 'Hyphen');
  assert.strictEqual(brandOf(written('MC12345678_SP/G3/2627/924677')), 'mCaffeine');
  // No "_" at all - written through unchanged, not emptied.
  assert.strictEqual(written('HYP43558080'), 'HYP43558080');
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

// 6. An all-digit AWB is left bare so Sheets stores it as a number (awbAsNumber - see block 10),
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
  assert.strictEqual(plan.validRows[0].cellsByColumn[NDR_AWB_COLUMN], '54012345678901');
  assert.strictEqual(plan.counts.scientificAwb, 1);
  assert.strictEqual(plan.counts.missingAwb, 1);
}

// 6b. A scientific-notation AWB that still carries every digit is expanded and IMPORTED, as a
// bare number - the "5.4E+13" form must never reach column E, whether by being written there or
// by being rendered there (api/ndr/upload.js pins the column's number format for the latter).
{
  const plan = buildRowPlan({
    csvRows: [csvRow({ 'AWB Code': '5.4012345678901E+13', 'Attempt Count': '1' })],
    existingKeySet: new Set(),
    config: NDR_IMPORT,
  });
  assert.strictEqual(plan.validRows.length, 1);
  assert.strictEqual(plan.counts.expandedAwb, 1);
  assert.strictEqual(plan.counts.scientificAwb, 0);
  assert.strictEqual(plan.validRows[0].cellsByColumn[NDR_AWB_COLUMN], '54012345678901');
  assert.strictEqual(plan.validRows[0].awbCode, '54012345678901', 'dedup keys on the expanded digits');
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
    // K reads "Address quality" in the live sheet - lowercase q, renamed from "Order Value"
    // before K was mapped. Kept verbatim here precisely because checkSheetLayout must be shown
    // to tolerate the casing rather than have it quietly normalised away in the fixture.
    'Address ', 'Pincode', 'City', 'State', 'Address quality', 'Payment Mode', 'Status',
    'Is Buyer Response Received', 'Attempt Count', 'Latest NDR Date', 'Latest NDR Reason',
  ];
  const issues = checkSheetLayout(LIVE_NDR_HEADER_ROW, NDR_IMPORT.expectedHeader);
  assert.deepStrictEqual(issues, [], `expected no layout drift against the live header, got: ${issues.join('; ')}`);
}

// 10. AWB (E) is written as a bare number, NOT apostrophe-escaped text like RTO's - awbAsNumber.
// The two shapes that would LOSE digits as a number keep the apostrophe: a leading zero, and
// anything past the 15-digit exact-integer ceiling. Alphanumeric AWBs are untouched either way.
{
  const plan = (awb) => buildRowPlan({
    csvRows: [csvRow({ 'AWB Code': awb })], existingKeySet: new Set(), config: NDR_IMPORT,
  }).validRows[0];
  assert.strictEqual(plan('54012345678901').cellsByColumn.E, '54012345678901', 'plain AWB stays bare so Sheets stores a number');
  assert.strictEqual(plan('GS4593447281').cellsByColumn.E, 'GS4593447281', 'alphanumeric AWB is already text to Sheets');
  assert.strictEqual(plan('0012345678901').cellsByColumn.E, "'0012345678901", 'leading zeros would be destroyed by a number');
  assert.strictEqual(plan('1234567890123456').cellsByColumn.E, "'1234567890123456", '16 digits exceeds the exact-integer range');
  // The dedup key never carries the apostrophe, whichever branch wrote the cell.
  assert.strictEqual(plan('0012345678901').awbCode, '0012345678901');
}

// 11. Header aliases. The real header row of the Shiprocket "NDR Full" export, verbatim from
// imports_ndr_reports_c_3594355_NDR_Full_3594355_20260828_114404.csv - the file that was refused
// with "missing required column(s): Courier Company, Address Line 1, Address Pincode, Address
// City, Address State, Payment Method" despite carrying every one of them under another name.
{
  const NDR_FULL_EXPORT_HEADER = [
    'Order ID', 'AWB Code', 'Courier', 'Channel', 'Channel SKU', 'Master SKU',
    'Product Name and Quantity', 'Customer Name', 'Customer Email', 'Customer Mobile',
    'Customer RTO Risk', 'Address 1', 'Address 2', 'Pincode', 'City', 'State', 'Address Quality',
    'Order Value', 'Payment Mode', 'Attempt Count', 'Status', 'Next Action',
    'Seller Input Required', 'Critical Action Required', 'Suggested Seller Action',
    'Latest OFD Date', 'Latest NDR Date', 'Latest NDR Reason', 'Latest NDR Action',
    'Latest NDR Action By', 'First OFD Date', 'First NDR Date', 'First NDR Reason',
    'First NDR Action', 'First NDR Action By', 'Second OFD Date', 'Second NDR Date',
    'Second NDR Reason', 'Second NDR Action', 'Second NDR Action By', 'Third OFD Date',
    'Third NDR Date', 'Third NDR Reason', 'Third NDR Action', 'Is Escalated',
    'Is Buyer Communication Sent', 'Total Communication Attempts',
    'Last Communication Attempt At', 'Is Buyer Response Received', 'Buyer Response Type',
    'Buyer Response Source', 'Buyer Response Date',
  ];
  const raw = {};
  NDR_FULL_EXPORT_HEADER.forEach((h) => { raw[h] = `v-${h}`; });

  // Without aliasing this file is refused - the exact six the modal named.
  assert.deepStrictEqual(
    NDR_IMPORT.requiredCsvHeaders.filter((h) => !NDR_FULL_EXPORT_HEADER.includes(h)),
    ['Courier Company', 'Address Line 1', 'Address Pincode', 'Address City', 'Address State', 'Payment Method'],
  );
  // With it, nothing is missing.
  const [aliased] = applyHeaderAliases([raw], NDR_IMPORT.csvHeaderAliases);
  assert.deepStrictEqual(
    NDR_IMPORT.requiredCsvHeaders.filter((h) => !(h in aliased)),
    [],
    'every required column must resolve through an alias',
  );
  // Values follow the rename, and "Address 2" must NOT be mistaken for "Address 1".
  assert.strictEqual(aliased['Courier Company'], 'v-Courier');
  assert.strictEqual(aliased['Address Line 1'], 'v-Address 1');
  assert.strictEqual(aliased['Address Pincode'], 'v-Pincode');
  assert.strictEqual(aliased['Payment Method'], 'v-Payment Mode');
  // The file's own headers survive, so an error can still echo the real header row.
  assert.strictEqual(aliased.Courier, 'v-Courier');
  assert.strictEqual(aliased['Address 2'], 'v-Address 2');

  // End to end: the aliased row actually maps to the right sheet columns.
  const plan = buildRowPlan({
    csvRows: applyHeaderAliases(
      [{ ...raw, 'AWB Code': '54012345678901', 'Attempt Count': '2', Courier: 'Delhivery', Pincode: '110001' }],
      NDR_IMPORT.csvHeaderAliases,
    ),
    existingKeySet: new Set(),
    config: NDR_IMPORT,
  });
  assert.strictEqual(plan.validRows.length, 1);
  assert.strictEqual(plan.validRows[0].cellsByColumn.F, 'Delhivery', 'Courier -> F');
  assert.strictEqual(plan.validRows[0].cellsByColumn.H, '110001', 'Pincode -> H');
}

// 12. Alias safety: a canonical header already in the file is never overwritten by its alias.
{
  const [row] = applyHeaderAliases(
    [{ Courier: 'alias-value', 'Courier Company': 'canonical-value' }],
    NDR_CSV_HEADER_ALIASES,
  );
  assert.strictEqual(row['Courier Company'], 'canonical-value');
}

// 13. Every alias must point at a header the fixed column map actually knows - an alias for a
// name nothing maps is dead config, and one with a typo would silently never apply.
Object.values(NDR_CSV_HEADER_ALIASES).forEach((canonical) => {
  assert.ok(NDR_CSV_TO_COLUMN[canonical], `alias target "${canonical}" is not a mapped CSV header`);
});
// No alias may collide with a canonical name - that would rename a column onto itself or shadow
// a real required header.
Object.keys(NDR_CSV_HEADER_ALIASES).forEach((alias) => {
  assert.ok(!NDR_CSV_TO_COLUMN[alias], `alias "${alias}" is itself a mapped CSV header`);
});

// 14. K and N, the two columns added by explicit business instruction. K is fed from the CSV's
// "Address Quality" and N from "Is Buyer Response Received" - both are now REQUIRED columns, so a
// file without them is refused rather than silently leaving the cells blank.
{
  assert.strictEqual(NDR_CSV_TO_COLUMN['Address Quality'], 'K');
  assert.strictEqual(NDR_CSV_TO_COLUMN['Is Buyer Response Received'], 'N');
  assert.ok(NDR_IMPORT.requiredCsvHeaders.includes('Address Quality'));
  assert.ok(NDR_IMPORT.requiredCsvHeaders.includes('Is Buyer Response Received'));

  const plan = buildRowPlan({
    csvRows: [csvRow({
      'AWB Code': '54012345678902',
      'Address Quality': 'Poor',
      'Is Buyer Response Received': 'Yes',
    })],
    existingKeySet: new Set(),
    config: NDR_IMPORT,
  });
  assert.strictEqual(plan.validRows[0].cellsByColumn.K, 'Poor', 'Address Quality -> K');
  assert.strictEqual(plan.validRows[0].cellsByColumn.N, 'Yes', 'Is Buyer Response Received -> N');
  // Still inside the A..Q append width - neither column widened what an upload touches.
  assert.ok(columnLetterToIndex('N') < NDR_ROW_WIDTH);
}

// 15. The drift check tolerates K1's real casing. Guarding this explicitly because pinning
// "Address Quality" against a live "Address quality" would otherwise refuse every single upload
// with "Sheet column layout has changed unexpectedly".
{
  assert.deepStrictEqual(checkSheetLayout(['', '', '', '', '', '', '', '', '', '', 'Address quality'], { K: 'Address Quality' }), []);
  assert.deepStrictEqual(checkSheetLayout(['', '', '', '', '', '', '', '', '', '', 'ADDRESS  QUALITY'], { K: 'Address Quality' }), []);
  assert.strictEqual(checkSheetLayout(['', '', '', '', '', '', '', '', '', '', 'Order Value'], { K: 'Address Quality' }).length, 1);
}

console.log('ndrCsvImport.test.js: all assertions passed');
