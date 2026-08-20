// Pure logic for the RTO CSV upload feature: header matching against the LIVE sheet (never a
// hardcoded list - the sheet's own header row is read fresh by the caller, api/rto/upload-start.js,
// and passed in here), AWB-based dedup, and row-plan construction. No network, no DB - every
// function here takes plain data in and returns plain data out, so it is fully unit-testable
// (see rtoCsvImport.test.js) without a live Sheets connection.

// Same normalization convention already used by app/rto-crm/RtoCrmClient.js's own header-
// matching helper (mapTkt's g()) - reused here rather than invented fresh, so this codebase
// has exactly one idea of "how two header strings are compared", not two.
function normalizeHeader(h) {
  return (h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Two-pass matching: exact-normalized-equality first for EVERY target column, then a
// substring-fuzzy fallback only for targets still unmatched after that first pass. This order
// matters - see the Address-family test in rtoCsvImport.test.js for exactly why. A CSV header
// claimed by one target is removed from the pool so it cannot be double-assigned.
function matchHeaders(sheetTargetHeaders, csvHeaders) {
  const remaining = new Map(csvHeaders.map((h) => [h, normalizeHeader(h)]));
  const result = sheetTargetHeaders.map((sheetHeader) => ({ sheetHeader, csvHeader: null }));

  // Pass 1: exact normalized equality.
  result.forEach((entry) => {
    const targetNorm = normalizeHeader(entry.sheetHeader);
    for (const [csvHeader, csvNorm] of remaining) {
      if (csvNorm === targetNorm) {
        entry.csvHeader = csvHeader;
        remaining.delete(csvHeader);
        break;
      }
    }
  });

  // Pass 2: substring fuzzy, only for what pass 1 left unmatched.
  result.forEach((entry) => {
    if (entry.csvHeader !== null) return;
    const targetNorm = normalizeHeader(entry.sheetHeader);
    if (!targetNorm) return;
    for (const [csvHeader, csvNorm] of remaining) {
      if (!csvNorm) continue;
      if (csvNorm.includes(targetNorm) || targetNorm.includes(csvNorm)) {
        entry.csvHeader = csvHeader;
        remaining.delete(csvHeader);
        break;
      }
    }
  });

  return result;
}

// Finds the CSV header matched to whichever target header conceptually means `conceptualName`
// (e.g. 'awb code', 'order id') - conceptualName is compared via the SAME normalization, so
// callers pass a human-readable string, not an exact-cased header. Returns null (never throws)
// if no target header matches that concept at all, or if it matched no CSV column.
function findRequiredMatch(matchResult, conceptualName) {
  const target = normalizeHeader(conceptualName);
  const entry = matchResult.find((r) => normalizeHeader(r.sheetHeader) === target);
  return entry ? entry.csvHeader : null;
}

function normalizeAwb(v) {
  return (v || '').toString().trim().toUpperCase();
}

// The main orchestration: turns parsed CSV row objects (keyed by RAW csv header, exactly
// parseCSV's output shape) into { validRows, errors, counts }, applying blank-AWB rejection,
// within-file dedup (first occurrence wins), and against-the-sheet dedup, in that order.
//
// Each valid row gets:
//   - orderId, awbCode, paymentMethod, rtoReason: convenience top-level fields, pulled via
//     whichever CSV header matched each concept (awbCode/orderId are guaranteed matched by
//     the time this runs - the caller rejects the whole upload upfront otherwise; paymentMethod/
//     rtoReason may be '' if that target had no CSV match, which is fine - they're best-effort).
//   - cells: { targetSheetHeader: value }, one entry per target header that DID find a CSV
//     match - the caller converts this to column letters via headerToColumnLetter for the
//     actual sheet write. A target with no CSV match is simply absent from `cells`, which the
//     caller treats as "leave that column blank for this row".
function buildRowPlan({ matchResult, csvRows, existingAwbSet }) {
  const awbCsvHeader = findRequiredMatch(matchResult, 'awb code');
  const orderIdCsvHeader = findRequiredMatch(matchResult, 'order id');
  const paymentCsvHeader = findRequiredMatch(matchResult, 'payment method');
  const reasonCsvHeader = findRequiredMatch(matchResult, 'rto reason');

  const validRows = [];
  const errors = [];
  const counts = { missingAwb: 0, duplicateInFile: 0, duplicateInSheet: 0 };
  const seenInFile = new Set();

  csvRows.forEach((row, i) => {
    const line = i + 2; // +1 for 1-based, +1 for the header row not being a data row
    const rawAwb = awbCsvHeader ? row[awbCsvHeader] : '';
    const awb = normalizeAwb(rawAwb);

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

    const cells = {};
    matchResult.forEach(({ sheetHeader, csvHeader }) => {
      if (csvHeader !== null) cells[sheetHeader] = (row[csvHeader] || '').toString().trim();
    });

    validRows.push({
      orderId: (orderIdCsvHeader ? row[orderIdCsvHeader] : '') || '',
      awbCode: awb,
      paymentMethod: (paymentCsvHeader ? row[paymentCsvHeader] : '') || '',
      rtoReason: (reasonCsvHeader ? row[reasonCsvHeader] : '') || '',
      cells,
    });
  });

  return { validRows, errors, counts };
}

// Maps a header's text to its column letter (A, B, ..., Z, AA, AB, ...) within a full header
// row read as `Data!A1:AD1` - normalized comparison, so this tolerates the live sheet's own
// header whitespace quirks (e.g. '  Payment Method' with two leading spaces, confirmed live).
function headerToColumnLetter(fullHeaderRow, targetHeader) {
  const targetNorm = normalizeHeader(targetHeader);
  const idx = fullHeaderRow.findIndex((h) => normalizeHeader(h) === targetNorm);
  if (idx === -1) return null;
  let n = idx;
  let col = '';
  while (true) {
    col = String.fromCharCode(65 + (n % 26)) + col;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return col;
}

module.exports = {
  normalizeHeader, matchHeaders, findRequiredMatch, normalizeAwb, buildRowPlan,
  headerToColumnLetter,
};
