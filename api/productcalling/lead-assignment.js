// The only way the browser disposes a Product Calling lead. No 'claim' action - a lead only
// ever becomes this agent's via the two auto-assign triggers (going Online, in
// api/auth/[action].js; and this file's own post-dispose self-refill below), same as NPS-Calling.
const { getSession } = require('../_lib/session');
const {
  disposeProductCallingLead, isCallingProcessAdmin,
  getProductCallingAgentAvailability, getProductCallingQuotaAndLoad, assignProductCallingLeadsToAgent,
} = require('../_lib/db');

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

  const { action, leadRef, disposition, agentRemarks, connected, attempt } = req.body || {};
  if (!leadRef) {
    res.status(400).json({ error: 'leadRef is required' });
    return;
  }
  if (action !== 'dispose') {
    res.status(400).json({ error: 'Unknown action' });
    return;
  }

  try {
    const allowAnyAgent = session.isAdmin || (await isCallingProcessAdmin(session.email, TAB_KEY));
    const { originalAgentEmail } = await disposeProductCallingLead(
      leadRef, disposition, agentRemarks, connected, attempt, session.email, { allowAnyAgent },
    );
    const isOverrideOntoSomeoneElse = allowAnyAgent && originalAgentEmail
      && originalAgentEmail.toLowerCase() !== session.email.toLowerCase();

    let assignedLeads = [];
    try {
      if (!isOverrideOntoSomeoneElse) {
        const stillOnline = (await getProductCallingAgentAvailability(session.email)) === 'Online';
        if (stillOnline) {
          const { quota, load } = await getProductCallingQuotaAndLoad(session.email);
          if (load < quota) {
            assignedLeads = await assignProductCallingLeadsToAgent(session.email, 1);
          }
        }
      }
    } catch (e) {
      console.error('api/productcalling/lead-assignment: self-refill failed:', e.message || e);
    }
    res.status(200).json({ ok: true, assignedLeads });
  } catch (e) {
    console.error('api/productcalling/lead-assignment error:', e);
    res.status(500).json({ error: e.message || 'Could not record disposition' });
  }
};
