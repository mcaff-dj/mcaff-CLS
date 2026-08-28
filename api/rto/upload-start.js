// POST /api/rto/upload-start - admin or rto process-admin only. The FAST half of the CSV
// upload feature: parses, validates the sheet layout + CSV headers against a fixed column
// mapping, dedupes by AWB (within the file first, then against the sheet), and hands every
// surviving row to a background Lambda that runs the LMD/GoKwik checks and does the actual
// append. This endpoint writes nothing to the sheet itself - see
// docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md for the original design.
//
// That doc's "mcaff_prod MySQL is reachable only from Python" no longer holds and was corrected
// here on 2026-08-28: the app's own DB user carries GRANT SELECT ON mcaff_prod.* (verified
// against the live server), and api/ndr/upload.js now reads mcaff_prod.lmd_courier_tracking
// straight from Node through the same pool. The split below is justified by the GoKwik call
// alone - that is one HTTP request PER ROW, and thousands of them cannot finish inside API
// Gateway's ~29s ceiling. A batched MySQL lookup can, which is why the NDR upload stayed
// synchronous rather than copying this shape.
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');
const { parseCSV } = require('../_lib/csv');
const {
  buildRowPlan, checkSheetLayout, CSV_TO_COLUMN, REQUIRED_CSV_HEADERS,
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

// Retries on 429 with backoff. Every Sheets call in this app authenticates as the SAME service
// account, so Google's "Read requests per minute per user" limit (60) is shared app-wide - see
// the 2026-08-20 incident notes in api/rto/next-lead.js. Without this, a single 429 anywhere in
// a chunked upload (RtoUploadModal.js splits a large CSV into many sequential /upload-start
// calls, each costing 2 reads here plus 3 more in the worker) aborted the whole remaining file
// with the raw Google quota string. The quota window is per minute, so a few seconds of waiting
// clears it; scripts/lib.py's get_sheet_values has retried the same way on the Python side since
// that incident, and this endpoint was the one path left without it.
// 3 attempts x a 3s-scaled backoff = at most 9s spent waiting (3s + 6s), deliberately bounded:
// this endpoint sits behind API Gateway, whose integration timeout (29s) would otherwise fire
// mid-backoff and replace the real quota message with an opaque gateway error - the same class of
// failure api/_lambda/app.js already documents for oversized reads. A quota window is a full
// minute, so this does NOT ride out a sustained outage; it rides out the self-inflicted burst of
// one chunked upload's own reads, which is what actually broke.
const SHEETS_MAX_ATTEMPTS = 3;
const SHEETS_RETRY_BASE_MS = 3000;

function isRateLimited(e) {
  // google-auth-library wraps gaxios: the status lands on the error itself in newer versions and
  // on .response.status in older ones. Check both rather than pinning to one shape.
  return !!e && (e.status === 429 || (e.response && e.response.status) === 429);
}

// baseDelayMs is a parameter purely so upload-start.test.js can exercise the retry loop without
// sitting through the real 3s/6s waits - every caller here uses the default.
async function sheetsRequest(client, method, path, body, baseDelayMs = SHEETS_RETRY_BASE_MS) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await client.request({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${RTO_SHEET_ID}${path}`,
        method,
        data: body,
      });
      return res.data;
    } catch (e) {
      if (!isRateLimited(e) || attempt >= SHEETS_MAX_ATTEMPTS) throw e;
      console.warn(`api/rto/upload-start: Sheets 429 on ${method} ${path}, attempt ${attempt}/${SHEETS_MAX_ATTEMPTS} - backing off`);
      await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
    }
  }
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
    // UNFORMATTED_VALUE, not Sheets' FORMATTED_VALUE default: rows written before AWBs were
    // forced to text are stored as numbers, and their FORMATTED value is the display string
    // "5.4E+13" - which matches no real AWB, so every one of them slipped past this dedup.
    // Unformatted returns the underlying number, whose toString() is the digits again.
    const awbData = await sheetsRequest(client, 'GET', `/values/${encodeURIComponent(`'${SHEET_TAB}'!${AWB_COLUMN}2:${AWB_COLUMN}`)}?valueRenderOption=UNFORMATTED_VALUE`);
    const existingAwbSet = new Set(
      (awbData.values || []).map((r) => ((r && r[0]) || '').toString().trim().toUpperCase()).filter(Boolean),
    );

    const plan = buildRowPlan({ csvRows, existingKeySet: existingAwbSet });

    // EVERY valid row goes to the worker - not just the prepaid ones. These are two different
    // checks with two different scopes, and gating both on isPrepaid conflated them: the GoKwik
    // refund check is genuinely prepaid-only (COD paid nothing upfront, so there is nothing to
    // have been refunded), but the LMD already-punched check applies to any payment method - a
    // replacement order makes the original RTO pointless however it was paid for, which is
    // exactly how scripts/assign_leads.py treats its own pool (see its punch_check_by_row, set
    // with no is_prepaid gate). COD rows used to be appended straight to the sheet here and
    // never queued, so check_already_punched never saw them; confirmed live on HYP43652510,
    // punched in D2C yet handed out as a fresh lead. The worker already punch-checks every row
    // it receives and narrows to prepaid only for the refund phase, so it needs no change.
    //
    // Nothing is appended from this endpoint any more: the punch check has to happen BEFORE the
    // write, so the write belongs where the check is. The worker's own append, layout check and
    // AWB canary now cover the whole upload rather than just its prepaid half.
    const prepaidRows = plan.validRows.filter((r) => isPrepaid(r.paymentMethod));

    let jobId = null;
    let queueError = null;
    if (plan.validRows.length) {
      try {
        jobId = await createRtoCsvUploadJob({
          createdBy: session.email,
          totalRows: plan.validRows.length,
          prepaidCount: prepaidRows.length,
          rowsPending: plan.validRows,
        });
        // Records the rows that never made it into the job at all - the duplicate/missing/
        // error counts from plan.counts/plan.errors were computed above but, before this call,
        // only ever returned in the HTTP response, where they were lost as soon as the browser
        // modal closed. Same try/catch as job creation above: a failure here follows the
        // existing queueError path rather than a new one.
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
        console.error('api/rto/upload-start: failed to queue rows:', e);
        jobId = null;
        queueError = 'Could not queue the rows for punch/refund checking - nothing was written to the sheet. Contact an admin to re-run this batch.';
      }
    }

    res.status(200).json({
      jobId,
      queuedForCheck: plan.validRows.length,
      prepaidQueued: prepaidRows.length,
      duplicateInSheet: plan.counts.duplicateInSheet,
      duplicateInFile: plan.counts.duplicateInFile,
      missingAwb: plan.counts.missingAwb,
      scientificAwb: plan.counts.scientificAwb,
      total: csvRows.length,
      errors: plan.errors.slice(0, 50),
      ...(queueError ? { queueError } : {}),
    });
  } catch (e) {
    console.error('api/rto/upload-start error:', e);
    res.status(500).json({ error: e.message || 'Could not process this upload' });
  }
};

// Attached to the handler export the same way api/rto/next-lead.js attaches its pure helpers, so
// upload-start.test.js exercises the SAME retry code the request path runs.
module.exports.sheetsRequest = sheetsRequest;
module.exports.isRateLimited = isRateLimited;
module.exports.SHEETS_MAX_ATTEMPTS = SHEETS_MAX_ATTEMPTS;
