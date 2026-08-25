// POST /api/rto/upload-start - admin or rto process-admin only. The FAST half of the CSV
// upload feature: parses, validates the sheet layout + CSV headers against a fixed column
// mapping, dedupes by AWB, appends non-prepaid rows immediately (nothing to check for them),
// and hands the prepaid rows off to a background Lambda for the GoKwik/LMD checks - see
// docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md for why those checks cannot run
// here (mcaff_prod MySQL is reachable only from Python) or synchronously within one browser
// request (API Gateway's ~29s ceiling).
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');
const { parseCSV } = require('../_lib/csv');
const {
  buildRowPlan, checkSheetLayout, columnLetterToIndex, normalizeAwb, parseAppendedRowRange,
  CSV_TO_COLUMN, LAST_COLUMN_LETTER, REQUIRED_CSV_HEADERS,
} = require('../_lib/rtoCsvImport');
const { createRtoCsvUploadJob, updateRtoCsvUploadJob, isCallingProcessAdmin } = require('../_lib/db');
const { triggerLambda } = require('../_lib/lambdaTrigger');

const RTO_SHEET_ID = '1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI';
const SHEET_TAB = 'Data';
const CARD_KEY = 'calling';
const TAB_KEY = 'rto';
const MAX_ROWS = 5000;
const CSV_UPLOAD_WORKER_LAMBDA = 'mcaff-cls-csv-upload-worker';
const AWB_COLUMN = CSV_TO_COLUMN['AWB Code']; // 'G' - fixed, not derived from any header search
const ROW_WIDTH = columnLetterToIndex(LAST_COLUMN_LETTER) + 1;

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

async function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, TAB_KEY))) {
    return 'Only admins or this process\'s admin can upload leads.';
  }
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to RTO-CRM.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to RTO-CRM.';
  return null;
}

// COD/blank-payment-method is never GoKwik-checked (nothing was paid upfront to refund) -
// same is_prepaid rule as scripts/lead_priority.py, kept in sync manually since Python cannot
// execute JS (see leadAssignmentRules.json's own _readme for this codebase's existing
// precedent for that constraint).
function isPrepaid(paymentRaw) {
  const p = (paymentRaw || '').toUpperCase();
  return !(p.includes('COD') || p.includes('CASH'));
}

// Places each row's { columnLetter: value } map into a fixed-width array (index 0 = column A,
// ... up to LAST_COLUMN_LETTER), ready for a single contiguous values:append covering the
// whole width. Columns with no entry (F/Unique, Q-AA/agent-worked fields) stay '' - a single
// wide append is used rather than two narrower ones (e.g. A:P then AB:AC) because Sheets'
// append picks its target row independently per call based on that range's own last-used row,
// and there is no guarantee A:P and AB:AC would land on the same row.
function rowToFullArray(cellsByColumn) {
  const arr = new Array(ROW_WIDTH).fill('');
  Object.entries(cellsByColumn).forEach(([col, val]) => { arr[columnLetterToIndex(col)] = val; });
  return arr;
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
  const missingCsvHeaders = REQUIRED_CSV_HEADERS.filter((h) => !csvHeaders.includes(h));
  if (missingCsvHeaders.length) {
    res.status(400).json({
      error: `This CSV is missing required column(s): ${missingCsvHeaders.join(', ')}.`,
      csvHeaders,
    });
    return;
  }

  try {
    const client = getClient();

    // Sheet-layout drift check - the column mapping this feature writes to is fixed
    // (CSV_TO_COLUMN), not derived from the live header row, so this exists purely to catch
    // someone inserting/reordering a column in the live sheet before this silently writes
    // into the wrong place.
    const headerData = await sheetsRequest(client, 'GET', `/values/${encodeURIComponent(`'${SHEET_TAB}'!A1:AD1`)}`);
    const fullHeaderRow = (headerData.values || [[]])[0] || [];
    const layoutIssues = checkSheetLayout(fullHeaderRow);
    if (layoutIssues.length) {
      res.status(500).json({
        error: 'Sheet column layout has changed unexpectedly - refusing to append to avoid writing misaligned data. Contact an admin.',
        details: layoutIssues,
      });
      return;
    }

    // Existing AWBs across the WHOLE sheet, not just unassigned rows - see the spec's dedup
    // section for why a duplicate of an already-disposed lead still counts.
    const awbData = await sheetsRequest(client, 'GET', `/values/${encodeURIComponent(`'${SHEET_TAB}'!${AWB_COLUMN}2:${AWB_COLUMN}`)}`);
    const existingAwbSet = new Set(
      (awbData.values || []).map((r) => ((r && r[0]) || '').toString().trim().toUpperCase()).filter(Boolean),
    );

    const plan = buildRowPlan({ csvRows, existingAwbSet });

    const prepaidRows = plan.validRows.filter((r) => isPrepaid(r.paymentMethod));
    const nonPrepaidRows = plan.validRows.filter((r) => !isPrepaid(r.paymentMethod));

    // Non-prepaid rows need no check at all - append them right away rather than making them
    // wait on the worker. ONE batched values:append via the existing /api/rto/sheet proxy's
    // own op=batchUpdate would not work here (that endpoint only overwrites existing cells,
    // it has no append semantics) - so this hits the Sheets API directly, same as every other
    // write in this file, but via values:append specifically.
    let appendedNow = 0;
    let mappingWarning = null;
    if (nonPrepaidRows.length) {
      const rowsToAppend = nonPrepaidRows.map((r) => rowToFullArray(r.cellsByColumn));
      const appendResp = await sheetsRequest(
        client, 'POST',
        `/values/${encodeURIComponent(`'${SHEET_TAB}'!A2`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { values: rowsToAppend },
      );
      appendedNow = nonPrepaidRows.length;

      // Post-write sanity check: the layout check above only catches a HEADER-row drift, not
      // a mismatch between what this function computed and what actually landed in the sheet
      // (e.g. the deployed copy of this file being out of sync with what's on disk - confirmed
      // as the cause of the 2026-08-22 corrupted rows). AWB Code is checked because it's
      // independent of cellsByColumn - buildRowPlan derives r.awbCode straight from the CSV's
      // own AWB column, not from the map this endpoint is verifying.
      // ponytail: single-column canary, not a full-row round-trip - upgrade if insufficient.
      const updatedRange = (appendResp && appendResp.updates && appendResp.updates.updatedRange) || '';
      const rangeMatch = parseAppendedRowRange(updatedRange);
      if (rangeMatch) {
        const [firstRow, lastRow] = rangeMatch;
        // This whole block is verification only - it must never abort the request. It used to:
        // a malformed range (the deployed \w+ regex produced 'Data'!G0:G9, Sheets 400) threw
        // out to the outer catch AFTER the COD rows had already appended, so the prepaid
        // queueing below never ran at all - COD landed, prepaid silently vanished, and the
        // only way to retry re-appended the COD half as duplicates.
        try {
          const verifyData = await sheetsRequest(
            client, 'GET',
            `/values/${encodeURIComponent(`'${SHEET_TAB}'!${AWB_COLUMN}${firstRow}:${AWB_COLUMN}${lastRow}`)}`,
          );
          const actualAwbs = (verifyData.values || []).map((r) => normalizeAwb((r && r[0]) || ''));
          const mismatch = nonPrepaidRows.some((r, i) => actualAwbs[i] !== r.awbCode);
          if (mismatch) {
            console.error(
              `api/rto/upload-start: post-append AWB verification FAILED for rows ${firstRow}-${lastRow} `
              + '- appended data landed in the wrong columns. Rows are already written and need manual correction.',
            );
            mappingWarning = `Appended ${appendedNow} row(s) but a post-write check found them in the wrong `
              + `columns (rows ${firstRow}-${lastRow}). Do not trust this data - contact an admin.`;
          }
        } catch (e) {
          console.error('api/rto/upload-start: post-append AWB verification could not run:', e);
          mappingWarning = `Appended ${appendedNow} row(s) but the post-write column check could `
            + `not be completed (${e.message}). The rows are in the sheet but unverified.`;
        }
      }
    }

    // The non-prepaid append above (if any) has already succeeded by this point - a failure
    // queuing the prepaid rows must not report a blanket 500, which would wrongly tell the
    // client nothing happened. Caught separately so the response below still reflects the
    // append that already landed.
    let jobId = null;
    let queueError = null;
    if (prepaidRows.length) {
      try {
        jobId = await createRtoCsvUploadJob({
          createdBy: session.email,
          totalRows: prepaidRows.length,
          prepaidCount: prepaidRows.length,
          rowsPending: prepaidRows,
        });
        // Records the WHOLE upload's outcome (not just the prepaid subset the job otherwise
        // only ever tracks) - duplicate/missing/error counts from plan.counts/plan.errors were
        // computed above but, before this call, only ever returned in the HTTP response, where
        // they were lost as soon as the browser modal closed. Same try/catch as job creation
        // above: a failure here follows the existing queueError path rather than a new one.
        await updateRtoCsvUploadJob(jobId, {
          duplicate_in_sheet_count: plan.counts.duplicateInSheet,
          duplicate_in_file_count: plan.counts.duplicateInFile,
          missing_awb_count: plan.counts.missingAwb,
          errors: plan.errors.slice(0, 50),
        });
        // triggerLambda never throws - a dropped invoke (missing lambda:InvokeFunction, the
        // worker not deployed, ...) resolves to false rather than rejecting, so it must be
        // checked explicitly or the job sits at 'queued' forever with nothing anywhere to say
        // why (same failure mode api/order-punch/start.js already guards against - see its own
        // comment on the 2026-08-21 incident this is the RTO-upload counterpart of).
        const invoked = await triggerLambda(CSV_UPLOAD_WORKER_LAMBDA, { jobId });
        if (!invoked) {
          const msg = `Could not start the background worker (${CSV_UPLOAD_WORKER_LAMBDA}) - `
            + 'it may not be deployed, or this API\'s role may lack lambda:InvokeFunction on it. '
            + 'The rows were saved but nothing will process them until that is fixed.';
          console.error(`api/rto/upload-start: invoke of ${CSV_UPLOAD_WORKER_LAMBDA} was not accepted for job ${jobId}`);
          await updateRtoCsvUploadJob(jobId, { status: 'failed', error_message: msg });
        }
      } catch (e) {
        console.error('api/rto/upload-start: failed to queue prepaid rows:', e);
        jobId = null;
        queueError = 'Could not queue the prepaid rows for refund/punch checking - contact an admin to re-run this batch.';
      }
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
      ...(queueError ? { queueError } : {}),
      ...(mappingWarning ? { mappingWarning } : {}),
    });
  } catch (e) {
    console.error('api/rto/upload-start error:', e);
    res.status(500).json({ error: e.message || 'Could not process this upload' });
  }
};
