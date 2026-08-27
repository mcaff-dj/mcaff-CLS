// Pure scoping rules for NDR Calling's per-team isolation - no DB, no network, no I/O, so the
// rules that decide who sees whose data are unit-testable in a repo whose tests cannot open a
// connection (see db.cache.test.js's own note). api/_lib/db.js and the routes under api/ndr,
// api/admin and api/auth all defer to these functions rather than reimplementing the checks,
// which is what keeps one route from quietly disagreeing with another.
//
// See docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-design.md.

// Google Sheets file ids are URL-path segments for this app's Sheets calls, so the guard is
// deliberately a strict allowlist of the characters Google actually uses (alphanumeric, - and _)
// rather than a blocklist: a value containing '/' or '..' would otherwise re-target the service
// account's request path, and the account has Editor access. Length range covers the ids in use
// (44 chars) with room either side; anything outside it is a paste error, not an id.
const SHEET_ID_MAX = 128;
const TEAM_NAME_MAX = 120;
// calling_teams.sheet_tab is also VARCHAR(120), same width as the name column but a distinct
// field (a Sheets tab name, not a team name) - kept as its own constant rather than reusing
// TEAM_NAME_MAX so a future reader isn't left wondering whether the two limits are coincidentally
// equal or actually the same rule.
const SHEET_TAB_MAX = 120;
const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,128}$/;

function isValidSheetId(s) {
  return typeof s === 'string' && SHEET_ID_RE.test(s);
}

function normalizeTeamName(s) {
  return (s == null ? '' : String(s)).trim().replace(/\s+/g, ' ').slice(0, TEAM_NAME_MAX);
}

// Coerces a raw explicit-team-id value - a query-string or JSON-body field, so a string, number,
// '', null, or undefined - into a real team id or null. Every call site that reads one needs this,
// not just parseInt: parseInt('', 10) is NaN, and NaN is `!= null`, so a plain `explicitTeamId ==
// null ? null : parseInt(explicitTeamId, 10)` guard (which only checks the OUTER value for null)
// still hands teamScopeFor a NaN for an empty string - exactly what an "All teams" <select>
// option naturally encodes. teamScopeFor then returns that NaN as the chosen team, and
// filterRosterByTeam's strict `r.teamId === teamId` never matches a NaN (NaN !== NaN in JS), so a
// full admin's roster comes back silently EMPTY instead of "All teams". parseInt already turns
// null/undefined into NaN too (via its own string coercion), so one Number.isFinite check after
// parseInt covers every "no team chosen" spelling in one place, rather than trusting each call
// site to separately remember the null-check AND the NaN-check.
function coerceTeamId(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

// The ONE place the release-1 softening lives, so it is greppable and removable in a single edit.
//
// Returns:
//   undefined -> apply no team filter (single-team desk, or an admin viewing everything)
//   null      -> fail closed, return nothing (two teams exist and this caller belongs to none)
//   number    -> scope to exactly this team
//
// Why undefined rather than null while fewer than two teams exist: the team_id column arrives by
// a hand-run migration while the api/ code that reads it deploys automatically in about a minute
// (see the spec's rollout section). Failing closed in that window is not a safety property - it
// drops every existing agent off their own roster and, because the client learns isProcessAdmin
// by finding itself in that roster, silently costs the TL their Admin Panel. Behaving exactly
// like today until a second team is deliberately created makes the whole rollout
// order-independent, and the isolation switches on with a data change rather than a deploy.
function teamScopeFor({ callerTeamId = null, activeTeamCount = 0, explicitTeamId = null, isAdmin = false } = {}) {
  // "Teamless processes are always unfiltered" is unconditional - it must be checked BEFORE the
  // admin explicit-team branch below, not after. An admin's explicit choice only makes sense
  // once teams exist to choose between; checking it first meant a full admin passing an explicit
  // teamId against a process with 0 or 1 active teams (rto, escalation, deliveryescalation - see
  // db.js's resolveCallerTeam) got filterRosterByTeam'd against a team that, for that process,
  // isn't really scoping anything - producing an empty roster instead of the documented
  // guarantee. Nothing in the current UI sends an explicitTeamId for a teamless process, so this
  // was latent, not exploitable - but the contract said "always unfiltered" and the code didn't
  // honour it.
  if (activeTeamCount < 2) return undefined;
  if (isAdmin && explicitTeamId != null) return explicitTeamId;
  if (isAdmin) return undefined; // an admin who picked no team sees every team
  return callerTeamId == null ? null : callerTeamId;
}

// Cache keys for per-team slots. Terminated with ':' because invalidateCache (see db.js) matches
// on startsWith - an un-terminated 'calling:ndrLeadDates:1' is also a string-prefix of a key
// tagged for team 10 or 11, so evicting team 1's cache would silently evict theirs too. That
// shows up as random staleness on someone else's desk, which is close to undebuggable, so the
// delimiter is enforced here once rather than trusted to every call site that builds a key by
// hand.
function teamCacheKey(base, teamId) {
  return `${base}:${teamId == null ? 'none' : teamId}:`;
}

// Applied to the joined roster rows AFTER getCallingProcessAgents' two queries are combined in
// JS, because membership and per-process state come from different queries there.
//
// teamId === undefined returns the SAME array reference untouched (not a copy) - existing callers
// (api/escalation/[action].js, app/rto-crm/RtoCrmClient.js, app/escalation/EscalationClient.js)
// invoke this without a team argument at all and must keep working exactly as before.
function filterRosterByTeam(rows, teamId) {
  if (teamId === undefined) return rows;
  if (teamId === null) return [];
  return (rows || []).filter((r) => r && r.teamId === teamId);
}

module.exports = {
  teamScopeFor, filterRosterByTeam, isValidSheetId, normalizeTeamName, teamCacheKey, coerceTeamId,
  SHEET_ID_MAX, TEAM_NAME_MAX, SHEET_TAB_MAX,
};
