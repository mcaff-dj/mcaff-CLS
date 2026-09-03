// GET-only: lists NPS-Calling tickets for the "My Queue"/"Disposed" tabs (own tickets) and the
// "Overview"/roster tabs (?scope=all, admin or process-admin only). CLS_NPS_calling is
// self-contained (see its own comment in db.js) so this never needs to touch nps_delivery.
const { getSession } = require('../_lib/session');
const { getDetractorTicketsForAgent, getAllDetractorTickets, isCallingProcessAdmin } = require('../_lib/db');

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
    if (req.query.scope === 'all') {
      const allowed = session.isAdmin || (await isCallingProcessAdmin(session.email, TAB_KEY));
      if (!allowed) {
        res.status(403).json({ error: 'Only an admin or NPS-Calling process admin can view all tickets.' });
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
