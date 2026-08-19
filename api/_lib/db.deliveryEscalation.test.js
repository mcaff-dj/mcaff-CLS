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

// 6. Overview's day-wise bucket: a still-open ticket (no disposed_at yet) must bucket by days
// elapsed AS OF TODAY, not fall into 'unresolved' - that's the exact regression "assume today's
// date as delivered" was asked to fix. Guards the SQL text itself since there's no DB here to
// run the CASE against.
{
  assert.ok(DE_DAYWISE_BUCKET_SQL.includes('COALESCE(disposed_at, CURDATE())'),
    'an unresolved dispose date must fall back to today, not stay NULL');
  assert.ok(DE_DAYWISE_BUCKET_SQL.includes("added_date IS NULL THEN 'unresolved'"),
    "'unresolved' must be reserved for a missing added_date, not a missing disposed_at");
  assert.ok(!/disposed_at IS NULL THEN 'unresolved'/.test(DE_DAYWISE_BUCKET_SQL),
    'a bare disposed_at IS NULL check must not resurrect the old always-unresolved behaviour');
  assert.deepStrictEqual(DE_DAYWISE_BUCKETS, [
    '4-8 days', '8-10 days', 'Forced to be marked as RTO', 'Greater than 10 days',
    'unresolved', 'Within 2-4 days', 'Within 48 hrs',
  ]);
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
