// The only way the browser disposes an NPS-Calling lead (see api/_lib/db.js's
// disposeDetractorLead). No 'claim' action here, unlike NDR's equivalent - a lead only ever
// becomes this agent's via next-lead.js's own INSERT, so there is nothing separate to claim.
const { getSession } = require('../_lib/session');
const { disposeDetractorLead } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'detractor';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to NPS-Calling.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to NPS-Calling.';
  return null;
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

  const { action, responseId, disposition, agentRemarks, connected, attempt } = req.body || {};
  if (!responseId) {
    res.status(400).json({ error: 'responseId is required' });
    return;
  }
  if (action !== 'dispose') {
    res.status(400).json({ error: 'Unknown action' });
    return;
  }

  try {
    // email always from the session, never the body - an agent may only ever dispose a lead as
    // themselves, same reasoning as api/ndr/lead-assignment.js.
    await disposeDetractorLead(responseId, disposition, agentRemarks, connected, attempt, session.email);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('api/detractor/lead-assignment error:', e);
    res.status(500).json({ error: e.message || 'Could not record disposition' });
  }
};
