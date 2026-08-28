// Pure-function tests for per-team disposition trees. No DB, no network - same shape as
// callingTeams.test.js. Run: node api/_lib/dispositionTrees.test.js
const assert = require('assert');
const { dispositionTeamFor, planTreeClone } = require('./dispositionTrees');

// ── dispositionTeamFor: null means the shared tree, a number means that team's own tree ──

// Fewer than two active teams: everyone resolves to the shared tree, exactly as before this
// feature. Covers rto/escalation/deliveryescalation and ndr before a split.
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 0 }), null);
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 1, callerTeamId: 7 }), null);
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 1, explicitTeamId: 5, isAdmin: true }), null);

// Two or more teams: a caller with a team gets their own team's tree.
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 2, callerTeamId: 7 }), 7);
// A non-admin's explicit teamId is ignored outright - their own team still wins.
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 2, callerTeamId: 7, explicitTeamId: 3 }), 7);
// A caller with no team falls back to the shared tree rather than seeing nothing.
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 2, callerTeamId: null }), null);
// A full admin's explicit choice is honoured; omitting it means the shared tree.
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 2, explicitTeamId: 3, isAdmin: true }), 3);
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 2, isAdmin: true }), null);
// teamId 0 is a real id, not "unset" - the check is `!= null`, not truthiness.
assert.strictEqual(dispositionTeamFor({ activeTeamCount: 2, explicitTeamId: 0, isAdmin: true }), 0);

// ── planTreeClone: parents before children, ids never leak into the plan ──

const SHARED = [
  { id: 10, parentId: null, label: 'Connected', description: 'got through', sortOrder: 0, childrenInputType: 'single' },
  { id: 12, parentId: 11, label: 'Reattempt', description: null, sortOrder: 0, childrenInputType: 'single' },
  { id: 11, parentId: null, label: 'Not Connected', description: null, sortOrder: 1, childrenInputType: 'multi' },
  { id: 13, parentId: 12, label: 'Wrong Address', description: null, sortOrder: 0, childrenInputType: 'text' },
];

const plan = planTreeClone(SHARED);
assert.strictEqual(plan.length, 4);
// Every child appears AFTER its parent, whatever order the input rows arrived in (sort_order is
// scoped per parent, so the SELECT gives no cross-level ordering guarantee).
const positionOf = (label) => plan.findIndex((p) => p.label === label);
assert.ok(positionOf('Not Connected') < positionOf('Reattempt'));
assert.ok(positionOf('Reattempt') < positionOf('Wrong Address'));
// Roots carry no parent; a child's parentTempKey points at its parent's tempKey, never at a
// shared row's real id - inserting by real id would attach the copy to the ORIGINAL tree.
assert.strictEqual(plan[positionOf('Connected')].parentTempKey, null);
assert.strictEqual(
  plan[positionOf('Wrong Address')].parentTempKey,
  plan[positionOf('Reattempt')].tempKey
);
// Every field that gives an option its meaning is carried over.
assert.deepStrictEqual(
  { ...plan[positionOf('Connected')], tempKey: 0, parentTempKey: null },
  { tempKey: 0, parentTempKey: null, label: 'Connected', description: 'got through', sortOrder: 0, childrenInputType: 'single' }
);
assert.strictEqual(plan[positionOf('Not Connected')].childrenInputType, 'multi');
assert.strictEqual(plan[positionOf('Reattempt')].sortOrder, 0);
assert.strictEqual(plan[positionOf('Not Connected')].sortOrder, 1);
// An empty shared tree plans nothing rather than throwing - a brand-new process has no rows.
assert.deepStrictEqual(planTreeClone([]), []);
// A row whose parent is absent from the input is dropped, not silently promoted to a root: a
// promoted child would appear as a new top-level outcome, which NDR's own metrics key off.
assert.deepStrictEqual(planTreeClone([{ id: 5, parentId: 99, label: 'Orphan', sortOrder: 0 }]), []);

console.log('dispositionTrees.test.js: all assertions passed');
