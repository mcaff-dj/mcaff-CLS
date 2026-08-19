// Wide-open (no session cookie, no API key) CSV export of Delivery-Escalation's Fresh tickets,
// for an external tool/script to pull on its own schedule - unlike record.js's op=export, which
// is gated by report_tab_permissions and built for a signed-in browser tab.
//
// Deliberately no auth at all, on request: this endpoint hands over order IDs, AWBs, delivery
// partner names, and agent emails to whoever has the URL, no login, no key, no rate limit -
// anyone who finds it (a leaked link, a shared script, a proxy log) can pull the whole Fresh
// queue. Add an API key or IP allowlist the moment that's a problem.
//
// Same view/columns/row shape as the "Download CSV" button on the Fresh tab (see EXPORT_COLUMNS/
// mapRow/csvCell in DeliveryEscalationClient.js) - kept in sync by hand, there being no shared
// module between a Next.js client component and this Lambda-only endpoint.
const {
  getDeliveryEscalationExport, DELIVERY_ESCALATION_MAX_EXPORT,
} = require('../_lib/db');

// Mirrors mapRow/EXPORT_COLUMNS in DeliveryEscalationClient.js exactly, so a script consuming
// this endpoint sees the same columns/order/formatting a person gets from the UI's own export.
const EXPORT_COLUMNS = [
  ['Brand', (r) => r.brand],
  ['Order ID', (r) => r.order_id],
  ['AWB', (r) => r.awb_code || ''],
  ['Ticket Number', (r) => r.ticket_number || ''],
  ['Delivery Partner', (r) => r.delivery_partner || ''],
  ['Query Class', (r) => r.query_class || ''],
  ['Query Category', (r) => r.query_category || ''],
  ['Added Date', (r) => (r.added_date ? new Date(r.added_date).toLocaleDateString('en-GB') : '')],
  ['TAT', (r) => r.tat || ''],
  ['Times Contacted', (r) => (r.contact_count == null ? '' : r.contact_count)],
  ['First Contact', (r) => (r.first_added_date ? new Date(r.first_added_date).toLocaleDateString('en-GB') : '')],
  ['Agent Name', (r) => r.agent_email || ''],
  ['Action Date', (r) => (r.disposed_at ? new Date(r.disposed_at).toLocaleDateString('en-GB') : '')],
  ['Outcome', (r) => r.outcome || ''],
  ['Child Disposition', (r) => r.child_disposition || ''],
  ['Remarks', (r) => r.agent_remarks || ''],
  ['TAT Bucket', (r) => r.tat_bucket || ''],
];

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Safety valve, not a real business cap: DELIVERY_ESCALATION_MAX_EXPORT-sized pages until one
// comes back short, same loop as the browser's own downloadCsv - this just bounds how many
// times a bug (e.g. hasMore never going false) could spin before giving up, rather than hanging
// the Lambda invocation indefinitely.
const MAX_PAGES = 200;

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const rows = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const chunk = await getDeliveryEscalationExport('fresh', { page });
      rows.push(...chunk);
      if (chunk.length < DELIVERY_ESCALATION_MAX_EXPORT) break;
    }

    const lines = [EXPORT_COLUMNS.map(([label]) => csvCell(label)).join(',')];
    for (const row of rows) lines.push(EXPORT_COLUMNS.map(([, get]) => csvCell(get(row))).join(','));
    const csv = '﻿' + lines.join('\r\n'); // BOM: Excel reads UTF-8 as ANSI without it

    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="delivery-escalation-fresh-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('api/delivery-escalation/fresh-export error:', e);
    res.status(500).json({ error: e.message || 'Could not export Fresh tickets' });
  }
};
