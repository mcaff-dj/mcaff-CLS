// The only way the browser reaches ndr_lead_assignments (see api/_lib/db.js's
// claimNdrLead/disposeNdrLead) - same permission gate as api/ndr/sheet.js. This table is a
// parallel write alongside the Google Sheet (Q:U columns), not a replacement - the sheet
// stays what the UI actually reads from; this is the durable/queryable history side. No GET:
// nothing in the UI reads this table back yet.
const { getSession } = require('../_lib/session');
const { claimNdrLead, disposeNdrLead, getLiveNdrLeadEmail, resolveCallerTeam, getCallingProcessAgents } = require('../_lib/db');
const { teamScopeFor } = require('../_lib/callingTeams');

const CARD_KEY = 'calling';
const TAB_KEY = 'ndr';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to NDR Calling.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to NDR Calling.';
  return null;
}

// This table has no team column (see db.js's CREATE TABLE), so unlike the sheet proxy this can't
// reject a foreign AWB by looking up which team it belongs to - it can only ask who currently
// holds the live cycle and check whether THAT PERSON is on the caller's own team. An unclaimed
// AWB (no live row at all) has nobody to conflict with and must always be allowed through - that
// is the normal claim path, not an edge case. teamScopeFor returns undefined for a full admin or
// for any process with fewer than two active teams (the release-1 softening used everywhere else
// in this feature), so this is a no-op until isolation actually switches on.
async function assertNotAnotherTeamsLead(session, awbNumber) {
  const { callerTeamId, activeTeamCount } = await resolveCallerTeam(session.email, TAB_KEY);
  const teamId = teamScopeFor({ callerTeamId, activeTeamCount, isAdmin: session.isAdmin });
  if (teamId === undefined) return null;
  const liveEmail = await getLiveNdrLeadEmail(awbNumber);
  if (!liveEmail) return null;
  // teamId === null means isolation is active and this caller belongs to no team - fail closed:
  // an empty roster can never contain the live row's email, so any already-claimed lead is
  // correctly refused rather than guessed at.
  const roster = teamId === null ? [] : await getCallingProcessAgents(TAB_KEY, teamId);
  const mine = roster.some((m) => String(m.email).toLowerCase() === String(liveEmail).toLowerCase());
  return mine ? null : 'This lead belongs to another team.';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  const { action, awbNumber } = req.body || {};
  if (!awbNumber) {
    res.status(400).json({ error: 'awbNumber is required' });
    return;
  }

  try {
    if (action === 'claim' || action === 'dispose') {
      // Team guard runs before either mutation: without it, a team-A agent could POST any other
      // team's AWB and overwrite its live cycle's disposition/remarks, or attribute it to
      // themselves, since claimNdrLead/disposeNdrLead below match on awb_number alone.
      const denied = await assertNotAnotherTeamsLead(session, awbNumber);
      if (denied) {
        res.status(403).json({ error: denied });
        return;
      }
    }
    if (action === 'claim') {
      // Stamped from the session, never from the body: an agent may only ever claim a lead as
      // THEMSELVES. This previously honoured req.body.email, which let any NDR agent attribute
      // a claim to any other agent - across teams, once per-team isolation exists.
      await claimNdrLead(awbNumber, session.email);
      res.status(200).json({ ok: true });
      return;
    }
    if (action === 'dispose') {
      const { disposition, agentRemarks } = req.body || {};
      // email: only used if no live row exists to update, in which case disposeNdrLead inserts
      // the cycle itself - stamped from the session, never client-supplied, same as 'claim'
      // above (which was fixed to match this).
      await disposeNdrLead(awbNumber, disposition, agentRemarks, session.email);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('api/ndr/lead-assignment error:', e);
    res.status(500).json({ error: e.message || 'Could not record NDR lead assignment' });
  }
};
