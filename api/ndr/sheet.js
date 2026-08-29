// Gated Google Sheets proxy for NDR Calling's real lead source - an already-existing,
// actively-used external spreadsheet ("NDR Calling - June"), not one this app owns. Sibling
// to api/rto/sheet.js. Read+write: the Call modal's disposition form writes exactly three of
// that sheet's own existing columns (Calling Date/Connected/Remarks - see
// RtoCrmClient.js's saveNdrDisposition) and the claim-on-open path writes Agent Name, directly
// from the browser, same trust model as RTO's own writeToSheetRow for the CELL portion of a
// range (the frontend owns which rows/columns it writes). The TAB portion is not trusted from
// the frontend at all (see withResolvedTab below) - this route stays a dumb, permission-gated
// proxy only for the part of the range the caller can't get wrong. Confirmed this session
// that the service account (GOOGLE_SHEETS_CLIENT_EMAIL/GOOGLE_SHEETS_PRIVATE_KEY) already has
// Editor access on this external sheet, not just Viewer.
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');
const { resolveCallerTeam, getCallingTeam, listCallingTeams } = require('../_lib/db');
const { coerceTeamId } = require('../_lib/callingTeams');

const CARD_KEY = 'calling';
const TAB_KEY = 'ndr';

let _client = null;
function getClient() {
  if (_client) return _client;
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars');
  _client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return _client;
}

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to NDR Calling.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to NDR Calling.';
  return null;
}

// Pre-split fallback: the incumbent NDR sheet this whole file used to hardcode, kept alive for
// exactly one case - zero active `calling_teams` rows exist yet for this process. That is the
// state the instant this code deploys, before an admin has created the first team row, and it
// must not 403 every NDR agent (including full admins) in that window. Mirrors the softening
// teamScopeFor already documents in api/_lib/callingTeams.js: "exactly like today until a second
// team is deliberately created". The moment ANY active team row exists this constant is
// unreachable - resolveSheetFor always resolves a real team row instead - and it is never taken
// from the client: the request's `sid` is still never read anywhere in this file.
const PRE_SPLIT_SHEET_ID = '12p3rlXyE0PDx3BMqBpl3CUo5YD3uVzQun1HFPizpSeI';
const PRE_SPLIT_SHEET_TAB = 'Latest NDR '; // trailing space significant - matches the live tab name
const PRE_SPLIT_TEAM = {
  id: null, processKey: TAB_KEY, name: 'Pre-split (legacy)',
  sheetId: PRE_SPLIT_SHEET_ID, sheetTab: PRE_SPLIT_SHEET_TAB, active: true,
};

// The sheet this caller is entitled to, resolved from their own team row. Returns { team } or
// { error } (mirroring api/ndr/upload.js's resolveUploadTarget) rather than team|null, because
// FINAL-4/F4 below needs the refusal message to differ for an admin who has teams to pick between
// versus everyone else who genuinely has none - a single null couldn't carry that distinction.
//
// The client's `sid` is IGNORED rather than validated, for two reasons. Security: this file's
// original comment explains the check existed so a permitted-but-malicious request could not
// repurpose the service account (which holds Editor access) against another spreadsheet - never
// consulting the client's value is a stronger form of that guarantee than comparing it. Deploy
// safety: api/ and app/ ship separately, so an api/ newer than app/ still receives the old
// hardcoded sid; ignoring it keeps that request working instead of 400-ing "Unknown sheet". The
// admin `teamId` added below is a DIFFERENT, deliberately-chosen field - never `sid` - so this
// guarantee is unaffected: `req.query.sid` / `req.body.sid` are still never read anywhere here.
async function resolveSheetFor(session, req) {
  const { callerTeamId, activeTeamCount } = await resolveCallerTeam(session.email, TAB_KEY);
  if (callerTeamId != null) {
    // A caller with an explicit team assignment is a TERMINAL case - it must never fall through
    // to the no-team handling below. Falling through was the bug: deactivating Team A while
    // Team B was the only other active team silently redirected every Team A agent onto Team B's
    // live sheet, for reads AND Editor-scoped batchUpdate writes. A row that's missing or paused
    // gets refused, not quietly reassigned to someone else's desk.
    const team = await getCallingTeam(callerTeamId, TAB_KEY);
    if (team && team.active) return { team };
    return { error: 'Your NDR team is currently paused. Ask an admin to reactivate it before you can use the sheet.' };
  }
  // No team row at all: either the desk hasn't been split yet, or the caller is a full admin (who
  // holds no calling_agent_process row by convention). FINAL-4/F4: before this, a full admin fell
  // straight through to the activeTeamCount checks below with no way to name a team, so once two
  // teams existed they always hit the ambiguous case and were 403'd out of the NDR sheet entirely
  // - for reads AND writes - leaving Part 2's admin team selector with no backend to call. Mirrors
  // api/ndr/upload.js's resolveUploadTarget admin branch: an explicit, valid choice is never
  // second-guessed; a bad one always refuses rather than silently landing on *some* team.
  if (session.isAdmin) {
    const explicitTeamId = coerceTeamId((req.query && req.query.teamId) || (req.body && req.body.teamId));
    if (explicitTeamId != null) {
      const teams = await listCallingTeams(TAB_KEY);
      const picked = teams.find((t) => t.id === explicitTeamId);
      return picked ? { team: picked } : { error: 'No such active team.' };
    }
  }
  if (activeTeamCount === 0) return { team: PRE_SPLIT_TEAM };
  if (activeTeamCount === 1) {
    const teams = await listCallingTeams(TAB_KEY);
    return teams.length === 1
      ? { team: teams[0] }
      : { error: 'You are not assigned to an NDR team yet. Ask an admin to assign you.' };
  }
  // Two or more active teams exist and this caller belongs to none - genuinely ambiguous;
  // guessing would serve the wrong team's leads, so refuse instead. An admin who reached here
  // supplied no explicit teamId (the branch above already returned for one that was given), so
  // the refusal tells them to pick one instead of the "ask an admin to assign you" text that
  // makes no sense for the person WHO IS the admin.
  return {
    error: session.isAdmin
      ? 'Multiple NDR teams exist - pick one (?teamId=<id>) to read or write its sheet.'
      : 'You are not assigned to an NDR team yet. Ask an admin to assign you.',
  };
}

// Short-TTL read cache for the 'values' GET op below. Without it, every page-load or poll is
// a live Sheets API call with nothing in front of it. A 20s staleness window is an acceptable
// tradeoff for the load this saves (mirrors scripts/assign_leads.py's GOKWIK_CACHE_TTL -
// accept a little staleness for a lot less load). A plain module-scoped Map, not a shared/
// external cache: it persists across invocations on the same warm Lambda container, which is
// all we need - no cross-container invalidation, since a stale-by-20s read is fine either way.
const READ_CACHE_TTL_MS = 20000;
const _readCache = new Map(); // key (sheetId + range, see cachedRead's call site) -> { expiresAt, promise }

// Singleflight: a key already in the map - whether its fetch is still in flight or it
// resolved within the last 20s - is reused instead of firing a duplicate live call, so a
// burst of simultaneous agent page-loads for the same range collapses into one real request.
function cachedRead(key, fetcher) {
  const hit = _readCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.promise;
  const promise = fetcher();
  _readCache.set(key, { expiresAt: Date.now() + READ_CACHE_TTL_MS, promise });
  // A failed fetch must not poison the cache for the rest of the TTL window - evict on
  // rejection so the very next request retries against Sheets instead of replaying the
  // same error for up to 20s.
  promise.catch(() => _readCache.delete(key));
  return promise;
}

// Rewrites whatever tab a range string names to the CALLER'S OWN resolved team's real tab,
// regardless of what the client sent. The client only ever needs to be right about the range's
// CELL portion (A2:A1000000, R5, ...) - it never learns another team's sheetTab (non-admin GETs
// on /api/admin/calling-teams strip it), so for anyone but a full admin picking a team it had no
// correct tab name to send in the first place and always fell back to a hardcoded default. That
// default is only right for the one sheet it was copied from; every other team's real tab 400s
// with "Unable to parse range" the instant an agent or team lead opens the page. Fixing it here,
// not in the client, means it's correct for EVERY caller (old app/ deploys included, since api/
// and app/ ship separately) without waiting on an app/ redeploy: whatever tab-qualifier a range
// carries (or lacks - a bare cell range with no '!' at all also works) is discarded and replaced.
// Sheets range syntax always uses '!' as the tab/cell delimiter and never inside the cell part,
// so the last '!' is exactly the split point regardless of how the tab portion was quoted.
function withResolvedTab(range, team) {
  const bangIdx = range.lastIndexOf('!');
  const cellPart = bangIdx >= 0 ? range.slice(bangIdx + 1) : range;
  return `'${team.sheetTab}'!${cellPart}`;
}

module.exports = async (req, res) => {
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  const resolved = await resolveSheetFor(session, req);
  if (resolved.error) {
    res.status(403).json({ error: resolved.error });
    return;
  }
  const { team } = resolved;

  let token;
  try {
    const client = getClient();
    ({ token } = await client.getAccessToken());
  } catch (e) {
    res.status(500).json({ error: 'Sheets credentials not configured: ' + (e.message || e) });
    return;
  }

  try {
    if (req.method === 'GET' && req.query.op === 'values') {
      const range = withResolvedTab(req.query.range || '', team);
      // The spreadsheet id is part of the key, not just the range. Both NDR sheets name their
      // tab 'Latest NDR ' (trailing space included), so two teams request byte-identical range
      // strings - keyed on range alone they collide inside a warm Lambda container and one team
      // is served the other's rows, with a 200 and no audit trail.
      const { status, data } = await cachedRead(`values:${team.sheetId}:${range}`, async () => {
        const r = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${team.sheetId}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return { status: r.status, data: await r.json() };
      });
      res.status(status).json(data);
      return;
    }

    if (req.method === 'POST' && (req.body || {}).op === 'batchUpdate') {
      const data = ((req.body || {}).data || []).map((d) => ({ ...d, range: withResolvedTab(d.range, team) }));
      // RAW, not USER_ENTERED: every value this UI ever writes (Agent Name, Connected Yes/No,
      // Outcome, Remarks, Calling Date) is plain text nobody needs Sheets to auto-convert.
      // USER_ENTERED bit us for real - writing "06-08-2026" (DD-MM-YYYY, the format the user
      // explicitly asked for) got silently reinterpreted as MM-DD-YYYY under this sheet's
      // locale and displayed back as "8 Jun" instead of the intended 6 Aug. RAW stores exactly
      // the string sent, no locale-dependent guessing.
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${team.sheetId}/values:batchUpdate`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueInputOption: 'RAW', data }),
        }
      );
      const out = await r.json().catch(() => ({}));
      // A write just changed cells the 20s read cache above may still be serving stale - without
      // this, a poll landing inside that window hands the UI pre-write data and an
      // already-disposed lead reappears in Fresh Leads until the cache ages out on its own.
      if (r.ok) _readCache.clear();
      res.status(r.status).json(out);
      return;
    }

    res.status(400).json({ error: 'Unknown or unsupported operation' });
  } catch (e) {
    console.error('api/ndr/sheet error:', e);
    res.status(500).json({ error: 'Sheets proxy error' });
  }
};

// Exported so api/ndr/upload.js's own zero-active-teams fallback is this exact object, not a
// second copy of the same two literals - the two endpoints can then provably never disagree
// about which sheet a team-less caller lands on, instead of relying on two hand-kept copies
// staying in sync. Attached to the handler export the same way api/rto/upload-start.js attaches
// its own pure helpers (sheetsRequest, isRateLimited, ...) for its test file.
module.exports.PRE_SPLIT_TEAM = PRE_SPLIT_TEAM;
