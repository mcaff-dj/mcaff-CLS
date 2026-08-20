// POST /api/rto/upload-start - admin-only. The FAST half of the CSV upload feature: parses,
// validates headers against the live sheet, dedupes by AWB, appends non-prepaid rows
// immediately (nothing to check for them), and hands the prepaid rows off to a background
// Lambda for the GoKwik/LMD checks - see docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md
// for why those checks cannot run here (mcaff_prod MySQL is reachable only from Python) or
// synchronously within one browser request (API Gateway's ~29s ceiling).
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');
const { parseCSV } = require('../_lib/csv');
const {
  matchHeaders, findRequiredMatch, buildRowPlan, headerToColumnLetter,
} = require('../_lib/rtoCsvImport');
const { createRtoCsvUploadJob } = require('../_lib/db');
const { triggerLambda } = require('../_lib/lambdaTrigger');

const RTO_SHEET_ID = '1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI';
const SHEET_TAB = 'Data';
const CARD_KEY = 'calling';
const TAB_KEY = 'rto';
const MAX_ROWS = 5000;
const CSV_UPLOAD_WORKER_LAMBDA = 'mcaff-cls-csv-upload-worker';

// Same 15 target columns the user specified, matched against the LIVE sheet by name (see
// api/_lib/rtoCsvImport.js) - this list exists only to know which of the sheet's own header
// row entries are the ones this feature cares about mapping; it is never used as a source of
// truth for what the sheet's headers actually say right now.
const TARGET_HEADERS = [
  'RTO Initiated Date', 'Latest NDR Date', 'RTO Reason', 'Order ID', 'Unique', 'AWB Code',
  'Customer Email', 'Customer Name', 'Customer Mobile', 'Address', 'Address City',
  'Address State', 'Address Pincode', 'Payment Method', 'Order Total',
];

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
    url: `https://sheets.googleapis.com/v4/spreadsheets/${RTO_SHEET_ID}${path}`,
    method,
    data: body,
  });
  return res.data;
}

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin) return 'Only admins can upload leads.';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to RTO-CRM.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to RTO-CRM.';
  return null;
}

// COD/blank-payment-method is never GoKwik-checked (nothing was paid upfront to refund) -
// same is_prepaid rule as scripts/lead_priority.py, kept in sync manually since Python cannot
// execute JS (see leadAssignmentRules.json's own _readme for this codebase's existing
// precedent for that constraint). Only used here to split rows for the job's prepaid_count and
// to decide which rows even need queuing for the worker's refund-check phase.
function isPrepaid(paymentRaw) {
  const p = (paymentRaw || '').toUpperCase();
  return !(p.includes('COD') || p.includes('CASH'));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  const denied = checkAccess(session);
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

  try {
    const client = getClient();

    // Live sheet headers - the source of truth for matching, never a hardcoded list beyond
    // TARGET_HEADERS' own names above (which only say WHICH 15 concepts this feature maps,
    // not what the sheet currently calls them).
    const headerData = await sheetsRequest(client, 'GET', `/values/${encodeURIComponent(`'${SHEET_TAB}'!A1:AD1`)}`);
    const fullHeaderRow = (headerData.values || [[]])[0] || [];
    const csvHeaders = Object.keys(csvRows[0]);
    const matchResult = matchHeaders(TARGET_HEADERS, csvHeaders);

    const missingRequired = [];
    if (!findRequiredMatch(matchResult, 'awb code')) missingRequired.push('AWB Code');
    if (!findRequiredMatch(matchResult, 'order id')) missingRequired.push('Order ID');
    if (missingRequired.length) {
      res.status(400).json({
        error: `Could not find a column matching ${missingRequired.join(' or ')} in the CSV headers.`,
        csvHeaders,
      });
      return;
    }

    // Existing AWBs across the WHOLE sheet, not just unassigned rows - see the spec's dedup
    // section for why a duplicate of an already-disposed lead still counts.
    const awbColLetter = headerToColumnLetter(fullHeaderRow, 'AWB Code');
    const awbData = await sheetsRequest(client, 'GET', `/values/${encodeURIComponent(`'${SHEET_TAB}'!${awbColLetter}2:${awbColLetter}`)}`);
    const existingAwbSet = new Set(
      (awbData.values || []).map((r) => ((r && r[0]) || '').toString().trim().toUpperCase()).filter(Boolean),
    );

    const plan = buildRowPlan({ matchResult, csvRows, existingAwbSet });

    const prepaidRows = plan.validRows.filter((r) => isPrepaid(r.paymentMethod));
    const nonPrepaidRows = plan.validRows.filter((r) => !isPrepaid(r.paymentMethod));

    // Non-prepaid rows need no check at all - append them right away rather than making them
    // wait on the worker. ONE batched values:append via the existing /api/rto/sheet proxy's
    // own op=batchUpdate would not work here (that endpoint only overwrites existing cells,
    // it has no append semantics) - so this hits the Sheets API directly, same as every other
    // write in this file, but via values:append specifically.
    let appendedNow = 0;
    if (nonPrepaidRows.length) {
      const rowsToAppend = nonPrepaidRows.map((r) => TARGET_HEADERS.map((h) => r.cells[h] || ''));
      const startCol = headerToColumnLetter(fullHeaderRow, TARGET_HEADERS[0]);
      await sheetsRequest(
        client, 'POST',
        `/values/${encodeURIComponent(`'${SHEET_TAB}'!${startCol}2`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { valueInputOption: 'USER_ENTERED', values: rowsToAppend },
      );
      appendedNow = nonPrepaidRows.length;
    }

    let jobId = null;
    if (prepaidRows.length) {
      jobId = await createRtoCsvUploadJob({
        createdBy: session.email,
        totalRows: prepaidRows.length,
        prepaidCount: prepaidRows.length,
        rowsPending: prepaidRows,
      });
      await triggerLambda(CSV_UPLOAD_WORKER_LAMBDA, { jobId });
    }

    res.status(200).json({
      jobId,
      appended: appendedNow,
      queuedForCheck: prepaidRows.length,
      duplicateInSheet: plan.counts.duplicateInSheet,
      duplicateInFile: plan.counts.duplicateInFile,
      missingAwb: plan.counts.missingAwb,
      total: csvRows.length,
      errors: plan.errors.slice(0, 50),
    });
  } catch (e) {
    console.error('api/rto/upload-start error:', e);
    res.status(500).json({ error: e.message || 'Could not process this upload' });
  }
};
