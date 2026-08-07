// Dependency-free CSV utilities (RFC-4180-ish) backing the Escalation desk's bulk
// export/template/import round-trip - ported unchanged from the standalone app's lib/csv.js.
// Comma or tab delimited (auto-detected on parse), quoted fields supported.
// Kept here rather than in a shared _lib helper because the header list below IS the file
// format agents already have saved spreadsheets against.

// Canonical header for the bulk template / round-trip.
const CSV_HEADERS = [
  'HYP_Parent_OrderID',
  'AWB_Number',
  'Status_1',
  'New Order ID',
  'New AWB / Tracking',
  'Status_2',
  'Notes',
];

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const commas = (firstLine.match(/,/g) || []).length;
  const tabs = (firstLine.match(/\t/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

// Parse CSV/TSV text into an array of row objects keyed by header name.
function parseCSV(text) {
  if (!text) return [];
  text = text.replace(/^﻿/, ''); // strip BOM
  const delim = detectDelimiter(text);

  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      record.push(field); field = '';
    } else if (c === '\n') {
      record.push(field); field = '';
      rows.push(record); record = [];
    } else if (c === '\r') {
      // ignore; handled by \n
    } else {
      field += c;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    rows.push(record);
  }

  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((v) => String(v).trim() !== '')) // drop blank lines
    .map((r) => {
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
      return obj;
    });
}

function escapeField(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Build CSV text from an array of objects, using the given header order.
function toCSV(rows, headers = CSV_HEADERS) {
  const head = headers.map(escapeField).join(',');
  const body = rows.map((row) => headers.map((h) => escapeField(row[h])).join(',')).join('\n');
  return body ? `${head}\n${body}` : head;
}

module.exports = { CSV_HEADERS, parseCSV, toCSV };
