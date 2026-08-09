// The Escalation desk's data layer, on BigQuery. Replaces api/_lib/escalationSheet.js and the
// escalation_* functions in api/_lib/db.js.
//
// READS AND WRITES ONLY. Ingest is Python (scripts/sync_delivery_tickets_to_bq.py and
// scripts/sync_escalation_sheet_to_bq.py) and the tables are created by
// scripts/escalation_bq_schema.py. Nothing here issues DDL or loads data, so the two languages
// cannot drift on table definitions.
//
// APP-OWNED COLUMNS ONLY on the write side. The ticket loader owns the ticket columns and the
// sheet sweep owns the formula/logistics columns; naming either from here would silently destroy
// another writer's data on its next run.
//
// KEYED ON (brand, parent_order, awb_key), NOT row_number. The old sheet write path targeted
// `{tab}!T{rowNumber}:W{rowNumber}`, correct only while nobody sorted the sheet.
const bq = require('./bigquery');

const ORDERS = 'orders';
const EVENTS = 'assignment_events';

// BigQuery column -> the camelCase key the client renders. `brand` deliberately surfaces as
// `sheetTab`: app/escalation/EscalationClient.js builds every row key from it, and renaming the
// column in BigQuery is not a reason to churn the client.
const COLUMN_TO_ORDER_KEY = {
  brand: 'sheetTab', row_number: 'rowNumber', parent_order: 'parentOrder',
  awb_number: 'awbNumber', added_date: 'addedDate', query_class: 'queryClass',
  query_category: 'queryCategory', delivery_partner_name: 'deliveryPartnerName',
  order_date: 'orderDate', order_month: 'orderMonth', query_date: 'queryDate',
  query_month: 'queryMonth', wh_name: 'whName',
  total_times_consumer_reached: 'totalTimesConsumerReached',
  delivered_date: 'deliveredDate', status_as_per_awb: 'statusAsPerAwb',
  solv_date: 'solvDate', tat: 'tat', update_from_logistics: 'updateFromLogistics',
  city: 'city', state: 'state', ticket_number: 'ticketNumber',
  new_order_id: 'newOrderId', new_awb: 'awb', status: 'status', notes: 'notes',
};

const ORDER_SELECT_COLUMNS = Object.keys(COLUMN_TO_ORDER_KEY);

function bqRowToOrder(r) {
  const out = {};
  Object.entries(COLUMN_TO_ORDER_KEY).forEach(([column, key]) => {
    out[key] = r[column] == null ? '' : r[column];
  });
  out.rowNumber = r.row_number == null ? null : Number(r.row_number);
  return out;
}

function awbKeyOf(awbNumber) {
  return String(awbNumber == null ? '' : awbNumber).trim().toLowerCase();
}

// The queue: RTO per BOTH the courier (status_as_per_awb) and logistics
// (update_from_logistics), and not yet actioned. Deliberately NOT filtered on tat - every
// currently-pending RTO row carries "Forced to be marked as RTO" there, so gating on the
// open-TAT values empties the queue. That rule belongs to fresh leads below, which has no RTO
// requirement at all.
const QUEUE_WHERE = `LOWER(status_as_per_awb) LIKE '%rto%'
    AND LOWER(update_from_logistics) LIKE '%rto%'
    AND COALESCE(status, '') = ''
    AND deleted_from_sheet_at IS NULL`;

// Fresh leads: tat hasn't landed in a computed bucket yet. Irrespective of status or the RTO
// columns - an already-actioned row still counts if its tat is still open.
const FRESH_LEADS_WHERE = `LOWER(TRIM(COALESCE(tat, ''))) IN ('', 'unresolved', '#n/a')
    AND deleted_from_sheet_at IS NULL`;

function buildQueueQuery(view) {
  return `SELECT ${ORDER_SELECT_COLUMNS.join(', ')}
  FROM \`${ORDERS}\`
  WHERE ${view === 'freshLeads' ? FRESH_LEADS_WHERE : QUEUE_WHERE}`;
}

async function getEligibleOrders() {
  const { rows } = await bq.query(buildQueueQuery('queue'));
  return rows.map(bqRowToOrder);
}

async function getFreshLeads() {
  const { rows } = await bq.query(buildQueueQuery('freshLeads'));
  return rows.map(bqRowToOrder);
}

// Cheap: reads the orders table's own assignment columns rather than scanning the event log.
async function getLiveEscalationAssignments() {
  const { rows } = await bq.query(`SELECT parent_order, assigned_to
  FROM \`${ORDERS}\`
  WHERE assigned_to IS NOT NULL AND resolved_at IS NULL`);
  return rows.map((r) => ({ parentOrder: r.parent_order, email: r.assigned_to }));
}

// Rebuilds the Postgres table's cycle shape from the event log: one row per assignment cycle,
// carrying the timestamps of the events that closed it. No date filtering on purpose - "assigned
// this week" and "resolved this week" are different questions about different timestamps, and a
// single WHERE would miscount whichever metric doesn't share it. AssignmentsPanel scopes each
// metric client-side. LIMIT is the same soft ceiling the Postgres version carried.
async function getEscalationAssignments() {
  const { rows } = await bq.query(`WITH cycles AS (
    SELECT parent_order, email, ts AS assigned_at,
           LEAD(ts) OVER (PARTITION BY parent_order ORDER BY ts) AS next_ts
    FROM \`${EVENTS}\`
    WHERE event = 'assigned'
  ),
  closes AS (
    SELECT c.parent_order, c.email, c.assigned_at,
      MIN(IF(e.event IN ('reassigned_away', 'unassigned'), e.ts, NULL)) AS reassigned_away_at,
      MIN(IF(e.event = 'resolved', e.ts, NULL)) AS resolved_at,
      ANY_VALUE(IF(e.event = 'resolved', e.resolution, NULL)) AS resolution,
      ANY_VALUE(IF(e.event = 'resolved', e.agent_remarks, NULL)) AS agent_remarks
    FROM cycles c
    LEFT JOIN \`${EVENTS}\` e
      ON e.parent_order = c.parent_order
     AND e.ts > c.assigned_at
     AND (c.next_ts IS NULL OR e.ts < c.next_ts)
    GROUP BY c.parent_order, c.email, c.assigned_at
  )
  SELECT * FROM closes ORDER BY assigned_at DESC LIMIT 5000`);
  return rows.map((r) => ({
    parentOrder: r.parent_order,
    email: r.email,
    assignedAt: r.assigned_at,
    reassignedAwayAt: r.reassigned_away_at,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
    agentRemarks: r.agent_remarks,
  }));
}

// Replaces escalationSheet.getSheetIndex - same two maps and the same "prefer an exact
// parent+AWB match, fall back to parent only" contract the CSV import depends on, but read from
// BigQuery instead of re-reading both sheet tabs. Values carry the write key, not a row number.
async function getOrderIndex() {
  const { rows } = await bq.query(
    `SELECT brand, parent_order, awb_number, awb_key
     FROM \`${ORDERS}\` WHERE deleted_from_sheet_at IS NULL`
  );
  const byParent = new Map();
  const byParentAwb = new Map();
  rows.forEach((r) => {
    const parent = String(r.parent_order || '').trim().toLowerCase();
    if (!parent) return;
    const key = { sheetTab: r.brand, parentOrder: r.parent_order, awbNumber: r.awb_number || '' };
    if (!byParent.has(parent)) byParent.set(parent, key);
    if (r.awb_key) byParentAwb.set(`${parent}||${r.awb_key}`, key);
  });
  return { byParent, byParentAwb };
}

function keyParams({ sheetTab, parentOrder, awbNumber }) {
  return [
    bq.strParam('brand', sheetTab),
    bq.strParam('parent_order', parentOrder),
    bq.strParam('awb_key', awbKeyOf(awbNumber)),
  ];
}

const KEY_WHERE = 'brand = @brand AND parent_order = @parent_order AND awb_key = @awb_key';

// One row per agent action. Append-only: this is the history AssignmentsPanel reads, and the
// reason a current-state-only orders table isn't enough on its own.
async function insertEvent(key, event, { email = null, resolution = null, agentRemarks = null } = {}) {
  await bq.query(
    `INSERT INTO \`${EVENTS}\` (parent_order, brand, awb_key, email, event, resolution, agent_remarks, ts)
     VALUES (@parent_order, @brand, @awb_key, @email, @event, @resolution, @agent_remarks, CURRENT_TIMESTAMP())`,
    [
      ...keyParams(key),
      bq.strParam('email', email),
      bq.strParam('event', event),
      bq.strParam('resolution', resolution),
      bq.strParam('agent_remarks', agentRemarks),
    ],
    { useQueryCache: false }
  );
}

const KEY_FIELDS = ['brand', 'parent_order', 'awb_key'];
const BULK_UPDATE_FIELDS = [...KEY_FIELDS, 'new_order_id', 'new_awb', 'status', 'notes', 'resolved_by'];
const BULK_ASSIGN_FIELDS = [...KEY_FIELDS, 'assigned_to'];

const BULK_KEY_JOIN = 'ON  T.brand = S.brand AND T.parent_order = S.parent_order AND T.awb_key = S.awb_key';

function buildBulkUpdateMerge() {
  return `MERGE \`${ORDERS}\` T
USING UNNEST(@items) S
${BULK_KEY_JOIN}
WHEN MATCHED THEN UPDATE SET
  new_order_id = S.new_order_id,
  new_awb = S.new_awb,
  status = S.status,
  notes = S.notes,
  resolved_at = CURRENT_TIMESTAMP(),
  resolved_by = S.resolved_by`;
}

function buildBulkAssignMerge() {
  return `MERGE \`${ORDERS}\` T
USING UNNEST(@items) S
${BULK_KEY_JOIN}
WHEN MATCHED THEN UPDATE SET
  assigned_to = S.assigned_to,
  assigned_at = CURRENT_TIMESTAMP()`;
}

function bulkKeyOf(i) {
  return { brand: i.sheetTab, parent_order: i.parentOrder, awb_key: awbKeyOf(i.awbNumber) };
}

async function updateOrder(key, { newOrderId, newAwb, newStatus, notes = '', resolvedBy = null }) {
  const { affectedRows } = await bq.query(
    `UPDATE \`${ORDERS}\` SET
       new_order_id = @new_order_id,
       new_awb = @new_awb,
       status = @status,
       notes = @notes,
       resolved_at = CURRENT_TIMESTAMP(),
       resolved_by = @resolved_by
     WHERE ${KEY_WHERE}`,
    [
      ...keyParams(key),
      bq.strParam('new_order_id', newOrderId == null ? '-' : newOrderId),
      bq.strParam('new_awb', newAwb == null ? '-' : newAwb),
      bq.strParam('status', newStatus),
      bq.strParam('notes', notes),
      bq.strParam('resolved_by', resolvedBy),
    ],
    { useQueryCache: false }
  );
  await insertEvent(key, 'resolved', { email: resolvedBy, resolution: newStatus, agentRemarks: notes });
  return affectedRows;
}

// One MERGE, never a loop: bulk-update and CSV import can carry thousands of rows, and thousands
// of individual UPDATE statements would exhaust BigQuery's DML queue.
async function batchUpdateOrders(items) {
  if (!items.length) return 0;
  const rows = items.map((i) => ({
    ...bulkKeyOf(i),
    new_order_id: i.newOrderId == null ? '-' : i.newOrderId,
    new_awb: i.newAwb == null ? '-' : i.newAwb,
    status: i.newStatus,
    notes: i.notes == null ? '' : i.notes,
    resolved_by: i.resolvedBy == null ? '' : i.resolvedBy,
  }));
  const { affectedRows } = await bq.query(
    buildBulkUpdateMerge(),
    [bq.structArrayParam('items', BULK_UPDATE_FIELDS, rows)],
    { useQueryCache: false }
  );
  await bq.query(
    `INSERT INTO \`${EVENTS}\` (parent_order, brand, awb_key, email, event, resolution, agent_remarks, ts)
     SELECT parent_order, brand, awb_key, resolved_by, 'resolved', status, notes, CURRENT_TIMESTAMP()
     FROM UNNEST(@items)`,
    [bq.structArrayParam('items', BULK_UPDATE_FIELDS, rows)],
    { useQueryCache: false }
  );
  return affectedRows;
}

async function currentAssignee(key) {
  const { rows } = await bq.query(
    `SELECT assigned_to FROM \`${ORDERS}\` WHERE ${KEY_WHERE} AND resolved_at IS NULL`,
    keyParams(key),
    { useQueryCache: false }
  );
  return rows.length ? rows[0].assigned_to : null;
}

// Mirrors the Postgres cycle model: a different agent's live assignment is closed with a
// reassigned_away event before the new one opens, so history is preserved rather than
// overwritten. Re-assigning to the SAME agent closes nothing.
async function assignEscalationOrder(key, email) {
  const previous = await currentAssignee(key);
  if (previous && previous !== email) await insertEvent(key, 'reassigned_away', { email: previous });
  await bq.query(
    `UPDATE \`${ORDERS}\` SET assigned_to = @assigned_to, assigned_at = CURRENT_TIMESTAMP()
     WHERE ${KEY_WHERE}`,
    [...keyParams(key), bq.strParam('assigned_to', email)],
    { useQueryCache: false }
  );
  await insertEvent(key, 'assigned', { email });
}

async function unassignEscalationOrder(key) {
  const previous = await currentAssignee(key);
  await bq.query(
    `UPDATE \`${ORDERS}\` SET assigned_to = NULL, assigned_at = NULL
     WHERE ${KEY_WHERE} AND resolved_at IS NULL`,
    keyParams(key),
    { useQueryCache: false }
  );
  await insertEvent(key, 'unassigned', { email: previous });
}

// Auto-Assign All's write path. The client used to fire one request per unassigned order; against
// BigQuery that is thousands of concurrent DML statements and a guaranteed failure.
async function assignEscalationOrdersBulk(items) {
  if (!items.length) return 0;
  const rows = items.map((i) => ({ ...bulkKeyOf(i), assigned_to: i.agentId }));
  const { affectedRows } = await bq.query(
    buildBulkAssignMerge(),
    [bq.structArrayParam('items', BULK_ASSIGN_FIELDS, rows)],
    { useQueryCache: false }
  );
  await bq.query(
    `INSERT INTO \`${EVENTS}\` (parent_order, brand, awb_key, email, event, resolution, agent_remarks, ts)
     SELECT parent_order, brand, awb_key, assigned_to, 'assigned', NULL, NULL, CURRENT_TIMESTAMP()
     FROM UNNEST(@items)`,
    [bq.structArrayParam('items', BULK_ASSIGN_FIELDS, rows)],
    { useQueryCache: false }
  );
  return affectedRows;
}

module.exports = {
  ORDERS, EVENTS, awbKeyOf, buildQueueQuery,
  getEligibleOrders, getFreshLeads,
  getLiveEscalationAssignments, getEscalationAssignments, getOrderIndex,
  updateOrder, batchUpdateOrders, assignEscalationOrder, unassignEscalationOrder,
  assignEscalationOrdersBulk, buildBulkUpdateMerge, buildBulkAssignMerge,
};
