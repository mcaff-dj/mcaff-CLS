// Reads for the Escalation desk, replacing api/_lib/escalationSheet.js's getEligibleOrders/
// getFreshLeads - see docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md.
//
// Column ownership by TABLE, not by MERGE clause: orders_ticket_columns and orders_sheet_columns
// are each written by exactly one rebuild script (scripts/sync_delivery_tickets_to_bq.py,
// scripts/sync_escalation_sheet_to_bq.py respectively) and this file only ever SELECTs from
// both - never writes to BigQuery at all (see api/_lib/bigquery.js's own docstring).
const { runQuery } = require('./bigquery');
const { getEscalationAssignments } = require('./db');

const PROJECT = process.env.BQ_PROJECT_ID || 'sheetdata-501810';
const DATASET = process.env.BQ_DATASET || 'escalation';

// One row of orders_ticket_columns JOINed with its orders_sheet_columns counterpart, merged with
// its Postgres resolution row (or null if never assigned/resolved) into the exact shape
// api/_lib/escalationSheet.js's rowToObject used to produce - same field names, so
// app/escalation/EscalationClient.js and api/escalation/[action].js need no read-side changes
// beyond which module they import.
function mergeOrderRow(bqRow, resolutionRow) {
  return {
    rowNumber: bqRow.rowNumber,
    sheetTab: bqRow.brand,          // 'HYPHEN' | 'mCaffeine' - same literal values as today's sheetTab
    addedDate: bqRow.addedDate || '',
    queryClass: bqRow.queryClass || '',
    queryCategory: bqRow.queryCategory || '',
    parentOrder: bqRow.parentOrder || '',
    awbNumber: bqRow.awbNumber || '',
    deliveryPartnerName: bqRow.deliveryPartnerName || '',
    orderDate: bqRow.orderDate || '',
    orderMonth: bqRow.orderMonth || '',
    queryDate: bqRow.queryDate || '',
    queryMonth: bqRow.queryMonth || '',
    whName: bqRow.whName || '',
    totalTimesConsumerReached: bqRow.totalTimesConsumerReached ?? '',
    deliveredDate: bqRow.deliveredDate || '',
    statusAsPerAwb: bqRow.statusAsPerAwb || '',
    solvDate: bqRow.solvDate || '',
    tat: bqRow.tat || '',
    updateFromLogistics: bqRow.updateFromLogistics || '',
    city: bqRow.city || '',
    state: bqRow.state || '',
    ticketNumber: bqRow.ticketNumber || '',
    // Resolution fields - blank when there is no Postgres row yet, same as an unwritten sheet cell.
    newOrderId: resolutionRow?.newOrderId || '',
    awb: resolutionRow?.newAwb || '',
    status: resolutionRow?.resolution || '',
    notes: resolutionRow?.agentRemarks || '',
  };
}

// Joins orders_ticket_columns + orders_sheet_columns on (brand, parent_order) and a normalized
// AWB match, same key definition as the sheet sweep's dedup (LOWER(TRIM(...))). LEFT JOIN sheet
// columns - a ticket row that hasn't been swept yet (sweep runs on its own 2h schedule,
// independently of the ticket loader) still shows up, just without status_as_per_awb/
// update_from_logistics yet, which means it won't pass the RTO predicate until the next sweep -
// that's correct: an order isn't "in the RTO queue" from BigQuery's perspective until the
// sheet-sourced columns that DEFINE the queue have landed.
async function queryOrders(predicateSql) {
  const sql = `
    SELECT t.brand, t.parent_order AS parentOrder, t.awb_number AS awbNumber,
           t.added_date AS addedDate, t.query_class AS queryClass, t.query_category AS queryCategory,
           t.delivery_partner_name AS deliveryPartnerName, t.order_date AS orderDate,
           t.order_month AS orderMonth, t.query_date AS queryDate, t.query_month AS queryMonth,
           t.wh_name AS whName, t.ticket_number AS ticketNumber,
           t.total_times_user_reached AS totalTimesConsumerReached,
           s.row_number AS rowNumber, s.delivered_date AS deliveredDate,
           s.status_as_per_awb AS statusAsPerAwb, s.solv_date AS solvDate, s.tat AS tat,
           s.update_from_logistics AS updateFromLogistics, s.city AS city, s.state AS state
    FROM \`${PROJECT}.${DATASET}.Delivery_escalation\` t
    LEFT JOIN \`${PROJECT}.${DATASET}.orders_sheet_columns\` s
      ON t.brand = s.brand AND t.parent_order = s.parent_order
      AND LOWER(TRIM(COALESCE(t.awb_number, ''))) = s.awb_key
    WHERE s.deleted_from_sheet_at IS NULL AND (${predicateSql})
  `;
  const bqRows = await runQuery(PROJECT, sql);

  const resolutions = await getEscalationAssignments();
  const byParentOrder = new Map();
  resolutions.forEach((r) => { if (!byParentOrder.has(r.parentOrder)) byParentOrder.set(r.parentOrder, r); });

  return bqRows
    .map((row) => mergeOrderRow(row, byParentOrder.get(row.parentOrder) || null))
    .filter((row) => !row.status); // drop already-resolved orders, same rule the old getEligibleOrders used
}

// Same predicate as api/_lib/escalationSheet.js's getEligibleOrders: courier RTO (N) AND
// logistics RTO (Q). NOT filtered on tat (P) - see that file's own comment for why.
async function getEligibleOrders() {
  return queryOrders(`LOWER(s.status_as_per_awb) LIKE '%rto%' AND LOWER(s.update_from_logistics) LIKE '%rto%'`);
}

// Same predicate as getFreshLeads: TAT hasn't landed in a computed bucket yet.
async function getFreshLeads() {
  return queryOrders(`LOWER(TRIM(COALESCE(s.tat, ''))) IN ('', 'unresolved', '#n/a')`);
}

module.exports = { getEligibleOrders, getFreshLeads, mergeOrderRow };
