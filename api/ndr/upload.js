// POST /api/ndr/upload - admin or ndr process-admin only. Bulk-adds new NDR leads from a CSV to
// the uploader's own team's "Latest NDR " sheet: parses, checks the live sheet's layout hasn't
// drifted, dedupes by AWB + Attempt Count (within the file first, then against the target sheet,
// then against every OTHER active team's sheet), and appends what survives.
//
// Synchronous, unlike the RTO upload's two-stage endpoint+Lambda split (api/rto/upload-start.js).
// That split exists solely because RTO's rows need GoKwik and mcaff_prod MySQL checks before they
// may be written, and neither is reachable from this runtime inside API Gateway's ~29s ceiling.
// An NDR lead has no such check: nothing was returned to refund and no replacement order exists
// to have been punched, so there is nothing to wait on and no job/worker/polling to justify.
//
// If a check ever IS added here and it needs MySQL, this cannot stay synchronous - it would need
// the same jobs-table + worker-Lambda shape RTO has. Deliberately not scaffolded for that now.
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');
const { parseCSV } = require('../_lib/csv');
const { buildRowPlan, checkSheetLayout, columnLetterToIndex, dedupKey, normalizeAwb } = require('../_lib/rtoCsvImport');
const {
  NDR_IMPORT, NDR_ROW_WIDTH, NDR_LAST_COLUMN_LETTER, NDR_AWB_COLUMN, NDR_ATTEMPT_COLUMN,
} = require('../_lib/ndrCsvImport');
const { isCallingProcessAdmin, resolveCallerTeam, listCallingTeams } = require('../_lib/db');
// PRE_SPLIT_TEAM: the same zero-active-teams fallback api/ndr/sheet.js already falls back to for
// reads, imported rather than re-declared so the two endpoints share one literal pair
// (sheetId/sheetTab) instead of two copies that could quietly drift apart. See its own comment in
// sheet.js for what it is and why it stays reachable.
const { PRE_SPLIT_TEAM } = require('./sheet');

const CARD_KEY = 'calling';
const TAB_KEY = 'ndr';
const MAX_ROWS = 5000;

let _client = null;
function getClient() {
  if (!_client) {
    const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    const key = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!email || !key) throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars');
    _client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  }
  return _client;
}

// sheetId is now a parameter, not a module-level constant - which sheet an upload targets is
// resolved per-request by resolveUploadTarget below. Still never taken from an unvalidated
// request field directly: every call site passes team.sheetId, and `team` itself only ever comes
// from resolveUploadTarget's own DB-backed lookup (calling_teams, via listCallingTeams/
// resolveCallerTeam) - never from req.body.sheetId. That is what stops a permitted-but-malicious
// caller from pointing this service account's Editor access at an arbitrary spreadsheet, the same
// property the old hardcoded NDR_SHEET_ID constant gave for free before teams existed.
async function sheetsRequest(client, sheetId, method, path, body) {
  const res = await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`,
    method,
    data: body,
  });
  return res.data;
}

async function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!session.isAdmin && !(await isCallingProcessAdmin(session.email, TAB_KEY))) {
    return 'Only admins or this process\'s admin can upload leads.';
  }
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to NDR Calling.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to NDR Calling.';
  return null;
}

// Which sheet an upload lands in is decided by WHO is uploading - never by anything in the CSV
// (neither live NDR sheet has a column that identifies a team) and never by an unvalidated
// request field taken at face value. `teams` is the caller's own already-fetched active-team
// list (see the handler below), so this needs no DB round-trip of its own beyond
// resolveCallerTeam.
//
// The ONLY thing this refuses is picking between two or more candidate sheets with nothing to
// say which one is right - that's a genuine guess, and a guessed destination here writes
// hundreds of leads into the wrong team's live sheet with no undo beyond deleting rows by hand
// from a spreadsheet someone else is actively working in. Resolving to the one sheet that could
// possibly be meant, when there is only one (zero or exactly one active team), is NOT a guess -
// it is today's already-live behaviour, and this mirrors api/ndr/sheet.js's own resolveSheetFor
// exactly (down to reusing its PRE_SPLIT_TEAM constant) so the read and write endpoints can never
// disagree about which sheet a given caller owns.
//
//   TL (passed checkAccess via isCallingProcessAdmin, not session.isAdmin):
//     - assigned to one of the currently-active teams -> that team, unconditionally. A caller
//       WITH a resolvable team can never fall through to the ambiguous-count logic below.
//     - not assigned to any currently-active team (no calling_agent_process row, or their team
//       has since gone inactive) -> falls to the same active-team-count resolution an admin who
//       named no team gets, below.
//
//   full admin (session.isAdmin):
//     - body.teamId names one of the active teams -> that team, regardless of how many teams
//       exist. An explicit, valid choice is never second-guessed.
//     - body.teamId names something that is not an active team (typo, stale id, a paused team's
//       id) -> 400, always. A bad id must never silently resolve to *some* team.
//     - body.teamId omitted -> falls to the active-team-count resolution below.
//
//   Active-team-count resolution (shared by "TL with no resolvable team" and "admin with no
//   teamId"):
//     0 active teams  -> PRE_SPLIT_TEAM. The desk hasn't been split yet; there is nothing else
//                        this upload could possibly mean, so refusing here would only turn the
//                        one state every fresh deploy starts in into an outage - regressing the
//                        exact "NDR upload has never worked" bug this project already fixed once.
//     1 active team   -> that team. Still not a guess: it is the only candidate.
//     2+ active teams -> 400. This is the actually dangerous case the whole guard exists for.
async function resolveUploadTarget(session, body, teams) {
  if (session.isAdmin) {
    if (body.teamId != null) {
      const picked = teams.find((t) => t.id === parseInt(body.teamId, 10));
      return picked ? { team: picked } : { error: 'No such active team.' };
    }
    return byActiveCount(teams, {
      error: 'Pick which team to upload to.', teams: teams.map((t) => ({ id: t.id, name: t.name })),
    });
  }
  const { callerTeamId } = await resolveCallerTeam(session.email, TAB_KEY);
  // `teams` is already active-only and scoped to this process (TAB_KEY), so finding nothing here
  // covers both "never assigned" and "assigned to a team that is now inactive/gone" in one check.
  const mine = callerTeamId != null ? teams.find((t) => t.id === callerTeamId) : null;
  if (mine) return { team: mine };
  return byActiveCount(teams, { error: 'You are not assigned to an NDR team yet. Ask an admin to assign you.' });
}

// The shared "no explicit, caller-named team" resolution: unambiguous for 0 or 1 active teams,
// genuinely ambiguous for 2+, in which case `ambiguousResult` (the caller-appropriate refusal -
// an admin can be told to pick; a TL has nothing to pick from and is told they're unassigned) is
// returned instead.
function byActiveCount(teams, ambiguousResult) {
  if (teams.length === 0) return { team: PRE_SPLIT_TEAM };
  if (teams.length === 1) return { team: teams[0] };
  return ambiguousResult;
}

// Places one row's { columnLetter: value } map into a fixed-width A..Q array, so a single
// contiguous values:append covers every written column. One wide append rather than several
// narrow ones because Sheets picks each append's target row from that range's own last-used row,
// with no guarantee two calls would land on the same row.
function rowToFullArray(cellsByColumn) {
  const arr = new Array(NDR_ROW_WIDTH).fill('');
  Object.entries(cellsByColumn).forEach(([col, val]) => { arr[columnLetterToIndex(col)] = val; });
  return arr;
}

// The dedup key set as ONE sheet stands right now, built from the same two fields and in the same
// order as NDR_IMPORT.dedupExtraCsvHeaders - otherwise nothing would ever match. Read via
// batchGet so only the two columns that form the key cross the wire, not the whole row width.
// Takes sheetId/sheetTab as parameters (rather than the old module-level constants) so the same
// function reads the target team's sheet AND every other team's sheet for the cross-team check
// below.
//
// UNFORMATTED_VALUE, not Sheets' FORMATTED_VALUE default: a numeric AWB stored as a number has a
// FORMATTED value of "5.4E+13", which matches no real AWB and would silently defeat this dedup
// entirely - the exact bug fixed on the RTO path (see api/rto/upload-start.js's own note).
async function readKeySetForSheet(client, sheetId, sheetTab) {
  const ranges = [`'${sheetTab}'!${NDR_AWB_COLUMN}2:${NDR_AWB_COLUMN}`, `'${sheetTab}'!${NDR_ATTEMPT_COLUMN}2:${NDR_ATTEMPT_COLUMN}`]
    .map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const data = await sheetsRequest(client, sheetId, 'GET', `/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`);
  const [awbRange, attemptRange] = data.valueRanges || [];
  const awbRows = (awbRange && awbRange.values) || [];
  const attemptRows = (attemptRange && attemptRange.values) || [];

  const keys = new Set();
  // Indexed off the AWB column: a row with no AWB has no identity to dedup against. The two
  // ranges start at the same row, so index i is the same sheet row in both - but the shorter
  // range simply ends early where trailing cells are blank, hence the guarded lookup.
  awbRows.forEach((row, i) => {
    const awb = normalizeAwb((row && row[0]) || '');
    if (!awb) return;
    const attemptRow = attemptRows[i];
    const attempt = (attemptRow && attemptRow[0]) !== undefined ? attemptRow[0] : '';
    keys.add(dedupKey(awb, { 'Attempt Count': attempt }, NDR_IMPORT.dedupExtraCsvHeaders));
  });
  return keys;
}

// Why the OTHER active teams' sheets are read too, on every single upload: ndr_lead_assignments
// has no team column (see db.js's CREATE TABLE) and its only uniqueness is a UNIQUE key on the
// LIVE awb_number. A lead sitting live in BOTH teams' sheets at once therefore corrupts that
// shared mirror - the second team's claim silently INSERT IGNOREs to nothing while its disposal
// overwrites the first team's cycle, and the cron that reassigns unworked leads steals the row
// outright. Rejecting the duplicate here, at upload time, is the only guard available: fixing
// ndr_lead_assignments to carry a team column so two teams could legitimately both hold "their
// own" copy of an AWB is deliberately out of scope for this project. targetTeamId's own sheet is
// excluded - buildRowPlan already deduped against it via existingKeySet.
async function readForeignKeySets(client, teams, targetTeamId) {
  const others = teams.filter((t) => t.id !== targetTeamId);
  const sets = await Promise.all(others.map((t) => readKeySetForSheet(client, t.sheetId, t.sheetTab)));
  return others.map((t, i) => ({ team: t, keys: sets[i] }));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  const denied = await checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  // Resolved immediately after the access gate, before any CSV work: which sheet this upload may
  // touch does not depend on the file's contents, and a caller who's about to be refused for
  // "pick a team" or "you're not on a team" should find that out without first paying for a CSV
  // parse.
  const teams = await listCallingTeams(TAB_KEY);
  const target = await resolveUploadTarget(session, req.body || {}, teams);
  if (target.error) {
    res.status(400).json({ error: target.error, teams: target.teams });
    return;
  }
  const { team } = target;

  const { csv } = req.body || {};
  if (!csv || typeof csv !== 'string') {
    res.status(400).json({ error: 'csv text is required' });
    return;
  }

  let csvRows;
  try {
    csvRows = parseCSV(csv);
  } catch (e) {
    res.status(400).json({ error: `Could not parse CSV: ${e.message}` });
    return;
  }
  if (!csvRows.length) {
    res.status(400).json({ error: 'No data rows found in the CSV' });
    return;
  }
  if (csvRows.length > MAX_ROWS) {
    res.status(400).json({ error: `CSV has ${csvRows.length} rows - the limit is ${MAX_ROWS} per upload. Split it into smaller files.` });
    return;
  }

  // csvHeaders goes back with the error on purpose: the required set is fixed (see
  // ndrCsvImport.js), so when a file doesn't match, the fastest way to see why is the file's own
  // header row next to the missing names.
  const csvHeaders = Object.keys(csvRows[0]);
  const missingCsvHeaders = NDR_IMPORT.requiredCsvHeaders.filter((h) => !csvHeaders.includes(h));
  if (missingCsvHeaders.length) {
    res.status(400).json({
      error: `This CSV is missing required column(s): ${missingCsvHeaders.join(', ')}.`,
      csvHeaders,
    });
    return;
  }

  try {
    const client = getClient();

    // Layout drift check, run against the RESOLVED team's own sheet - not a hardcoded constant.
    // The column each field goes to is fixed, not derived from this row, so this exists purely to
    // catch someone inserting or reordering a column in the live sheet before that silently lands
    // data in the wrong place. Both live NDR sheets share an identical 28-column header today, so
    // this passes for either team - but a future third team's sheet must still be checked
    // independently rather than assumed to match. sheetHeader is returned with the failure so the
    // real text is visible without opening the sheet.
    const headerData = await sheetsRequest(
      client, team.sheetId, 'GET',
      `/values/${encodeURIComponent(`'${team.sheetTab}'!A1:Q1`)}`,
    );
    const fullHeaderRow = (headerData.values || [[]])[0] || [];
    const layoutIssues = checkSheetLayout(fullHeaderRow, NDR_IMPORT.expectedHeader);
    if (layoutIssues.length) {
      res.status(500).json({
        error: 'Sheet column layout has changed unexpectedly - refusing to append to avoid writing misaligned data. Contact an admin.',
        details: layoutIssues,
        sheetHeader: fullHeaderRow,
      });
      return;
    }

    const existingKeySet = await readKeySetForSheet(client, team.sheetId, team.sheetTab);
    const plan = buildRowPlan({ csvRows, existingKeySet, config: NDR_IMPORT });

    // Cross-team duplicate check (see readForeignKeySets' own comment for why this exists at
    // all). Runs AFTER buildRowPlan, not folded into existingKeySet: a row that's already in the
    // TARGET sheet is "duplicateInSheet" (unremarkable, expected on a re-upload), while a row
    // that's live in a DIFFERENT team's sheet is a distinct, more serious condition worth its own
    // count and its own message - conflating the two would hide exactly the case this guard
    // exists to catch.
    const foreignSets = await readForeignKeySets(client, teams, team.id);
    const foreignHits = [];
    const keep = [];
    plan.validRows.forEach((row) => {
      const hit = foreignSets.find((f) => f.keys.has(row.dedupKey));
      if (hit) foreignHits.push({ line: row.line, reason: `already in ${hit.team.name}'s sheet` });
      else keep.push(row);
    });
    plan.validRows = keep;

    let appended = 0;
    if (plan.validRows.length) {
      await sheetsRequest(
        client, team.sheetId, 'POST',
        `/values/${encodeURIComponent(`'${team.sheetTab}'!A2:${NDR_LAST_COLUMN_LETTER}`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { values: plan.validRows.map((r) => rowToFullArray(r.cellsByColumn)) },
      );
      appended = plan.validRows.length;
    }

    // Every field the frontend (app/ndr-calling/NdrUploadModal.js) already renders stays exactly
    // as it was - team and duplicateInOtherTeam are the only additions, so the current modal
    // keeps working unchanged until it's updated to show them.
    res.status(200).json({
      team: { id: team.id, name: team.name },
      appended,
      duplicateInSheet: plan.counts.duplicateInSheet,
      duplicateInFile: plan.counts.duplicateInFile,
      duplicateInOtherTeam: foreignHits.length,
      missingAwb: plan.counts.missingAwb,
      scientificAwb: plan.counts.scientificAwb,
      total: csvRows.length,
      errors: [...plan.errors, ...foreignHits].slice(0, 50),
    });
  } catch (e) {
    console.error('api/ndr/upload error:', e);
    res.status(500).json({ error: e.message || 'Could not process this upload' });
  }
};
