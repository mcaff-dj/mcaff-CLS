// Pure logic for the RTO CSV upload feature: fixed CSV-column -> sheet-column-letter mapping,
// AWB-based dedup, row-plan construction, and a sheet-layout drift check. No network, no DB -
// every function here takes plain data in and returns plain data out, so it is fully
// unit-testable (see rtoCsvImport.test.js) without a live Sheets connection.
//
// This used to match CSV headers to sheet headers by NAME (matchHeaders/headerToColumnLetter),
// which broke silently when the deployed matching code drifted from what was on disk (see the
// 2026-08-22 incident where two appended rows landed with every value shifted one column). It
// was replaced with the explicit mapping below, given directly by the business: each CSV column
// from this fixed Shiprocket export format goes to one specific, hardcoded sheet column letter.
// The sheet's own header text for a column does NOT have to match the CSV field name feeding
// it - e.g. column D is titled "RTO Reason" in the live sheet but is deliberately filled from
// the CSV's "Latest NDR Reason" field, per explicit instruction.

function normalizeHeader(h) {
  return (h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeAwb(v) {
  return (v || '').toString().trim().toUpperCase();
}

// An AWB that reached the CSV as "5.40E+13" has already lost its real digits - the export was
// opened and re-saved in a spreadsheet program, which rounded a 12-14 digit code to 3
// significant figures. Those digits are NOT recoverable here, and pretending otherwise is
// actively harmful: every mangled AWB in a file collapses to the same handful of strings, so
// the in-file dedup below silently discards genuinely distinct shipments as "duplicates".
// Rejecting the row and naming the cause is the only honest option.
function looksLikeScientificNotation(v) {
  return /^[+-]?\d+(\.\d+)?[Ee][+-]?\d+$/.test((v || '').toString().trim());
}

// Sheets is written with valueInputOption=USER_ENTERED (both the API endpoint and the Python
// worker), which type-infers every cell - so a bare AWB lands as a NUMBER and column G then
// renders it as 5.4E+13. A leading apostrophe is USER_ENTERED's own "treat this as text"
// escape; Sheets consumes it and stores the digits verbatim. This matters far beyond looks:
// every AWB read in this feature takes Sheets' default FORMATTED_VALUE, so a numeric AWB reads
// back as the string "5.4E+13" - which silently broke dedup against the sheet and made the
// post-append canary compare display text against real digits.
// Applied ONLY to all-digit AWBs: most couriers use an alphanumeric code (GS4593447281), which
// Sheets already stores as text, and prefixing those would add an apostrophe for nothing.
// Coupled to USER_ENTERED: under valueInputOption=RAW the apostrophe would be stored literally.
function toSheetText(v) {
  return /^\d+$/.test(v || '') ? `'${v}` : v;
}

// bijective base-26: A=0, B=1, ..., Z=25, AA=26, AB=27, ...
function columnLetterToIndex(letter) {
  return letter.split('').reduce((acc, c) => acc * 26 + (c.charCodeAt(0) - 64), 0) - 1;
}

function indexToColumnLetter(index) {
  let n = index;
  let col = '';
  while (true) {
    col = String.fromCharCode(65 + (n % 26)) + col;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return col;
}

// Which CSV column (exact header text from this Shiprocket export) feeds which sheet column
// letter. Order ID is special-cased in buildRowPlan below: only the part before the first "_"
// is written (e.g. "HYP44089510_SP/G3/2627/984539" -> "HYP44089510").
const CSV_TO_COLUMN = {
  'Shiprocket Created At': 'A',
  'RTO Initiated Date': 'B',
  'Latest NDR Date': 'C',
  'Latest NDR Reason': 'D',
  'Order ID': 'E',
  'AWB Code': 'G',
  'Customer Email': 'H',
  'Customer Name': 'I',
  'Customer Mobile': 'J',
  'Address Line 1': 'K',
  'Address City': 'L',
  'Address State': 'M',
  'Address Pincode': 'N',
  'Payment Method': 'O',
  'Order Total': 'P',
  'Pickup Address Name': 'AB',
  'Courier Company': 'AC',
};

// The live "Data" sheet's own header text at each column this feature writes to, as read on
// 2026-08-22 - not used to LOCATE columns (CSV_TO_COLUMN above already fixes those absolutely),
// only to detect drift: if a column gets inserted/reordered in the live sheet, the header found
// there will no longer match what's expected, and callers should refuse to write rather than
// silently landing data in the wrong place.
const EXPECTED_SHEET_HEADER = {
  A: 'CXB CV', B: 'RTO Initiated Date', C: 'Latest NDR Date', D: 'RTO Reason', E: 'Order ID',
  F: 'Unique', G: 'AWB Code', H: 'Customer Email', I: 'Customer Name', J: 'Customer Mobile',
  K: 'Address', L: 'Address City', M: 'Address State', N: 'Address Pincode',
  O: 'Payment Method', P: 'Order Total', AB: 'Facility Name', AC: 'Courier Company',
};

// Widest column this feature ever writes to - callers size their output row arrays to this.
const LAST_COLUMN_LETTER = 'AC';

// Every CSV column this feature depends on - callers reject the whole upload if any is absent
// from the file's own header row, rather than silently writing blanks into that column for
// every row.
const REQUIRED_CSV_HEADERS = Object.keys(CSV_TO_COLUMN);

// Everything below this line is sheet-agnostic: the same parse/dedup/map engine serves any
// sheet that supplies one of these configs. RTO_IMPORT is the default for every entry point, so
// existing callers are unaffected; a second sheet passes its own instead of copying the engine
// (which is how the scientific-notation and text-forcing handling stays in exactly one place).
const RTO_IMPORT = {
  label: 'RTO',
  columnMap: CSV_TO_COLUMN,
  expectedHeader: EXPECTED_SHEET_HEADER,
  lastColumn: LAST_COLUMN_LETTER,
  requiredCsvHeaders: REQUIRED_CSV_HEADERS,
  awbCsvHeader: 'AWB Code',
  // Extra CSV columns that join the AWB to form the dedup key. Empty for RTO, where one AWB is
  // one lead. A sheet that legitimately carries the same AWB on several rows (NDR gets a new row
  // per failed delivery attempt) lists what distinguishes them here, and its caller must build
  // its existingKeySet from the same fields in the same order.
  dedupExtraCsvHeaders: [],
  // Only the part before the first "_" is written, e.g.
  // "HYP44089510_SP/G3/2627/984539" -> "HYP44089510". null to write the value verbatim.
  orderIdCsvHeader: 'Order ID',
  orderIdColumn: 'E',
  paymentMethodColumn: 'O',
  // A blank source value is written as this literal text rather than an empty cell - explicit
  // business instruction, so a blank in the sheet always means "not yet worked", never "the
  // source had nothing here". Set to '' to leave blanks genuinely blank.
  blankPlaceholder: 'NA',
};

// Compares the live sheet's header row (as read fresh by the caller, e.g. `Data!A1:AD1`)
// against EXPECTED_SHEET_HEADER. Returns an array of human-readable mismatch descriptions -
// empty if everything still lines up.
function checkSheetLayout(fullHeaderRow, expectedHeader = EXPECTED_SHEET_HEADER) {
  const issues = [];
  Object.entries(expectedHeader).forEach(([letter, expected]) => {
    const idx = columnLetterToIndex(letter);
    const actual = (fullHeaderRow[idx] || '').toString();
    if (normalizeHeader(actual) !== normalizeHeader(expected)) {
      issues.push(`Column ${letter} is now "${actual}", expected "${expected}"`);
    }
  });
  return issues;
}

// The dedup key for one row: the AWB alone for a sheet where that identifies a lead, or the AWB
// joined with whatever else distinguishes rows that legitimately share one. Values go through
// normalizeAwb so the key matches however the caller normalized what it read out of the sheet.
//
// Length-prefixed rather than joined on a separator: any separator can also occur inside a sheet
// cell, so a plain join lets ("AWB1", "2") and ("AWB12", "") produce the same key and silently
// reject a real lead as a duplicate. Prefixing each part with its own length makes the encoding
// unambiguous whatever the values contain, using nothing but ASCII.
function dedupKey(awb, row, extraCsvHeaders) {
  if (!extraCsvHeaders.length) return awb;
  const parts = [awb, ...extraCsvHeaders.map((h) => normalizeAwb(row[h]))];
  return parts.map((v) => `${v.length}:${v}`).join('|');
}

// The main orchestration: turns parsed CSV row objects (keyed by RAW csv header, exactly
// parseCSV's output shape) into { validRows, errors, counts }, applying blank-AWB rejection,
// within-file dedup (first occurrence wins), and against-the-sheet dedup, in that order.
//
// Each valid row gets:
//   - orderId, awbCode, paymentMethod: convenience top-level fields.
//   - cellsByColumn: { columnLetter: value }, one entry per config.columnMap mapping - the caller
//     places these directly into a fixed-width row array by column index, no further lookup.
//   - dedupKey, line: this row's own dedup identity and 1-based CSV line number, already computed
//     during the loop below. Purely additive for a caller that needs to correlate a surviving row
//     back to those without recomputing them - e.g. api/ndr/upload.js's cross-team duplicate
//     check, which has to test a row's key against ANOTHER team's existingKeySet after this
//     function has already built the plan. Recomputing the key there would mean teasing the raw
//     AWB and Attempt Count back out of cellsByColumn (where the AWB has already been
//     toSheetText'd with a leading apostrophe) - fiddly, and a second definition of "what a key
//     is" that could drift from this one. No existing caller reads either field, so nothing that
//     iterates cellsByColumn or treats a row as a fixed 3-field shape is affected.
function buildRowPlan({ csvRows, existingKeySet, config = RTO_IMPORT }) {
  const {
    columnMap, awbCsvHeader, orderIdCsvHeader, orderIdColumn, paymentMethodColumn,
    blankPlaceholder, dedupExtraCsvHeaders = [],
  } = config;
  // Required, not defaulted: a caller that forgets it would otherwise get a silent no-op on the
  // against-the-sheet dedup and append duplicates with no error anywhere. Caught exactly that way
  // by this module's own test during the rename that introduced the composite key.
  if (!(existingKeySet instanceof Set)) {
    throw new Error('buildRowPlan: existingKeySet (a Set) is required');
  }
  const validRows = [];
  const errors = [];
  const counts = { missingAwb: 0, duplicateInFile: 0, duplicateInSheet: 0, scientificAwb: 0 };
  const seenInFile = new Set();

  csvRows.forEach((row, i) => {
    const line = i + 2; // +1 for 1-based, +1 for the header row not being a data row
    const awb = normalizeAwb(row[awbCsvHeader]);

    if (!awb) {
      counts.missingAwb++;
      errors.push({ line, reason: `Missing ${awbCsvHeader}` });
      return;
    }
    if (looksLikeScientificNotation(awb)) {
      counts.scientificAwb++;
      errors.push({
        line,
        reason: `${awbCsvHeader} "${awb}" is in scientific notation - its real digits are already lost. `
          + 'Re-export the source file and upload it without opening it in Excel/Sheets first.',
      });
      return;
    }
    const key = dedupKey(awb, row, dedupExtraCsvHeaders);
    const keyLabel = dedupExtraCsvHeaders.length ? `${awb} + ${dedupExtraCsvHeaders.join(' + ')}` : awb;
    if (seenInFile.has(key)) {
      counts.duplicateInFile++;
      errors.push({ line, reason: `Duplicate within file (${keyLabel})` });
      return;
    }
    if (existingKeySet.has(key)) {
      counts.duplicateInSheet++;
      errors.push({ line, reason: `Already exists in sheet (${keyLabel})` });
      return;
    }
    seenInFile.add(key);

    const cellsByColumn = {};
    Object.entries(columnMap).forEach(([csvHeader, col]) => {
      let value = (row[csvHeader] || '').toString().trim();
      if (orderIdCsvHeader && csvHeader === orderIdCsvHeader) value = value.split('_')[0];
      if (csvHeader === awbCsvHeader) value = toSheetText(value);
      cellsByColumn[col] = value || blankPlaceholder;
    });

    validRows.push({
      orderId: cellsByColumn[orderIdColumn],
      awbCode: awb,
      paymentMethod: paymentMethodColumn ? cellsByColumn[paymentMethodColumn] : '',
      cellsByColumn,
      dedupKey: key,
      line,
    });
  });

  return { validRows, errors, counts };
}

module.exports = {
  normalizeHeader, normalizeAwb, columnLetterToIndex, indexToColumnLetter,
  CSV_TO_COLUMN, EXPECTED_SHEET_HEADER, LAST_COLUMN_LETTER, REQUIRED_CSV_HEADERS,
  checkSheetLayout, buildRowPlan, looksLikeScientificNotation, toSheetText, RTO_IMPORT, dedupKey,
};
