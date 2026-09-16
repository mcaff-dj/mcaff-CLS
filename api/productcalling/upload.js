// POST /api/productcalling/upload - admin or this process's admin only. Bulk-adds leads from a
// CSV straight into CLS_productcalling as unassigned rows. Interim lead-intake mechanism until
// the real lead source is confirmed (see docs/superpowers/specs/2026-09-16-product-calling-design.md)
// - deliberately NOT built on rtoCsvImport.js's Sheet-sync engine, since there is no Sheet here.
const { getSession } = require('../_lib/session');
const { parseCSV } = require('../_lib/csv');
const { planProductCallingImport, PRODUCTCALLING_REQUIRED_CSV_HEADERS } = require('../_lib/productCallingCsvImport');
const { insertProductCallingLeads, isCallingProcessAdmin } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'productkyc';
const MAX_ROWS = 5000;

async function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, TAB_KEY))) {
    return 'Only admins or this process\'s admin can upload leads.';
  }
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Product Calling.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Product Calling.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  const denied = await checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  const { csv } = req.body || {};
  if (!csv || typeof csv !== 'string') {
    res.status(400).json({ error: 'csv text is required' });
    return;
  }

  let csvRows;
  try {
    csvRows = parseCSV(csv);
  } catch (e) {
    res.status(400).json({ error: `Could not parse CSV: ${e.message}` });
    return;
  }
  if (!csvRows.length) {
    res.status(400).json({ error: 'No data rows found in the CSV' });
    return;
  }
  if (csvRows.length > MAX_ROWS) {
    res.status(400).json({ error: `CSV has ${csvRows.length} rows - the limit is ${MAX_ROWS} per upload. Split it into smaller files.` });
    return;
  }

  const csvHeaders = Object.keys(csvRows[0]);
  const missingCsvHeaders = PRODUCTCALLING_REQUIRED_CSV_HEADERS.filter((h) => !csvHeaders.includes(h));
  if (missingCsvHeaders.length) {
    res.status(400).json({
      error: `This CSV is missing required column(s): ${missingCsvHeaders.join(', ')}.`,
      csvHeaders,
    });
    return;
  }

  try {
    const plan = planProductCallingImport(csvRows);
    const { inserted, duplicates } = plan.validRows.length
      ? await insertProductCallingLeads(plan.validRows, session.email)
      : { inserted: 0, duplicates: 0 };

    const MAX_REPORTED_ERRORS = 50;
    res.status(200).json({
      inserted,
      duplicates,
      missingPhone: plan.counts.missingPhone,
      duplicateInFile: plan.counts.duplicateInFile,
      total: csvRows.length,
      errors: plan.errors.slice(0, MAX_REPORTED_ERRORS),
    });
  } catch (e) {
    console.error('api/productcalling/upload error:', e);
    res.status(500).json({ error: e.message || 'Could not process this upload' });
  }
};
