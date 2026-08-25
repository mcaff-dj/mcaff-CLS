// Self-check for the RTO CSV upload's pure logic - fixed column mapping, dedup, row planning,
// sheet-layout drift detection. No network, no DB. Run with `node api/_lib/rtoCsvImport.test.js`.
const assert = require('assert');
const {
  normalizeHeader, normalizeAwb, columnLetterToIndex, indexToColumnLetter,
  CSV_TO_COLUMN, checkSheetLayout, buildRowPlan,
  looksLikeScientificNotation, toSheetText, RTO_IMPORT, dedupKey,
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
  const plan = buildRowPlan({ csvRows, existingKeySet: new Set() });
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
  const existingKeySet = new Set(['AWB4']);
  const plan = buildRowPlan({ csvRows, existingKeySet });

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


// looksLikeScientificNotation - an AWB mangled by Excel is unrecoverable, so it must be caught
// rather than imported. Real AWBs are long digit strings and must never trip this.
assert.strictEqual(looksLikeScientificNotation('5.40E+13'), true);
assert.strictEqual(looksLikeScientificNotation('5.4e+13'), true);
assert.strictEqual(looksLikeScientificNotation('1E13'), true);
assert.strictEqual(looksLikeScientificNotation('54012345678901'), false);
assert.strictEqual(looksLikeScientificNotation('SF1234567890E'), false); // trailing letter, not an exponent
assert.strictEqual(looksLikeScientificNotation(''), false);

// toSheetText - the USER_ENTERED escape that keeps a long AWB from being stored as a number.
assert.strictEqual(toSheetText('54012345678901'), "'54012345678901");
assert.strictEqual(toSheetText('GS4593447281'), 'GS4593447281'); // alphanumeric - already text to Sheets
assert.strictEqual(toSheetText(''), '');

// buildRowPlan end-to-end: a mangled AWB is rejected (not counted as a duplicate), a good one
// is written text-forced, and the plan's own awbCode stays the bare digits used for dedup.
{
  const csvRow = (awb) => {
    const r = {};
    Object.keys(CSV_TO_COLUMN).forEach((h) => { r[h] = 'x'; });
    r['AWB Code'] = awb;
    r['Payment Method'] = 'COD';
    return r;
  };
  const plan = buildRowPlan({
    csvRows: [csvRow('54012345678901'), csvRow('5.40E+13'), csvRow('54012345678901')],
    existingKeySet: new Set(),
  });
  assert.strictEqual(plan.validRows.length, 1);
  assert.strictEqual(plan.counts.scientificAwb, 1);
  assert.strictEqual(plan.counts.duplicateInFile, 1);
  assert.strictEqual(plan.validRows[0].awbCode, '54012345678901');
  assert.strictEqual(plan.validRows[0].cellsByColumn.G, "'54012345678901");
}

// The engine is sheet-agnostic - a second config drives it without a second copy of the parse,
// dedup, scientific-notation or text-forcing logic. Exercised with a deliberately different
// shape from RTO's: different AWB header, blanks left genuinely blank, no payment-method column,
// and no Order ID truncation.
{
  const OTHER = {
    label: 'Other',
    columnMap: { 'Order Id': 'A', 'Waybill': 'C' },
    expectedHeader: { A: 'Order Id', C: 'Waybill' },
    lastColumn: 'C',
    requiredCsvHeaders: ['Order Id', 'Waybill'],
    awbCsvHeader: 'Waybill',
    orderIdCsvHeader: null,      // no "_" truncation for this sheet
    orderIdColumn: 'A',
    paymentMethodColumn: null,   // this sheet has no payment column at all
    blankPlaceholder: '',        // blanks stay blank rather than becoming "NA"
  };

  const plan = buildRowPlan({
    csvRows: [
      { 'Order Id': 'ORD_1/keep', Waybill: '54012345678901' },
      { 'Order Id': 'ORD_2', Waybill: '' },
      { 'Order Id': 'ORD_3', Waybill: '5.40E+13' },
      { 'Order Id': 'ORD_4', Waybill: 'IN_SHEET_ALREADY' },
    ],
    existingKeySet: new Set(['IN_SHEET_ALREADY']),
    config: OTHER,
  });

  assert.strictEqual(plan.validRows.length, 1);
  assert.strictEqual(plan.counts.missingAwb, 1);
  assert.strictEqual(plan.counts.scientificAwb, 1);
  assert.strictEqual(plan.counts.duplicateInSheet, 1);
  // orderIdCsvHeader null -> written verbatim, "_" and all
  assert.strictEqual(plan.validRows[0].cellsByColumn.A, 'ORD_1/keep');
  // the AWB text escape still applies, keyed off this config's own header name
  assert.strictEqual(plan.validRows[0].cellsByColumn.C, "'54012345678901");
  // no payment column configured -> empty, not a crash and not a stray 'NA'
  assert.strictEqual(plan.validRows[0].paymentMethod, '');
  // the missing-AWB error names THIS config's header, not RTO's
  assert.ok(plan.errors.some((e) => e.reason === 'Missing Waybill'));

  // checkSheetLayout takes the same config's expectations
  assert.deepStrictEqual(checkSheetLayout(['Order Id', '', 'Waybill'], OTHER.expectedHeader), []);
  assert.ok(checkSheetLayout(['Order Id', '', 'Something Else'], OTHER.expectedHeader).length === 1);
  // and still defaults to RTO's when not given one
  assert.ok(checkSheetLayout([]).length > 0);
  assert.strictEqual(RTO_IMPORT.columnMap, CSV_TO_COLUMN);
}

// Composite dedup key - for a sheet that legitimately carries one AWB on several rows (NDR gets
// a new row per failed delivery attempt), so AWB alone would reject every genuine new attempt.
{
  const ATTEMPTS = {
    label: 'Attempts',
    columnMap: { 'AWB Code': 'E', 'Attempt Count': 'O' },
    expectedHeader: { E: 'AWB Code', O: 'Attempt Count' },
    lastColumn: 'O',
    requiredCsvHeaders: ['AWB Code', 'Attempt Count'],
    awbCsvHeader: 'AWB Code',
    dedupExtraCsvHeaders: ['Attempt Count'],
    orderIdCsvHeader: null,
    orderIdColumn: 'E',
    paymentMethodColumn: null,
    blankPlaceholder: '',
  };
  const row = (awb, n) => ({ 'AWB Code': awb, 'Attempt Count': n });

  const plan = buildRowPlan({
    csvRows: [
      row('AWBX', '1'),   // attempt 1 - already in the sheet below
      row('AWBX', '2'),   // attempt 2 of the SAME shipment - a genuinely new lead, must survive
      row('AWBX', '2'),   // exact repeat within the file
      row('AWBY', '1'),
    ],
    existingKeySet: new Set([dedupKey('AWBX', row('AWBX', '1'), ['Attempt Count'])]),
    config: ATTEMPTS,
  });

  assert.strictEqual(plan.validRows.length, 2, 'attempt 2 of AWBX and AWBY must both survive');
  assert.strictEqual(plan.counts.duplicateInSheet, 1);
  assert.strictEqual(plan.counts.duplicateInFile, 1);
  assert.deepStrictEqual(plan.validRows.map((r) => r.cellsByColumn.O), ['2', '1']);

  // Length-prefixed, so no value can forge a collision by containing the separator - and, the
  // case a plain join gets wrong, by shifting characters across the boundary. An earlier version
  // of this test compared '1-2'/'A-1', which passes even with an EMPTY separator and so failed
  // to notice when the separator was accidentally dropped.
  assert.notStrictEqual(
    dedupKey('AWB1', { x: '2' }, ['x']),
    dedupKey('AWB12', { x: '' }, ['x']),
  );
  assert.notStrictEqual(
    dedupKey('A', { x: '1-2' }, ['x']),
    dedupKey('A-1', { x: '2' }, ['x']),
  );
  assert.notStrictEqual(
    dedupKey('A|B', { x: 'C' }, ['x']),
    dedupKey('A', { x: 'B|C' }, ['x']),
  );
  // With no extra fields the key is the bare AWB - RTO's behaviour, unchanged.
  assert.strictEqual(dedupKey('AWB1', {}, []), 'AWB1');
}

// existingKeySet is required - forgetting it must throw, not silently skip sheet dedup.
assert.throws(
  () => buildRowPlan({ csvRows: [] }),
  /existingKeySet \(a Set\) is required/,
);

console.log('rtoCsvImport.test.js: all assertions passed');
