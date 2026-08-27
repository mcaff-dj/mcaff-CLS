// Pure-function tests for the NDR per-team scoping rules. No DB, no network - same shape as
// db.cache.test.js and db.redispose.test.js. Run: node api/_lib/callingTeams.test.js
const assert = require('assert');
const {
  teamScopeFor, filterRosterByTeam, isValidSheetId, normalizeTeamName, teamCacheKey,
  SHEET_ID_MAX, TEAM_NAME_MAX,
} = require('./callingTeams');

// ── teamScopeFor: the single place the release-1 "one team means no scoping" rule lives ──
// undefined = apply no team filter at all; null = fail closed (return nothing); a number = that team.

// Before a second team exists, nothing is scoped - the desk behaves exactly as it did before
// this feature, which is what makes the migration and the api/ deploy order-independent.
assert.strictEqual(teamScopeFor({ callerTeamId: null, activeTeamCount: 0 }), undefined);
assert.strictEqual(teamScopeFor({ callerTeamId: null, activeTeamCount: 1 }), undefined);
assert.strictEqual(teamScopeFor({ callerTeamId: 7, activeTeamCount: 1 }), undefined);

// Once two teams exist, a caller with a team is scoped to it...
assert.strictEqual(teamScopeFor({ callerTeamId: 7, activeTeamCount: 2 }), 7);
// ...and a caller WITHOUT one fails closed rather than seeing everything.
assert.strictEqual(teamScopeFor({ callerTeamId: null, activeTeamCount: 2 }), null);

// A full admin's explicit choice wins, and is the ONLY way a client value reaches this.
assert.strictEqual(teamScopeFor({ callerTeamId: null, activeTeamCount: 2, explicitTeamId: 3, isAdmin: true }), 3);
// The same field from a non-admin is ignored outright - not an error, just not honoured.
assert.strictEqual(teamScopeFor({ callerTeamId: 7, activeTeamCount: 2, explicitTeamId: 3, isAdmin: false }), 7);
// An admin who picks nothing sees everything, which is what the team selector's "All teams" is.
assert.strictEqual(teamScopeFor({ callerTeamId: null, activeTeamCount: 2, isAdmin: true }), undefined);
// explicitTeamId: 0 must be honoured as team 0, not treated as "unset" - the function checks
// `!= null` rather than truthiness precisely so a falsy-but-real id still wins.
assert.strictEqual(teamScopeFor({ callerTeamId: null, activeTeamCount: 2, explicitTeamId: 0, isAdmin: true }), 0);

// The ordering fix: "teamless processes are always unfiltered" must hold even when a full admin
// passes an explicit teamId. Before the fix, isAdmin && explicitTeamId != null short-circuited
// BEFORE the activeTeamCount < 2 check, so this returned 5 (a team id meaningless for a process
// that has no teams) instead of undefined - and callers pass that straight into
// filterRosterByTeam, turning "unfiltered" into "everyone filtered out".
assert.strictEqual(teamScopeFor({ callerTeamId: null, activeTeamCount: 0, explicitTeamId: 5, isAdmin: true }), undefined);
assert.strictEqual(teamScopeFor({ callerTeamId: null, activeTeamCount: 1, explicitTeamId: 5, isAdmin: true }), undefined);

// Called with no arguments at all - every param falls back to its default. Must not throw, and
// must resolve to "unfiltered" (activeTeamCount defaults to 0, i.e. a teamless process).
assert.strictEqual(teamScopeFor(), undefined);

// ── filterRosterByTeam ──
const ROSTER = [
  { email: 'a@x.com', teamId: 1 },
  { email: 'b@x.com', teamId: 2 },
  { email: 'c@x.com', teamId: null }, // invited but unassigned, or has no state row at all
];

// undefined means "no scoping requested" - returns the array untouched. This is what keeps
// api/escalation/[action].js and the RTO CRM working without passing a team at all.
assert.strictEqual(filterRosterByTeam(ROSTER, undefined), ROSTER);
// A real team returns only its own members...
assert.deepStrictEqual(filterRosterByTeam(ROSTER, 1).map(r => r.email), ['a@x.com']);
assert.deepStrictEqual(filterRosterByTeam(ROSTER, 2).map(r => r.email), ['b@x.com']);
// ...and never the unassigned rows, whose team_id is NULL.
assert.ok(!filterRosterByTeam(ROSTER, 1).some(r => r.teamId === null));
// null fails CLOSED. This is the single most likely implementation error - returning everything
// on a null team would hand one TL the other's whole roster.
assert.deepStrictEqual(filterRosterByTeam(ROSTER, null), []);
// A non-array rows argument (no roster loaded yet, or a caller error) must not throw - `(rows ||
// []).filter(...)` only guards against falsy, so this also pins that null/undefined specifically
// come back as [] rather than throwing on `.filter` of null.
assert.deepStrictEqual(filterRosterByTeam(null, 1), []);
assert.deepStrictEqual(filterRosterByTeam(undefined, 1), []);

// ── isValidSheetId: shape-only guard on an admin-typed field that steers a service account ──
assert.strictEqual(isValidSheetId('1lJz9dy0xnqWnmFOxzZGughp04diZrfiVQpSfK1c-xkg'), true);
assert.strictEqual(isValidSheetId('12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI'), true);
assert.strictEqual(isValidSheetId(''), false);
assert.strictEqual(isValidSheetId(null), false);
assert.strictEqual(isValidSheetId('short'), false);
// A pasted URL is a mistake worth catching, not silently storing as an id.
assert.strictEqual(isValidSheetId('https://docs.google.com/spreadsheets/d/1lJz9dy0xnqWnmFOxzZGughp04diZrfiVQpSfK1c-xkg/edit'), false);
// Anything that could break out of a URL path segment must be rejected.
assert.strictEqual(isValidSheetId('abc/../../evil'), false);
assert.strictEqual(isValidSheetId('abc def ghi jkl mno pqr'), false);
// SHEET_ID_RE's exact length boundaries ({20,128}) - one character on either side of each edge.
assert.strictEqual(isValidSheetId('a'.repeat(19)), false, '19 chars is one short of the floor');
assert.strictEqual(isValidSheetId('a'.repeat(20)), true, '20 chars is the floor, inclusive');
assert.strictEqual(isValidSheetId('a'.repeat(SHEET_ID_MAX)), true, '128 chars is the ceiling, inclusive');
assert.strictEqual(isValidSheetId('a'.repeat(SHEET_ID_MAX + 1)), false, '129 chars is one past the ceiling');

// ── normalizeTeamName ──
assert.strictEqual(normalizeTeamName('  Team  A  '), 'Team A');
assert.strictEqual(normalizeTeamName('\tNorth\n'), 'North');
assert.strictEqual(normalizeTeamName(null), '');
// Truncates at TEAM_NAME_MAX (120) rather than rejecting - an admin pasting something oversized
// gets a usable name, not a form error.
assert.strictEqual(normalizeTeamName('x'.repeat(200)).length, TEAM_NAME_MAX);
assert.strictEqual(normalizeTeamName('x'.repeat(200)), 'x'.repeat(TEAM_NAME_MAX));

// ── teamCacheKey: delimiter termination is load-bearing, not cosmetic ──
assert.strictEqual(teamCacheKey('calling:ndrLeadDates', 1), 'calling:ndrLeadDates:1:');
assert.strictEqual(teamCacheKey('calling:ndrLeadDates', null), 'calling:ndrLeadDates:none:');
// The whole point: team 1's key must not prefix-match team 10's, or invalidating one evicts the
// other. invalidateCache in db.js is startsWith-based, so this is the property it relies on.
assert.ok(!teamCacheKey('calling:ndrLeadDates', 10).startsWith(teamCacheKey('calling:ndrLeadDates', 1)),
  'team 1 key must not be a prefix of team 10 key');
assert.ok(teamCacheKey('calling:ndrLeadDates', 1).startsWith(teamCacheKey('calling:ndrLeadDates', 1)),
  'a key must still match itself');

console.log('ok - callingTeams pure scoping rules');
