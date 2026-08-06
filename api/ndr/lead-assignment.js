// The only way the browser reaches ndr_lead_assignments (see api/_lib/db.js's
// claimNdrLead/disposeNdrLead) - same permission gate as api/ndr/sheet.js. This table is a
// parallel write alongside the Google Sheet (Q:U columns), not a replacement - the sheet
// stays what the UI actually reads from; this is the durable/queryable history side. No GET:
// nothing in the UI reads this table back yet.
const { getSession } = require('../_lib/session');
const { claimNdrLead, disposeNdrLead } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'ndr';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to NDR Calling.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to NDR Calling.';
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

  const { action, awbNumber } = req.body || {};
  if (!awbNumber) {
    res.status(400).json({ error: 'awbNumber is required' });
    return;
  }

  try {
    if (action === 'claim') {
      await claimNdrLead(awbNumber, (req.body || {}).email || session.email);
      res.status(200).json({ ok: true });
      return;
    }
    if (action === 'dispose') {
      const { disposition, agentRemarks } = req.body || {};
      await disposeNdrLead(awbNumber, disposition, agentRemarks);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('api/ndr/lead-assignment error:', e);
    res.status(500).json({ error: e.message || 'Could not record NDR lead assignment' });
  }
};
