// GET-only: lists NPS-Calling tickets for the "Fresh Leads"/"All Leads" tabs (own tickets) and
// the admin/process-admin scopes (?scope=all for every agent's tickets, ?scope=unassigned for
// the "Next to Assign" pool preview). CLS_NPS_calling is self-contained (see its own comment in
// db.js) so the own/all-scope queries never need to touch nps_delivery - only the unassigned
// preview does.
const { getSession } = require('../_lib/session');
const { getDetractorTicketsForAgent, getAllDetractorTickets, getUnassignedDetractorLeads, isCallingProcessAdmin } = require('../_lib/db');

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
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  try {
    if (req.query.scope === 'all' || req.query.scope === 'unassigned') {
      const allowed = session.isAdmin || (await isCallingProcessAdmin(session.email, TAB_KEY));
      if (!allowed) {
        res.status(403).json({ error: 'Only an admin or NPS-Calling process admin can view this.' });
        return;
      }
      if (req.query.scope === 'unassigned') {
        res.status(200).json({ leads: await getUnassignedDetractorLeads(20) });
        return;
      }
      res.status(200).json({ tickets: await getAllDetractorTickets() });
      return;
    }
    res.status(200).json({ tickets: await getDetractorTicketsForAgent(session.email) });
  } catch (e) {
    console.error('api/detractor/tickets error:', e);
    res.status(500).json({ error: e.message || 'Could not load tickets' });
  }
};
