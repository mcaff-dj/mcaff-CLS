// Pure CSV-row validation/planning for the Product Calling admin upload
// (api/productcalling/upload.js). Deliberately not built on rtoCsvImport.js's engine - that
// engine's job is syncing rows into a live Google Sheet (column-letter mapping, header-drift
// detection), which does not apply here: Product Calling has no backing Sheet, leads land
// straight into CLS_productcalling (see api/_lib/db.js's insertProductCallingLeads). Lives here,
// next to nothing but its own logic, so it can be unit-tested without a session/DB - the caller
// (api/productcalling/upload.js) is an HTTP handler that needs both before any of this runs.
const PRODUCTCALLING_REQUIRED_CSV_HEADERS = ['Customer Name', 'Customer Phone'];

// line is 1-based and counts the header row as line 1, matching every other CSV importer in
// this codebase (see ndrCsvImport.js's own `line` convention) - csvRows here is already
// header-stripped (parseCSV's output), so row index 0 is line 2.
function planProductCallingImport(csvRows) {
  const validRows = [];
  const errors = [];
  const counts = { missingPhone: 0, duplicateInFile: 0 };
  const seenLeadRefs = new Set();

  csvRows.forEach((row, idx) => {
    const line = idx + 2;
    const phone = (row['Customer Phone'] || '').trim();
    if (!phone) {
      counts.missingPhone += 1;
      errors.push({ line, reason: 'Skipped - Customer Phone is required and was blank' });
      return;
    }
    const leadRef = (row['Lead Ref'] || '').trim() || phone;
    if (seenLeadRefs.has(leadRef)) {
      counts.duplicateInFile += 1;
      errors.push({ line, reason: `Skipped - duplicate lead ref/phone "${leadRef}" already seen earlier in this file` });
      return;
    }
    seenLeadRefs.add(leadRef);
    validRows.push({
      leadRef,
      customerName: (row['Customer Name'] || '').trim() || null,
      customerPhone: phone,
      customerEmail: (row['Customer Email'] || '').trim() || null,
      productKey: (row['Product'] || '').trim() || null,
      productCategory: (row['Product Category'] || '').trim() || null,
      notes: (row['Notes'] || '').trim() || null,
    });
  });

  return { validRows, errors, counts };
}

module.exports = { planProductCallingImport, PRODUCTCALLING_REQUIRED_CSV_HEADERS };
