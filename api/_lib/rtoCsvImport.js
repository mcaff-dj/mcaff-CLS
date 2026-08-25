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

// Compares the live sheet's header row (as read fresh by the caller, e.g. `Data!A1:AD1`)
// against EXPECTED_SHEET_HEADER. Returns an array of human-readable mismatch descriptions -
// empty if everything still lines up.
function checkSheetLayout(fullHeaderRow) {
  const issues = [];
  Object.entries(EXPECTED_SHEET_HEADER).forEach(([letter, expected]) => {
    const idx = columnLetterToIndex(letter);
    const actual = (fullHeaderRow[idx] || '').toString();
    if (normalizeHeader(actual) !== normalizeHeader(expected)) {
      issues.push(`Column ${letter} is now "${actual}", expected "${expected}"`);
    }
  });
  return issues;
}

// The main orchestration: turns parsed CSV row objects (keyed by RAW csv header, exactly
// parseCSV's output shape) into { validRows, errors, counts }, applying blank-AWB rejection,
// within-file dedup (first occurrence wins), and against-the-sheet dedup, in that order.
//
// Each valid row gets:
//   - orderId, awbCode, paymentMethod: convenience top-level fields.
//   - cellsByColumn: { columnLetter: value }, one entry per CSV_TO_COLUMN mapping - the caller
//     places these directly into a fixed-width row array by column index, no further lookup.
function buildRowPlan({ csvRows, existingAwbSet }) {
  const validRows = [];
  const errors = [];
  const counts = { missingAwb: 0, duplicateInFile: 0, duplicateInSheet: 0 };
  const seenInFile = new Set();

  csvRows.forEach((row, i) => {
    const line = i + 2; // +1 for 1-based, +1 for the header row not being a data row
    const awb = normalizeAwb(row['AWB Code']);

    if (!awb) {
      counts.missingAwb++;
      errors.push({ line, reason: 'Missing AWB Code' });
      return;
    }
    if (seenInFile.has(awb)) {
      counts.duplicateInFile++;
      errors.push({ line, reason: `Duplicate AWB within file (${awb})` });
      return;
    }
    if (existingAwbSet.has(awb)) {
      counts.duplicateInSheet++;
      errors.push({ line, reason: `AWB already exists in sheet (${awb})` });
      return;
    }
    seenInFile.add(awb);

    const cellsByColumn = {};
    Object.entries(CSV_TO_COLUMN).forEach(([csvHeader, col]) => {
      let value = (row[csvHeader] || '').toString().trim();
      if (csvHeader === 'Order ID') value = value.split('_')[0];
      // A blank source value is written as the literal text "NA" rather than an empty cell -
      // explicit business instruction, so a blank in the sheet always means "not yet worked",
      // never "the source had nothing here".
      cellsByColumn[col] = value || 'NA';
    });

    validRows.push({
      orderId: cellsByColumn.E,
      awbCode: awb,
      paymentMethod: cellsByColumn.O,
      cellsByColumn,
    });
  });

  return { validRows, errors, counts };
}

// Pulls the first/last row NUMBERS out of a Sheets values:append `updates.updatedRange`
// (e.g. "Data!A7630:AD7639" -> ['7630', '7639']), so the post-append AWB canary can read back
// exactly the rows that just landed. Returns null when the range isn't in that shape.
//
// [A-Za-z]+, NOT \w+: \w matches digits too, so /!\w+(\d+):\w+(\d+)$/ backtracked its way to
// capturing only the LAST digit of each row number ("A7630" -> "0"), producing ranges like
// 'Data'!G0:G9 that Sheets rejects with "Unable to parse range". Lives here, exported and
// tested, rather than inline at each call site, so that regression can't come back unnoticed.
function parseAppendedRowRange(updatedRange) {
  const m = (updatedRange || '').match(/![A-Za-z]+(\d+):[A-Za-z]+(\d+)$/);
  return m ? [m[1], m[2]] : null;
}

module.exports = {
  normalizeHeader, normalizeAwb, columnLetterToIndex, indexToColumnLetter,
  CSV_TO_COLUMN, EXPECTED_SHEET_HEADER, LAST_COLUMN_LETTER, REQUIRED_CSV_HEADERS,
  checkSheetLayout, buildRowPlan, parseAppendedRowRange,
};
