// POST /api/ndr/upload - admin or ndr process-admin only. Bulk-adds new NDR leads from a CSV to
// the "Latest NDR " sheet: parses, checks the live sheet's layout hasn't drifted, dedupes by
// AWB + Attempt Count (within the file first, then against the sheet), and appends what survives.
//
// Synchronous, unlike the RTO upload's two-stage endpoint+Lambda split (api/rto/upload-start.js).
// That split exists solely because RTO's rows need GoKwik and mcaff_prod MySQL checks before they
// may be written, and neither is reachable from this runtime inside API Gateway's ~29s ceiling.
// An NDR lead has no such check: nothing was returned to refund and no replacement order exists
// to have been punched, so there is nothing to wait on and no job/worker/polling to justify.
//
// If a check ever IS added here and it needs MySQL, this cannot stay synchronous - it would need
// the same jobs-table + worker-Lambda shape RTO has. Deliberately not scaffolded for that now.
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');
const { parseCSV } = require('../_lib/csv');
const { buildRowPlan, checkSheetLayout, columnLetterToIndex, dedupKey, normalizeAwb } = require('../_lib/rtoCsvImport');
const {
  NDR_IMPORT, NDR_ROW_WIDTH, NDR_LAST_COLUMN_LETTER, NDR_AWB_COLUMN, NDR_ATTEMPT_COLUMN,
} = require('../_lib/ndrCsvImport');
const { isCallingProcessAdmin } = require('../_lib/db');

// Same sheet api/ndr/sheet.js proxies and scripts/assign_ndr_leads.py assigns from. Hardcoded
// rather than taken from the request for the same reason that file gives: a permitted-but-
// malicious caller must not be able to point this service account's Editor access at another
// sheet.
const NDR_SHEET_ID = '12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI';
const SHEET_TAB = 'Latest NDR '; // trailing space is part of the real tab name - do not trim it
const CARD_KEY = 'calling';
const TAB_KEY = 'ndr';
const MAX_ROWS = 5000;

let _client = null;
function getClient() {
  if (!_client) {
    const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    const key = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!email || !key) throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars');
    _client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  }
  return _client;
}

async function sheetsRequest(client, method, path, body) {
  const res = await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${NDR_SHEET_ID}${path}`,
    method,
    data: body,
  });
  return res.data;
}

async function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, TAB_KEY))) {
    return 'Only admins or this process\'s admin can upload leads.';
  }
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to NDR Calling.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to NDR Calling.';
  return null;
}

// Places one row's { columnLetter: value } map into a fixed-width A..Q array, so a single
// contiguous values:append covers every written column. One wide append rather than several
// narrow ones because Sheets picks each append's target row from that range's own last-used row,
// with no guarantee two calls would land on the same row.
function rowToFullArray(cellsByColumn) {
  const arr = new Array(NDR_ROW_WIDTH).fill('');
  Object.entries(cellsByColumn).forEach(([col, val]) => { arr[columnLetterToIndex(col)] = val; });
  return arr;
}

// The dedup key set as the sheet stands right now, built from the same two fields and in the same
// order as NDR_IMPORT.dedupExtraCsvHeaders - otherwise nothing would ever match. Read via
// batchGet so only the two columns that form the key cross the wire, not the whole row width.
//
// UNFORMATTED_VALUE, not Sheets' FORMATTED_VALUE default: a numeric AWB stored as a number has a
// FORMATTED value of "5.4E+13", which matches no real AWB and would silently defeat this dedup
// entirely - the exact bug fixed on the RTO path (see api/rto/upload-start.js's own note).
async function readExistingKeySet(client) {
  const ranges = [`'${SHEET_TAB}'!${NDR_AWB_COLUMN}2:${NDR_AWB_COLUMN}`, `'${SHEET_TAB}'!${NDR_ATTEMPT_COLUMN}2:${NDR_ATTEMPT_COLUMN}`]
    .map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const data = await sheetsRequest(client, 'GET', `/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`);
  const [awbRange, attemptRange] = data.valueRanges || [];
  const awbRows = (awbRange && awbRange.values) || [];
  const attemptRows = (attemptRange && attemptRange.values) || [];

  const keys = new Set();
  // Indexed off the AWB column: a row with no AWB has no identity to dedup against. The two
  // ranges start at the same row, so index i is the same sheet row in both - but the shorter
  // range simply ends early where trailing cells are blank, hence the guarded lookup.
  awbRows.forEach((row, i) => {
    const awb = normalizeAwb((row && row[0]) || '');
    if (!awb) return;
    const attemptRow = attemptRows[i];
    const attempt = (attemptRow && attemptRow[0]) !== undefined ? attemptRow[0] : '';
    keys.add(dedupKey(awb, { 'Attempt Count': attempt }, NDR_IMPORT.dedupExtraCsvHeaders));
  });
  return keys;
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

  // csvHeaders goes back with the error on purpose: the required set is fixed (see
  // ndrCsvImport.js), so when a file doesn't match, the fastest way to see why is the file's own
  // header row next to the missing names.
  const csvHeaders = Object.keys(csvRows[0]);
  const missingCsvHeaders = NDR_IMPORT.requiredCsvHeaders.filter((h) => !csvHeaders.includes(h));
  if (missingCsvHeaders.length) {
    res.status(400).json({
      error: `This CSV is missing required column(s): ${missingCsvHeaders.join(', ')}.`,
      csvHeaders,
    });
    return;
  }

  try {
    const client = getClient();

    // Layout drift check. The column each field goes to is fixed, not derived from this row, so
    // this exists purely to catch someone inserting or reordering a column in the live sheet
    // before that silently lands data in the wrong place. sheetHeader is returned with the
    // failure so the real text is visible without opening the sheet.
    const headerData = await sheetsRequest(
      client, 'GET',
      `/values/${encodeURIComponent(`'${SHEET_TAB}'!A1:Q1`)}`,
    );
    const fullHeaderRow = (headerData.values || [[]])[0] || [];
    const layoutIssues = checkSheetLayout(fullHeaderRow, NDR_IMPORT.expectedHeader);
    if (layoutIssues.length) {
      res.status(500).json({
        error: 'Sheet column layout has changed unexpectedly - refusing to append to avoid writing misaligned data. Contact an admin.',
        details: layoutIssues,
        sheetHeader: fullHeaderRow,
      });
      return;
    }

    const existingKeySet = await readExistingKeySet(client);
    const plan = buildRowPlan({ csvRows, existingKeySet, config: NDR_IMPORT });

    let appended = 0;
    if (plan.validRows.length) {
      await sheetsRequest(
        client, 'POST',
        `/values/${encodeURIComponent(`'${SHEET_TAB}'!A2:${NDR_LAST_COLUMN_LETTER}`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { values: plan.validRows.map((r) => rowToFullArray(r.cellsByColumn)) },
      );
      appended = plan.validRows.length;
    }

    res.status(200).json({
      appended,
      duplicateInSheet: plan.counts.duplicateInSheet,
      duplicateInFile: plan.counts.duplicateInFile,
      missingAwb: plan.counts.missingAwb,
      scientificAwb: plan.counts.scientificAwb,
      total: csvRows.length,
      errors: plan.errors.slice(0, 50),
    });
  } catch (e) {
    console.error('api/ndr/upload error:', e);
    res.status(500).json({ error: e.message || 'Could not process this upload' });
  }
};
