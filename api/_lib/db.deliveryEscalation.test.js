// Offline self-check for the Delivery-Escalation WHERE-builder in db.js - pure/offline, never
// opens a connection. Run with `node api/_lib/db.deliveryEscalation.test.js`.
//
// The regression it guards: a non-admin used to be pinned to `agent_email = <their email>`, which
// hid every unclaimed ticket from the very people meant to claim them (a newly-invited agent saw
// an empty page). Access is checkAccess()/report_tab_permissions only - no row-level scope.
const assert = require('assert');
const { deWhere } = require('./db');

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

console.log('db.deliveryEscalation.test.js: all assertions passed');
