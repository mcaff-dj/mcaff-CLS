// Offline self-check for the Delivery-Escalation WHERE-builder in db.js - pure/offline, never
// opens a connection. Run with `node api/_lib/db.deliveryEscalation.test.js`.
//
// The regression it guards: a non-admin used to be pinned to `agent_email = <their email>`, which
// hid every unclaimed ticket from the very people meant to claim them (a newly-invited agent saw
// an empty page). Access is checkAccess()/report_tab_permissions only - no row-level scope.
const assert = require('assert');
const {
  deWhere, DE_DAYWISE_BUCKET_SQL, DE_DAYWISE_BUCKETS,
  UNRESOLVED_AGE_BUCKET_SQL, UNRESOLVED_AGE_BUCKETS,
  DE_DAY_BUCKET_COLUMN, DE_CONTACT_BUCKET_COLUMN, buildDeliveryEscalationDaywiseResult,
  bulkDisposeDeliveryEscalationByAwb,
} = require('./db');

// 1. No filters: the view predicate alone, no agent/scope clause bolted on.
{
  const { where, params } = deWhere('fresh', {});
  assert.ok(where.includes('outcome'), 'fresh view must filter on outcome');
  assert.ok(!where.includes('agent_email'), 'no forced per-agent scope may survive');
  assert.deepStrictEqual(params, []);
  // Admin-added disposition roots (Admin Panel's Disposition List) that sit sibling to
  // 'Escalated' rather than nested under it - found invisible in every tab (scripts/
  // investigate_de_orphan_outcomes.py: 2194 rows) because Fresh's outcome match never
  // recognized them as still-open. Regression guard: each must count as Fresh.
  for (const root of ['In Transit', 'NDR', 'Processing', 'Lost Damaged', 'Invalid']) {
    assert.ok(where.includes(`outcome = '${root}'`),
      `'${root}' must be recognized as a still-open outcome in the Fresh view`);
  }
}

// 2. Unclaimed rows (agent_email NULL or '') must satisfy Fresh - nothing in the SQL excludes
//    them, which is the whole point of the fix.
{
  const { where } = deWhere('fresh', { brand: 'HYPHEN' });
  assert.ok(!/agent_email\s*(=|IS)/.test(where), 'unclaimed tickets must stay visible');
  assert.deepStrictEqual(deWhere('fresh', { brand: 'HYPHEN' }).params, ['HYPHEN']);
}

// 3. The Agent filter is a user's own choice of view, bound and lowercased (agent_email is
//    stored as the session email, whose case we don't control).
{
  const { where, params } = deWhere('resolved', { agent: 'Shahid@Mcaffeine.com' });
  assert.ok(where.includes('LOWER(agent_email) = ?'));
  assert.deepStrictEqual(params, ['shahid@mcaffeine.com']);
}

// 4. Search escapes LIKE wildcards and binds three columns; filters combine, params ordered
//    brand -> agent -> search.
{
  const { where, params } = deWhere('forced_rto', { brand: 'mCaffeine', agent: 'a@b.com', search: '50%_x' });
  assert.ok(where.includes("tat = 'Forced to be marked as RTO'"));
  const esc = String.raw`%50\%\_x%`; // literal % and _ escaped so they search as themselves
  assert.deepStrictEqual(params, ['mCaffeine', 'a@b.com', esc, esc, esc]);
}

// 5. An unknown view is rejected rather than silently matching everything.
assert.throws(() => deWhere('everything', {}), /Unknown Delivery-Escalation view/);

// 6. Overview's day-wise bucket. Guards the SQL text itself since there's no DB here to run the
// CASE against.
//
// This case previously asserted the ORIGINAL rule - that a still-open ticket buckets by age as of
// today, via COALESCE(disposed_at, CURDATE()). That rule was deliberately replaced in 4485e70
// (the order-date / query-date toggle), which rewrote both the SQL and its explaining comment:
// 'unresolved' is now EXACTLY the Fresh tab's own population, so a ticket sitting in Fresh sits
// in 'unresolved' here too, whole and un-split, instead of being sliced across the age buckets by
// how long it has been open - that's what makes this table's 'unresolved' line up with the Fresh
// tile. Everything reaching the DATEDIFF buckets is therefore Delivered and has a real
// disposed_at, so those buckets measure actual resolution time. The assertions below were never
// updated to the new contract and failed for two days unnoticed, because nothing in this repo ran
// the tests until `npm test` was wired up.
{
  const idxForced = DE_DAYWISE_BUCKET_SQL.indexOf("THEN 'Forced to be marked as RTO'");
  const idxUnresolved = DE_DAYWISE_BUCKET_SQL.indexOf("THEN 'unresolved'");
  const idxDatediff = DE_DAYWISE_BUCKET_SQL.indexOf('DATEDIFF(');
  assert.ok(idxForced > -1, 'Forced RTO must have its own bucket');
  assert.ok(idxUnresolved > -1, "the Fresh population must bucket as 'unresolved'");

  // Branch ORDER is load-bearing, not cosmetic: the Forced-RTO and Fresh predicates overlap
  // (both admit outcome = 'RTO'), so a Forced-RTO ticket only lands in its own bucket while that
  // branch is evaluated first. Swap these two and every Forced RTO silently becomes 'unresolved'.
  assert.ok(idxForced < idxUnresolved, 'Forced RTO must be tested before the Fresh/unresolved branch');
  assert.ok(idxUnresolved < idxDatediff, 'unresolved must be tested before the age buckets');

  // The age buckets measure real resolution time - disposed_at minus added_date - because every
  // row that reaches them is Delivered. A COALESCE to CURDATE() here would re-introduce
  // "age as of today" for rows the unresolved branch above has already claimed.
  assert.ok(/DATEDIFF\(disposed_at, added_date\)/.test(DE_DAYWISE_BUCKET_SQL),
    'age buckets must measure disposed_at - added_date, not age as of today');
  assert.ok(!DE_DAYWISE_BUCKET_SQL.includes('CURDATE()'),
    'no CURDATE() fallback: every row reaching the age buckets is Delivered with a real disposed_at');

  // Defensive catch-all for a Delivered row somehow missing either date: it can't be dated, so it
  // can't be aged, and it must not silently fall through to 'Greater than 10 days'.
  assert.ok(/disposed_at IS NULL OR added_date IS NULL THEN 'unresolved'/.test(DE_DAYWISE_BUCKET_SQL),
    'a Delivered row missing either date must fall back to unresolved, not into an age bucket');

  // Ascending-severity DISPLAY order, deliberately not alphabetical (see the array's own comment
  // in db.js) - the order is the table's column order, so it is part of the contract, not an
  // implementation detail. This previously pinned the old alphabetical order and was not updated
  // when ee10e50 reordered the buckets.
  assert.deepStrictEqual(DE_DAYWISE_BUCKETS, [
    'Within 48 hrs', 'Within 2-4 days', '4-8 days', '8-10 days', 'Greater than 10 days',
    'Forced to be marked as RTO', 'Resolved Refunded', 'unresolved',
  ]);
  // Every bucket the CASE can emit must appear in the display list, or a date whose only tickets
  // land in the missing bucket renders a row of zeros with the count silently dropped.
  for (const label of ['Within 48 hrs', 'Within 2-4 days', '4-8 days', '8-10 days',
    'Greater than 10 days', 'Forced to be marked as RTO', 'Resolved Refunded', 'unresolved']) {
    assert.ok(DE_DAYWISE_BUCKET_SQL.includes(`'${label}'`),
      `bucket ${label} is listed for display but never emitted by the CASE`);
  }
}

// 6b. Unresolved Leads Funnel's age split (UNRESOLVED_AGE_BUCKET_SQL) - unlike DE_DAYWISE_BUCKET_SQL
// above, every row this CASE runs against is genuinely still open, so it must measure age AS OF
// TODAY off added_date, never disposed_at (an open ticket has none) or a fixed cutoff date.
{
  assert.ok(/DATEDIFF\(CURDATE\(\), added_date\)/.test(UNRESOLVED_AGE_BUCKET_SQL),
    'unresolved age must be measured as of today against added_date');
  assert.ok(!UNRESOLVED_AGE_BUCKET_SQL.includes('disposed_at'),
    'a still-open ticket has no disposed_at to measure against');
  // 5 buckets, ascending severity, matching the display list exactly (same "CASE output must be a
  // subset of the display array" contract DE_DAYWISE_BUCKETS' own test guards above). The 96hrs
  // bucket is carved out of the 4-8/>8 day ranges - only unresolved tickets that ALSO have no
  // new_order_AWB AND whose outcome isn't 'Escalated > New order placed' (a disposition-flagged
  // new order counts as placed even if new_order_AWB itself is still blank) land there instead.
  assert.deepStrictEqual(UNRESOLVED_AGE_BUCKETS, [
    'open Within 48 hrs', 'open Within 2-4 days', 'open within 4-8 days', 'open Greater than 8days',
    'open Greater than 96hrs, new order not placed',
  ]);
  assert.ok(UNRESOLVED_AGE_BUCKET_SQL.includes("outcome = 'Escalated > New order placed'"),
    'a New order placed disposition must count as a new order placed, regardless of new_order_AWB');
  // outcome IS NULL for every never-disposed (plain Fresh) ticket - `NULL = 'Escalated > New
  // order placed'` is NULL, not FALSE, and NOT(NULL) is ALSO NULL, which a CASE WHEN treats as
  // no-match. Without this guard (same trap DE_FORCED_RTO_WHERE's own comment documents), EVERY
  // blank-outcome ticket - the bulk of a genuinely aged, untouched queue - silently fell out of
  // this bucket into the day-range buckets below instead.
  assert.ok(UNRESOLVED_AGE_BUCKET_SQL.includes("NOT (outcome IS NOT NULL AND"),
    'the New-order-placed exclusion must guard against outcome IS NULL, or every blank-outcome ticket silently drops out of this bucket');
  for (const label of UNRESOLVED_AGE_BUCKETS) {
    assert.ok(UNRESOLVED_AGE_BUCKET_SQL.includes(`'${label}'`),
      `bucket ${label} is listed for display but never emitted by the CASE`);
  }
}

// 6c. ageBucket filter (the Unresolved Leads Funnel's own drill, see deFilterSql/record.js) -
// bound as a value against UNRESOLVED_AGE_BUCKET_SQL, same shape tatBucket already uses.
{
  const { where, params } = deWhere('fresh', { ageBucket: 'open Within 48 hrs' });
  assert.ok(where.includes(UNRESOLVED_AGE_BUCKET_SQL), 'ageBucket must filter on UNRESOLVED_AGE_BUCKET_SQL');
  assert.ok(params.includes('open Within 48 hrs'), 'ageBucket value must be bound, not interpolated');
}

// 6d. buildDeliveryEscalationDaywiseResult (the pure half of fetchDeliveryEscalationDaywiseStats,
// split out so this runs with no database - see its own comment in db.js) - the column names
// must match scripts/alter_delivery_escalation_add_bucket_columns.py's DDL (hand-kept in sync,
// there's no import across JS/Python), and folding the two queries (main breakdown + age split,
// scoped to 'unresolved' rows only) back together must reproduce the same shape the single query
// used to return before the split.
{
  assert.strictEqual(DE_DAY_BUCKET_COLUMN, 'de_day_bucket');
  assert.strictEqual(DE_CONTACT_BUCKET_COLUMN, 'de_contact_bucket');

  const rows = [
    { d: '2026-09-01', partner: 'Delhivery', category: 'Damaged', contactBucket: '1 time', bucket: 'unresolved', c: 3 },
    { d: '2026-09-01', partner: 'Delhivery', category: 'Damaged', contactBucket: '1 time', bucket: 'Within 48 hrs', c: 5 },
    { d: '2026-09-02', partner: 'Ecom', category: 'Lost', contactBucket: '2-4 times', bucket: 'Forced to be marked as RTO', c: 2 },
  ];
  const ageRows = [
    { d: '2026-09-01', ageBucket: 'open Within 48 hrs', c: 3 },
  ];
  const result = buildDeliveryEscalationDaywiseResult(rows, ageRows, 1);

  // Totals: the 10 counted rows (3+5+2) plus the 1 no-date row, the latter landing under
  // 'unresolved' the same way the single-query version's `grandTotal.unresolved +=
  // missingDateCount` did.
  assert.strictEqual(result.grandTotalAll, 11);
  assert.strictEqual(result.grandTotal.unresolved, 4);
  assert.strictEqual(result.grandTotal['Within 48 hrs'], 5);
  assert.strictEqual(result.grandTotal['Forced to be marked as RTO'], 2);
  assert.strictEqual(result.missingDateCount, 1);

  // Age split lands on the SAME date entry the main loop already seeded from `rows` - this is
  // the join point that only works because every ageRows date is guaranteed to already exist in
  // byDate (an 'unresolved' row for that date was necessarily counted in `rows` too).
  const sep1 = result.rows.find((r) => r.date === '2026-09-01');
  assert.ok(sep1, 'age query must land on a date the main query already produced');
  assert.strictEqual(sep1.ageTotal, 3);
  assert.strictEqual(sep1.ageCounts['open Within 48 hrs'], 3);
  assert.strictEqual(sep1.total, 8, 'ageBucket must not be a GROUP BY dimension in the main query - both bucket rows for 09-01 (3+5) fold into one date entry');

  // A date with no 'unresolved' rows at all must show a real zero, not a missing key.
  const sep2 = result.rows.find((r) => r.date === '2026-09-02');
  assert.strictEqual(sep2.ageTotal, 0);
  assert.deepStrictEqual(sep2.ageCounts, Object.fromEntries(UNRESOLVED_AGE_BUCKETS.map((b) => [b, 0])));
}

// 7. Bulk upload's view guard runs BEFORE any query - a bulk upload must be scoped to Fresh or
// Forced RTO (the only two tabs that offer it), never 'resolved' or a typo view, and rejecting
// it up front is what stops that mistake from silently matching the wrong tab's rows (or none).
(async () => {
  await assert.rejects(
    () => bulkDisposeDeliveryEscalationByAwb([{ awb: 'x', outcome: 'y' }], 'a@b.com', 'resolved'),
    /Unknown Delivery-Escalation bulk-upload view/,
  );
  await assert.rejects(
    () => bulkDisposeDeliveryEscalationByAwb([{ awb: 'x', outcome: 'y' }], 'a@b.com', undefined),
    /Unknown Delivery-Escalation bulk-upload view/,
  );

  console.log('db.deliveryEscalation.test.js: all assertions passed');
})();
