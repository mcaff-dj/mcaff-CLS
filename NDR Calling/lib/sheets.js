const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TAB_NAME = process.env.GOOGLE_SHEET_TAB || 'Sheet1';

function getClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Column order in the sheet (A..Z), used to read/write by name instead of raw letters.
const COLUMNS = [
  'addedDate', 'queryClass', 'queryCategory', 'parentOrder', 'awbNumber',
  'deliveryPartnerName', 'orderDate', 'orderMonth', 'queryDate', 'queryMonth',
  'whName', 'totalTimesConsumerReached', 'deliveredDate', 'statusAsPerAwb',
  'solvDate', 'tat', 'updateFromLogistics', 'city', 'state', 'newOrderId',
  'awb', 'status', 'notes', '_v1', '_v2', 'ticketNumber',
];

function rowToObject(row, rowNumber) {
  const obj = { rowNumber };
  COLUMNS.forEach((key, i) => {
    obj[key] = row[i] || '';
  });
  return obj;
}

async function getEligibleOrders() {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A2:Z`,
  });
  const rows = res.data.values || [];
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
  const sheets = getClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!T${rowNumber}:W${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[newOrderId, newAwb, newStatus, notes]] },
  });
}

// Write many rows in a single request (avoids per-row API round-trips / rate limits).
// updates: [{ rowNumber, newOrderId, newAwb, newStatus, notes }]
async function batchUpdateOrders(updates) {
  const sheets = getClient();
  const data = updates.map((u) => ({
    range: `${TAB_NAME}!T${u.rowNumber}:W${u.rowNumber}`,
    values: [[u.newOrderId ?? '-', u.newAwb ?? '-', u.newStatus ?? '', u.notes ?? '']],
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  return updates.length;
}

// Lookup index for matching CSV rows back to sheet rows.
// Returns maps keyed by parent order and by "parentOrder||awb" (both trimmed/lowercased).
async function getSheetIndex() {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A2:Z`,
  });
  const rows = res.data.values || [];
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

module.exports = { getEligibleOrders, updateOrder, batchUpdateOrders, getSheetIndex, COLUMNS };
