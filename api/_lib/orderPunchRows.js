// Pure validation for Order Punch's /start payload - shared by the CSV-upload path and the
// manual multi-row form on the client, since both ultimately POST the same
// {doc, reason, facility_code}[] shape. No network, no DB - see
// docs/superpowers/specs/2026-08-21-order-punch-design.md.
function validateRows(rows) {
  const validRows = [];
  const errors = [];
  (rows || []).forEach((r, i) => {
    const doc = String((r && r.doc) || '').trim();
    if (!doc) {
      errors.push({ line: i + 1, reason: 'Missing order code' });
      return;
    }
    validRows.push({
      doc,
      reason: String((r && r.reason) || '').trim(),
      facility_code: String((r && r.facility_code) || '').trim(),
    });
  });
  return { validRows, errors };
}

module.exports = { validateRows };
