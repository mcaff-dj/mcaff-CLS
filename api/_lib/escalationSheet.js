// Escalation desk's data source - a live Google Sheet (the same one the original standalone
// app in Escalations/ read/wrote directly via the googleapis package), read here the same way
// api/ndr/sheet.js and api/rto/sheet.js already talk to THEIR sheets: a JWT service-account
// token + plain fetch against the Sheets REST API, no extra dependency needed.
//
// This is a DIFFERENT spreadsheet with a DIFFERENT dedicated service account
// (ESCALATION_SHEETS_CLIENT_EMAIL/_PRIVATE_KEY) from the one NDR/RTO's sheet proxies use - the
// standalone app's own .env.local confirmed a distinct service account (datafetchcls@...) already
// has Editor access on this sheet, and reusing the app-wide credential without confirming it also
// has access here would just trade one unverified assumption for another.
//
// SHEET_ID/TAB_NAME are constants, not env-configurable - same reasoning as NDR_SHEET_ID in
// api/ndr/sheet.js: an allowlisted, hardcoded target so a permitted-but-malicious request can't
// repurpose this service account's access against an unrelated sheet.
const { JWT } = require('google-auth-library');

const SHEET_ID = '1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w';
const TAB_NAME = 'HYPHEN';

let _client = null;
function getClient() {
  if (_client) return _client;
  const email = process.env.ESCALATION_SHEETS_CLIENT_EMAIL;
  const key = (process.env.ESCALATION_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing ESCALATION_SHEETS_CLIENT_EMAIL / ESCALATION_SHEETS_PRIVATE_KEY env vars');
  _client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return _client;
}

async function getToken() {
  const { token } = await getClient().getAccessToken();
  return token;
}

async function sheetsGet(range) {
  const token = await getToken();
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) throw new Error(`Sheets API ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  const data = await r.json();
  return data.values || [];
}

// RAW, not USER_ENTERED - matches api/ndr/sheet.js's own choice (and the reason given there):
// every value this UI writes is plain text nobody needs Sheets to auto-convert/reinterpret.
async function sheetsUpdate(range, values) {
  const token = await getToken();
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [values] }),
    }
  );
  if (!r.ok) throw new Error(`Sheets API ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
}

async function sheetsBatchUpdate(data) {
  const token = await getToken();
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
  if (!r.ok) throw new Error(`Sheets API ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
}

// Column order in the sheet (A..Z) - identical layout to the standalone app's lib/sheets.js,
// except columns X/Y (originally unused placeholders, '_v1'/'_v2') are repurposed to hold
// assignedAgent/tags directly in the sheet. That makes assignment and tags durable and
// consistent across Lambda containers - an in-memory map (what the standalone app used) resets
// unpredictably per-container under Lambda and would make assignment look broken in production.
const COLUMNS = [
  'addedDate', 'queryClass', 'queryCategory', 'parentOrder', 'awbNumber',
  'deliveryPartnerName', 'orderDate', 'orderMonth', 'queryDate', 'queryMonth',
  'whName', 'totalTimesConsumerReached', 'deliveredDate', 'statusAsPerAwb',
  'solvDate', 'tat', 'updateFromLogistics', 'city', 'state', 'newOrderId',
  'awb', 'status', 'notes', 'assignedAgent', 'tagsRaw', 'ticketNumber',
];

function rowToObject(row, rowNumber) {
  const obj = { rowNumber };
  COLUMNS.forEach((key, i) => { obj[key] = row[i] || ''; });
  obj.tags = obj.tagsRaw ? obj.tagsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  delete obj.tagsRaw;
  return obj;
}

async function getEligibleOrders() {
  const rows = await sheetsGet(`'${TAB_NAME}'!A2:Z`);
  return rows
    .map((row, i) => rowToObject(row, i + 2)) // +2: skip header, 1-indexed sheet rows
    .filter((o) => {
      const n = o.statusAsPerAwb.toLowerCase();
      const q = o.updateFromLogistics.toLowerCase();
      return n.includes('rto') && q.includes('rto') && !o.status;
    });
}

// Write New Order Id / AWB / Status / Notes into columns T/U/V/W for one row.
async function updateOrder(rowNumber, { newOrderId, newAwb, newStatus, notes = '' }) {
  await sheetsUpdate(`'${TAB_NAME}'!T${rowNumber}:W${rowNumber}`, [newOrderId, newAwb, newStatus, notes]);
}

// Write many rows in a single request (avoids per-row API round-trips / rate limits).
async function batchUpdateOrders(updates) {
  const data = updates.map((u) => ({
    range: `'${TAB_NAME}'!T${u.rowNumber}:W${u.rowNumber}`,
    values: [[u.newOrderId ?? '-', u.newAwb ?? '-', u.newStatus ?? '', u.notes ?? '']],
  }));
  await sheetsBatchUpdate(data);
  return updates.length;
}

// Lookup index for matching CSV rows back to sheet rows.
async function getSheetIndex() {
  const rows = await sheetsGet(`'${TAB_NAME}'!A2:Z`);
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

// Column X, one email per row (blank = unassigned) - read as a map keyed by row number so the
// client can merge it onto whatever getEligibleOrders() just returned.
async function getAssignments() {
  const rows = await sheetsGet(`'${TAB_NAME}'!X2:X`);
  const assignments = {};
  rows.forEach((row, i) => {
    const email = (row[0] || '').trim();
    if (email) assignments[i + 2] = { agentId: email };
  });
  return assignments;
}

async function assignOrder(rowNumber, email) {
  await sheetsUpdate(`'${TAB_NAME}'!X${rowNumber}`, [email]);
}

async function unassignOrder(rowNumber) {
  await sheetsUpdate(`'${TAB_NAME}'!X${rowNumber}`, ['']);
}

// Column Y, comma-joined tag keys - replaces the order's whole tag set (the client always sends
// the full set after each toggle, so there's no add/remove distinction to keep straight here).
async function setTags(rowNumber, tags) {
  await sheetsUpdate(`'${TAB_NAME}'!Y${rowNumber}`, [(tags || []).join(',')]);
}

// Same eligible rows the queue itself reads - the CSV export only ever uses 3 of their columns
// (see the export action's own row mapping), so no separate read path is needed at this sheet's
// modest size (unlike escalation's old Postgres-backed getEscalationOrdersForExport, which had a
// dedicated narrow query specifically because that table was orders-of-magnitude larger).
async function getOrdersForExport() {
  return getEligibleOrders();
}

module.exports = {
  getEligibleOrders, updateOrder, batchUpdateOrders, getSheetIndex,
  getAssignments, assignOrder, unassignOrder, setTags, getOrdersForExport,
};
