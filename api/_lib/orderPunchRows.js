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


// A worker invoke can also die with nothing written anywhere: Postgres unreachable before the
// first UPDATE, or Lambda killing the invoke at its 900s ceiling mid-row (retries are
// deliberately disabled - see lambda/deploy_infra.sh). Neither leaves a 'failed' row, so the
// job stays 'queued'/'running' forever and the UI can only show what looks like progress. The
// worker bumps order_punch_jobs.updated_at on every row and every status change, so silence
// past this window means nothing is alive to bump it - the only stall signal available without
// a watchdog Lambda polling for one.
//
// 15 minutes, not tighter: the worker's own chunk budget is 800s, and a slow row can burn a
// 30s HTTP timeout plus its 30s 403 backoff before the next counter write. Anything quieter
// than 15 minutes is dead, not slow.
// ponytail: read-time check on updated_at, not a real watchdog. A watchdog Lambda that
// actually marks such jobs failed is only worth it if these ever need to resolve themselves
// with no one watching the tab.
const STALL_AFTER_MS = 15 * 60 * 1000;
const LIVE_STATUSES = new Set(['queued', 'running']);

function isJobStalled(status, updatedAt, now = Date.now()) {
  if (!LIVE_STATUSES.has(status)) return false;
  const ts = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return false;
  return now - ts > STALL_AFTER_MS;
}

module.exports = { validateRows, isJobStalled, STALL_AFTER_MS };
