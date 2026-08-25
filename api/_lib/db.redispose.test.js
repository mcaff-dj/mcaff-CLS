// Self-check for shouldOpenNewCycle (db.js) - the rule that decides whether a disposal on an
// already-disposed lead opens a NEW assignment cycle or updates the existing row. Pure, so no
// database is involved. Run with `node api/_lib/db.redispose.test.js`.
//
// This rule exists because of a real incident: order 9184758 collected 16 extra cycles in 6
// seconds on 2026-08-25, one per click of a Save button that stayed enabled through a
// multi-second submit, and every one of them counted as another conversion.
const assert = require('assert');
const { shouldOpenNewCycle } = require('./db');

const T = Date.parse('2026-08-25T06:58:11Z');
const row = (over = {}) => ({ disposed_at: new Date(T), agent_email: 'a@x.com', ...over });

// Not disposed yet: the ordinary one-cycle case, always a plain UPDATE.
assert.strictEqual(shouldOpenNewCycle({ disposed_at: null, agent_email: 'a@x.com' }, 'a@x.com', T), false);
assert.strictEqual(shouldOpenNewCycle(undefined, 'a@x.com', T), false, 'no live row - the INSERT path handles it');

// Same agent, seconds later: one disposal arriving twice. This is the incident.
assert.strictEqual(shouldOpenNewCycle(row(), 'a@x.com', T + 1000), false);
assert.strictEqual(shouldOpenNewCycle(row(), 'A@X.com  ', T + 6000), false, 'email match is case/space insensitive');

// A different agent re-working the lead is exactly what a new cycle is FOR - its own
// agent_email and assigned_at are the point, so this must not be collapsed however fast it is.
assert.strictEqual(shouldOpenNewCycle(row(), 'b@x.com', T + 1000), true);

// Same agent, but a genuine later re-open (All Leads search) still gets its own cycle.
assert.strictEqual(shouldOpenNewCycle(row(), 'a@x.com', T + 60 * 1000), true, '60s is the boundary - inclusive');
assert.strictEqual(shouldOpenNewCycle(row(), 'a@x.com', T + 4 * 3600 * 1000), true);

// Defensive: an unreadable or missing stored timestamp must keep history rather than silently
// overwrite a row whose age cannot be established.
assert.strictEqual(shouldOpenNewCycle(row({ disposed_at: 'not a date' }), 'a@x.com', T + 1000), true);
assert.strictEqual(shouldOpenNewCycle(row({ agent_email: null }), 'a@x.com', T + 1000), true, 'unknown owner is not "same agent"');

console.log('db.redispose.test.js: all assertions passed');
