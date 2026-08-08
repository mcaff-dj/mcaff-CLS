// Sheets access for the Escalation desk (app/escalation/) - ported from the standalone app's
// own lib/sheets.js. Two deliberate changes were made in the port:
//
//  1. googleapis -> google-auth-library + the REST endpoint directly. The standalone app
//     depended on `googleapis`; this repo already ships `google-auth-library` and talks to
//     Sheets over plain fetch (see api/rto/sheet.js, api/ndr/sheet.js), so the port reuses that
//     rather than adding a second, much heavier Google client to the Lambda bundle.
//  2. valueInputOption RAW, not USER_ENTERED. Everything this desk writes back is an opaque
//     identifier (replacement order id, AWB/tracking number) or free text - none of it wants
//     Sheets' type guessing. api/ndr/sheet.js documents the concrete bug USER_ENTERED caused
//     there; a long all-digits AWB is exactly the shape that gets silently rewritten as a
//     number (leading zeros dropped, or reformatted in scientific notation).
//
// CREDENTIALS: the shared GOOGLE_SHEETS_CLIENT_EMAIL/GOOGLE_SHEETS_PRIVATE_KEY service account,
// the same pair api/rto/sheet.js and api/ndr/sheet.js use. That account needs Editor on the
// escalation workbook; the standalone app was pointed at the same spreadsheet through its own
// GOOGLE_CLIENT_EMAIL, so if this repo's service account is a different principal it has to be
// added to the sheet's sharing list before writes will succeed.
const { JWT } = require('google-auth-library');

// The one workbook this module is allowed to touch. Hardcoded for the same reason
// api/ndr/sheet.js hardcodes its own: it pins the blast radius of these credentials to a single
// known spreadsheet. Overridable by env for staging against a copy.
const SHEET_ID = process.env.ESCALATION_SHEET_ID || '1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w';
const TAB_NAME = process.env.ESCALATION_SHEET_TAB || 'HYPHEN';

let _client = null;
function getClient() {
  if (_client) return _client;
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars');
  _client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return _client;
}

async function authHeader() {
  const { token } = await getClient().getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

// Column order in the sheet (A..Z), so rows can be read/written by name instead of raw letters.
// Kept byte-identical to the standalone app's own list - the sheet is the shared contract, and
// the write ranges below (T:W) are positional, so reordering this array silently corrupts data.
const COLUMNS = [
  'addedDate', 'queryClass', 'queryCategory', 'parentOrder', 'awbNumber',
  'deliveryPartnerName', 'orderDate', 'orderMonth', 'queryDate', 'queryMonth',
  'whName', 'totalTimesConsumerReached', 'deliveredDate', 'statusAsPerAwb',
  'solvDate', 'tat', 'updateFromLogistics', 'city', 'state', 'newOrderId',
  'awb', 'status', 'notes', '_v1', '_v2', 'ticketNumber',
];

function rowToObject(row, rowNumber) {
  const obj = { rowNumber };
  COLUMNS.forEach((key, i) => { obj[key] = row[i] || ''; });
  return obj;
}

async function readAllRows() {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${TAB_NAME}!A2:Z`)}?majorDimension=ROWS`,
    { headers: await authHeader() }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Sheets read failed (${res.status})`);
  return data.values || [];
}

// The queue: RTO per BOTH the courier (statusAsPerAwb, col N) and logistics
// (updateFromLogistics, col Q), and not yet actioned (status, col V, still blank). Once an agent
// writes V the row drops out on the next load - the sheet is the only store, there's no DB.
//
// NOT filtered on TAT (col P): every currently-pending RTO row carries "Forced to be marked as
// RTO" there, not blank/"unresolved"/"#N/A" - that's the courier-RTO equivalent of "still open",
// so gating on OPEN_TAT_VALUES here zeroed the whole queue out. That rule belongs to Fresh Leads
// below, which has no RTO-column requirement to begin with.
async function getEligibleOrders() {
  const rows = await readAllRows();
  return rows
    .map((row, i) => rowToObject(row, i + 2)) // +2: skip the header, sheet rows are 1-indexed
    .filter((o) => {
      const n = o.statusAsPerAwb.toLowerCase();
      const q = o.updateFromLogistics.toLowerCase();
      return n.includes('rto') && q.includes('rto') && !o.status;
    });
}

// Fresh Leads: not yet actioned (status blank) and TAT (col P) hasn't landed in a computed
// bucket yet - blank, "unresolved", or "#N/A". No RTO-column requirement, unlike the queue above.
const OPEN_TAT_VALUES = new Set(['', 'unresolved', '#n/a']);
async function getFreshLeads() {
  const rows = await readAllRows();
  return rows
    .map((row, i) => rowToObject(row, i + 2))
    .filter((o) => !o.status && OPEN_TAT_VALUES.has(o.tat.trim().toLowerCase()));
}

// Write New Order Id / AWB / Status / Notes into columns T/U/V/W for one row.
async function updateOrder(rowNumber, { newOrderId, newAwb, newStatus, notes = '' }) {
  return batchUpdateOrders([{ rowNumber, newOrderId, newAwb, newStatus, notes }]);
}

// Write many rows in one request (avoids per-row round-trips and Sheets rate limits).
// updates: [{ rowNumber, newOrderId, newAwb, newStatus, notes }]
async function batchUpdateOrders(updates) {
  const data = updates.map((u) => ({
    range: `${TAB_NAME}!T${u.rowNumber}:W${u.rowNumber}`,
    values: [[u.newOrderId ?? '-', u.newAwb ?? '-', u.newStatus ?? '', u.notes ?? '']],
  }));
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
    {
      method: 'POST',
      headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'RAW', data }),
    }
  );
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error?.message || `Sheets write failed (${res.status})`);
  return updates.length;
}

// Lookup index for matching imported CSV rows back to sheet rows: keyed by parent order, and by
// "parentOrder||awb" for an exact match when the file carries an AWB too.
async function getSheetIndex() {
  const rows = await readAllRows();
  const byParent = new Map();
  const byParentAwb = new Map();
  rows.forEach((row, i) => {
    const o = rowToObject(row, i + 2);
    const parent = String(o.parentOrder || '').trim().toLowerCase();
    const awb = String(o.awbNumber || '').trim().toLowerCase();
    if (!parent) return;
    if (!byParent.has(parent)) byParent.set(parent, o.rowNumber);
    if (awb) byParentAwb.set(`${parent}||${awb}`, o.rowNumber);
  });
  return { byParent, byParentAwb };
}

module.exports = { getEligibleOrders, getFreshLeads, updateOrder, batchUpdateOrders, getSheetIndex, COLUMNS };
