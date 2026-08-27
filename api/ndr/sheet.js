// Gated Google Sheets proxy for NDR Calling's real lead source - an already-existing,
// actively-used external spreadsheet ("NDR Calling - June"), not one this app owns. Sibling
// to api/rto/sheet.js. Read+write: the Call modal's disposition form writes exactly three of
// that sheet's own existing columns (Calling Date/Connected/Remarks - see
// RtoCrmClient.js's saveNdrDisposition) and the claim-on-open path writes Agent Name, directly
// from the browser, same trust model as RTO's own writeToSheetRow (the frontend owns which
// range it writes; this route stays a dumb, permission-gated proxy). Confirmed this session
// that the service account (GOOGLE_SHEETS_CLIENT_EMAIL/GOOGLE_SHEETS_PRIVATE_KEY) already has
// Editor access on this external sheet, not just Viewer.
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');
const { resolveCallerTeam, getCallingTeam, listCallingTeams } = require('../_lib/db');

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

// The sheet this caller is entitled to, resolved from their own team row. The client's `sid` is
// IGNORED rather than validated, for two reasons. Security: this file's original comment
// explains the check existed so a permitted-but-malicious request could not repurpose the
// service account (which holds Editor access) against another spreadsheet - never consulting
// the client's value is a stronger form of that guarantee than comparing it. Deploy safety:
// api/ and app/ ship separately, so an api/ newer than app/ still receives the old hardcoded
// sid; ignoring it keeps that request working instead of 400-ing "Unknown sheet".
async function resolveSheetFor(session) {
  const { callerTeamId, activeTeamCount } = await resolveCallerTeam(session.email, TAB_KEY);
  if (callerTeamId != null) {
    // A caller with an explicit team assignment is a TERMINAL case - it must never fall through
    // to the no-team handling below. Falling through was the bug: deactivating Team A while
    // Team B was the only other active team silently redirected every Team A agent onto Team B's
    // live sheet, for reads AND Editor-scoped batchUpdate writes. A row that's missing or paused
    // gets refused, not quietly reassigned to someone else's desk.
    const team = await getCallingTeam(callerTeamId);
    return team && team.active ? team : null;
  }
  // No team row at all: either the desk hasn't been split yet, or the caller is a full admin
  // (who holds no calling_agent_process row by convention).
  if (activeTeamCount === 0) return PRE_SPLIT_TEAM;
  if (activeTeamCount === 1) {
    const teams = await listCallingTeams(TAB_KEY);
    return teams.length === 1 ? teams[0] : null;
  }
  // Two or more active teams exist and this caller belongs to none - genuinely ambiguous;
  // guessing would serve the wrong team's leads, so refuse instead.
  return null;
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

module.exports = async (req, res) => {
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  const team = await resolveSheetFor(session);
  if (!team) {
    res.status(403).json({ error: 'You are not assigned to an NDR team yet. Ask an admin to assign you.' });
    return;
  }

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
      const range = req.query.range || '';
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
      const data = (req.body || {}).data || [];
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
