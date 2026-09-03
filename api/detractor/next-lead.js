// NPS-Calling's "pull next lead" button (process key 'detractor' - see api/_lib/
// callingProcesses.json). Unlike RTO/NDR's next-lead.js, there is no Sheet and no cron
// auto-assigner to race against: this is the ONLY way a lead ever gets assigned, called
// on demand by the agent rather than a background top-up after a disposal.
const { getSession } = require('../_lib/session');
const {
  getDetractorAgentAvailability, getDetractorAgentQuota, getDetractorLoadByAgent,
  getNextDetractorLead,
} = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'detractor';

// No admin override on this default (unlike RTO's leadAssignmentRules.json) - NPS-Calling has
// no comparable shared config file yet, and 15 is a deliberately conservative starting cap for
// a brand-new process. Raise via calling_agent_process.max_quota per-agent if it's too low,
// same as every other process's per-agent override already works.
const DEFAULT_QUOTA = 15;

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

  try {
    // Same fail-closed contract as RTO's getRtoAgentAvailability: no row or a lookup error both
    // mean "cannot verify eligible - do not assign", never "assume Online".
    const availability = await getDetractorAgentAvailability(session.email);
    if (availability !== 'Online') {
      res.status(200).json({ assigned: false, reason: 'You must be Online to pull a new lead.' });
      return;
    }

    const quotaOverride = await getDetractorAgentQuota(session.email);
    const quota = quotaOverride != null ? quotaOverride : DEFAULT_QUOTA;
    const load = await getDetractorLoadByAgent(session.email);
    if (load >= quota) {
      res.status(200).json({
        assigned: false,
        reason: `You already hold ${load} undisposed lead(s) - at your quota of ${quota}. Dispose some before pulling more.`,
      });
      return;
    }

    const lead = await getNextDetractorLead(session.email);
    if (!lead) {
      res.status(200).json({ assigned: false, reason: 'No unassigned NPS detractor leads right now.' });
      return;
    }
    res.status(200).json({ assigned: true, lead });
  } catch (e) {
    console.error('api/detractor/next-lead error:', e);
    res.status(500).json({ error: e.message || 'Could not pull next lead' });
  }
};
