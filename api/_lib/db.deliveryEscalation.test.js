// Offline self-check for the Delivery-Escalation WHERE-builder in db.js - pure/offline, never
// opens a connection. Run with `node api/_lib/db.deliveryEscalation.test.js`.
//
// The regression it guards: a non-admin used to be pinned to `agent_email = <their email>`, which
// hid every unclaimed ticket from the very people meant to claim them (a newly-invited agent saw
// an empty page). Access is checkAccess()/report_tab_permissions only - no row-level scope.
const assert = require('assert');
const { deWhere, DE_DAYWISE_BUCKET_SQL, DE_DAYWISE_BUCKETS, bulkDisposeDeliveryEscalationByAwb } = require('./db');

// 1. No filters: the view predicate alone, no agent/scope clause bolted on.
{
  const { where, params } = deWhere('fresh', {});
  assert.ok(where.includes('outcome'), 'fresh view must filter on outcome');
  assert.ok(!where.includes('agent_email'), 'no forced per-agent scope may survive');
  assert.deepStrictEqual(params, []);
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
    'Forced to be marked as RTO', 'unresolved',
  ]);
  // Every bucket the CASE can emit must appear in the display list, or a date whose only tickets
  // land in the missing bucket renders a row of zeros with the count silently dropped.
  for (const label of ['Within 48 hrs', 'Within 2-4 days', '4-8 days', '8-10 days',
    'Greater than 10 days', 'Forced to be marked as RTO', 'unresolved']) {
    assert.ok(DE_DAYWISE_BUCKET_SQL.includes(`'${label}'`),
      `bucket ${label} is listed for display but never emitted by the CASE`);
  }
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
