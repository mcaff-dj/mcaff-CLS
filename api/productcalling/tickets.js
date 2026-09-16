// GET-only: lists Product Calling tickets for the "Fresh Leads"/"All Leads" tabs (own tickets)
// and the admin/process-admin scopes (?scope=all, ?scope=unassigned pool preview).
const { getSession } = require('../_lib/session');
const { getProductCallingTicketsForAgent, getAllProductCallingTickets, getUnassignedProductCallingLeads, isCallingProcessAdmin } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'productkyc';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Product Calling.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Product Calling.';
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
        res.status(403).json({ error: 'Only an admin or Product Calling process admin can view this.' });
        return;
      }
      if (req.query.scope === 'unassigned') {
        res.status(200).json({ leads: await getUnassignedProductCallingLeads(20) });
        return;
      }
      res.status(200).json({ tickets: await getAllProductCallingTickets() });
      return;
    }
    res.status(200).json({ tickets: await getProductCallingTicketsForAgent(session.email) });
  } catch (e) {
    console.error('api/productcalling/tickets error:', e);
    res.status(500).json({ error: e.message || 'Could not load tickets' });
  }
};
