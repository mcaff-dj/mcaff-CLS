// Pure-function tests for the NDR per-team scoping rules. No DB, no network - same shape as
// db.cache.test.js and db.redispose.test.js. Run: node api/_lib/callingTeams.test.js
const assert = require('assert');
const {
  teamScopeFor, filterRosterByTeam, isValidSheetId, normalizeTeamName,
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

// ── normalizeTeamName ──
assert.strictEqual(normalizeTeamName('  Team  A  '), 'Team A');
assert.strictEqual(normalizeTeamName('\tNorth\n'), 'North');
assert.strictEqual(normalizeTeamName(null), '');

console.log('ok - callingTeams pure scoping rules');
