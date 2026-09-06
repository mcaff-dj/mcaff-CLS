// The only way the browser disposes an NPS-Calling lead (see api/_lib/db.js's
// disposeDetractorLead). No 'claim' action here, unlike NDR's equivalent - a lead only ever
// becomes this agent's via one of the two auto-assign triggers (going Online, in
// api/auth/[action].js; and this file's own post-dispose self-refill below), so there is
// nothing separate to claim.
const { getSession } = require('../_lib/session');
const {
  disposeDetractorLead, isCallingProcessAdmin, logEvent,
  getDetractorAgentAvailability, getDetractorQuotaAndLoad, assignDetractorLeadsToAgent,
} = require('../_lib/db');

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

  const { action, responseId, disposition, agentRemarks, connected, attempt, affectedProducts } = req.body || {};
  if (!responseId) {
    res.status(400).json({ error: 'responseId is required' });
    return;
  }
  if (action !== 'dispose') {
    res.status(400).json({ error: 'Unknown action' });
    return;
  }

  try {
    // email always from the session, never the body - the WHERE clause this feeds decides
    // whether that has to be the lead's own agent (default) or any lead at all (admin/process-
    // admin override, checked here server-side - a client can't grant itself this by omitting
    // the check).
    const allowAnyAgent = session.isAdmin || (await isCallingProcessAdmin(session.email, TAB_KEY));
    const { originalAgentEmail } = await disposeDetractorLead(
      responseId, disposition, agentRemarks, connected, attempt, session.email,
      { allowAnyAgent, affectedProducts: Array.isArray(affectedProducts) ? affectedProducts.join(', ') : (affectedProducts || null) },
    );
    const isOverrideOntoSomeoneElse = allowAnyAgent && originalAgentEmail
      && originalAgentEmail.toLowerCase() !== session.email.toLowerCase();
    if (isOverrideOntoSomeoneElse) {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
      await logEvent(session.uid, session.email, CARD_KEY, 'detractor-dispose-override',
        `Disposed ${responseId} (assigned to ${originalAgentEmail}) on their behalf`, ip);
    }
    // Self-refill: the disposing agent gets their freed slot back immediately, same shape as
    // RTO/NDR's on-disposal top-up - but never for an admin override onto someone ELSE's lead
    // (isOverrideOntoSomeoneElse above), since the disposer isn't the one whose slot opened up.
    // Re-checks availability and quota now, not just whatever they were at dispose time - the
    // agent may have gone Offline, or an admin may have lowered their quota, in between.
    let assignedLeads = [];
    try {
      if (!isOverrideOntoSomeoneElse) {
        const stillOnline = (await getDetractorAgentAvailability(session.email)) === 'Online';
        if (stillOnline) {
          const { quota, load } = await getDetractorQuotaAndLoad(session.email);
          if (load < quota) {
            assignedLeads = await assignDetractorLeadsToAgent(session.email, 1);
          }
        }
      }
    } catch (e) {
      console.error('api/detractor/lead-assignment: self-refill failed:', e.message || e);
    }
    res.status(200).json({ ok: true, assignedLeads });
  } catch (e) {
    console.error('api/detractor/lead-assignment error:', e);
    res.status(500).json({ error: e.message || 'Could not record disposition' });
  }
};
