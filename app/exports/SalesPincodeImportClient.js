'use client';

// Calling Team's "Exports" tab - CSV upload that overrides PEP_CLS.Delivery_escalation.
// sales_Pincode via POST /api/delivery-escalation/sales-pincode-import. Takes the raw per-
// shipment export ("45Days_Delivered_Base_File" and similar - one row per order, not
// pre-aggregated) and groups it client-side into one count per (pincode, brand, order date,
// delivery partner) before sending - sales_Pincode IS that count, same meaning
// scripts/backfill_delivery_escalation_sales_pincode.py's own docstring gives it ("how many
// distinct orders shipped to THIS pincode/brand/day/partner"), just computed from a hand-fed
// CSV instead of a live Item_level_data query.
//
// Column mapping verified against a real sample file (2026-09-04) plus PARTNER_NAME_MAP in
// ../delivery-escalation/DeliveryEscalationClient.js (the app's own list of every raw
// delivery_partner value already stored): Courier ctso's values (e.g. 'Pikndel_M_Rapid') are
// exact matches there; the file's own 'Final Couriers' column (e.g. 'Pikndel Rapid', space not
// underscore) is NOT - it's a display label, not the stored value, and would silently
// zero-match every row if used instead.
import { useState } from 'react';

const RAW_HEADERS = {
  pincode: 'delivery_pincode',
  brand: 'brand name',
  orderDate: 'order_date',
  deliveryPartner: 'courier ctso',
};

// order_date arrives as 'DD/MM/YYYY HH:MM:SS' (day-first, same convention
// api/_lib/db.js's REFUND_EXPORT_CREATED_AT_EXPR comment documents elsewhere in this app) -
// only the date part matters for grouping/matching, so time-of-day is dropped.
function toDateOnly(raw) {
  const m = String(raw || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Groups raw shipment rows into one (pincode, brand, orderDate, deliveryPartner) -> count row
// per group - sales_Pincode is that count, not a value present in the source file.
function parseCsvRows(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const requiredKeys = Object.keys(RAW_HEADERS);
  if (!lines.length) return { rows: [], missingHeaders: Object.values(RAW_HEADERS), skipped: 0 };

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = Object.fromEntries(requiredKeys.map((k) => [k, header.indexOf(RAW_HEADERS[k])]));
  const missingHeaders = requiredKeys.filter((k) => idx[k] === -1).map((k) => RAW_HEADERS[k]);
  if (missingHeaders.length) return { rows: [], missingHeaders, skipped: 0 };

  // Keyed on a joined string (not the group object itself) purely to dedupe/accumulate -
  // the group's own fields are kept as plain properties on the Map's value, not reconstructed
  // from the key, since a joined string isn't reliably splittable back into its parts.
  const groups = new Map();
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const pincode = (cells[idx.pincode] || '').trim();
    const brand = (cells[idx.brand] || '').trim();
    const orderDate = toDateOnly(cells[idx.orderDate]);
    const deliveryPartner = (cells[idx.deliveryPartner] || '').trim();
    if (!pincode || !brand || !orderDate || !deliveryPartner) { skipped++; continue; }
    const key = [pincode, brand, orderDate, deliveryPartner].join('\x01');
    const existing = groups.get(key);
    if (existing) existing.salesPincode++;
    else groups.set(key, { pincode, brand, orderDate, deliveryPartner, salesPincode: 1 });
  }

  return { rows: [...groups.values()], missingHeaders: [], skipped };
}

// Backstop, not a business rule: a file this size means it's a full raw shipment export (like
// the 45-day/1.4M-row/500MB sample this tab was built against) rather than a day or few days'
// worth - reading that much text into the browser's memory via FileReader locks up the tab
// long before it ever reaches the network. scripts/backfill_delivery_escalation_sales_pincode_
// from_file.py streams the file instead (never loads it whole) and has no such limit - it's
// the right tool for a file this big, not this tab.
const MAX_FILE_MB = 20;

export default function SalesPincodeImportClient() {
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [parseError, setParseError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');

  function readCsvFile(f) {
    if (!f) return;
    setResults(null);
    setError('');
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      setRows([]);
      setFileName(f.name);
      setParseError(
        `File is ${(f.size / (1024 * 1024)).toFixed(0)}MB - too large for this tab (max ${MAX_FILE_MB}MB). ` +
        'For a full raw shipment export, use scripts/backfill_delivery_escalation_sales_pincode_from_file.py instead.'
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const { rows: parsed, missingHeaders, skipped } = parseCsvRows(String(reader.result || ''));
      if (missingHeaders.length) {
        setRows([]);
        setParseError(`CSV is missing required column(s): ${missingHeaders.join(', ')}`);
      } else {
        setRows(parsed);
        setSkippedCount(skipped);
        setParseError(parsed.length ? '' : 'No usable rows found in CSV.');
      }
      setFileName(f.name);
    };
    reader.readAsText(f);
  }

  async function handleUpload() {
    setError('');
    setResults(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/delivery-escalation/sales-pincode-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update failed');
      setResults(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  const zeroMatchCount = results ? results.results.filter((r) => r.matched === 0).length : 0;

  return (
    <div style={{ padding: 24, maxWidth: 720, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Update Sales Pincode</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
        Upload a raw per-shipment export (e.g. a day or few days of "Delivered_Base_File") - one row per order,
        up to {MAX_FILE_MB}MB. Needs columns <code>Delivery_Pincode</code>, <code>Brand Name</code>,{' '}
        <code>order_date</code>, <code>Courier ctso</code>. Rows are grouped by pincode + brand + order date +
        courier, and each group's order count is written to every Delivery_escalation ticket matching all four.
        For a full multi-week export (bigger than {MAX_FILE_MB}MB), use{' '}
        <code>scripts/backfill_delivery_escalation_sales_pincode_from_file.py</code> instead - same matching logic,
        no size limit.
      </p>

      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => readCsvFile(e.target.files?.[0])}
      />
      {fileName && <span style={{ marginLeft: 8, fontSize: 13, color: '#666' }}>{fileName}</span>}

      {parseError && <p style={{ color: '#c0392b', marginTop: 12 }}>{parseError}</p>}
      {!parseError && rows.length > 0 && (
        <p style={{ fontSize: 13, marginTop: 12 }}>
          {rows.length} group(s) to update
          {skippedCount > 0 && ` - ${skippedCount} source row(s) skipped (missing pincode/brand/date/courier)`}.
        </p>
      )}

      <button
        onClick={handleUpload}
        disabled={!rows.length || submitting}
        style={{ marginTop: 12, padding: '8px 16px' }}
      >
        {submitting ? 'Updating…' : 'Upload & Update'}
      </button>

      {error && <p style={{ color: '#c0392b', marginTop: 12 }}>{error}</p>}

      {results && (
        <div style={{ marginTop: 20 }}>
          <p style={{ fontSize: 13 }}>
            {results.results.length} group(s) processed
            {zeroMatchCount > 0 && (
              <span style={{ color: '#c0392b' }}> - {zeroMatchCount} matched no ticket (check pincode/brand/date/courier)</span>
            )}
            {results.rejected?.length > 0 && (
              <span style={{ color: '#c0392b' }}> - {results.rejected.length} group(s) rejected before upload (invalid values)</span>
            )}
          </p>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 8 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                <th style={{ padding: 4 }}>Pincode</th>
                <th style={{ padding: 4 }}>Brand</th>
                <th style={{ padding: 4 }}>Order Date</th>
                <th style={{ padding: 4 }}>Courier</th>
                <th style={{ padding: 4 }}>Sales Pincode</th>
                <th style={{ padding: 4 }}>Matched</th>
              </tr>
            </thead>
            <tbody>
              {results.results.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f0f0f0', color: r.matched === 0 ? '#c0392b' : 'inherit' }}>
                  <td style={{ padding: 4 }}>{r.pincode}</td>
                  <td style={{ padding: 4 }}>{r.brand}</td>
                  <td style={{ padding: 4 }}>{r.orderDate}</td>
                  <td style={{ padding: 4 }}>{r.deliveryPartner}</td>
                  <td style={{ padding: 4 }}>{r.salesPincode}</td>
                  <td style={{ padding: 4 }}>{r.matched}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
