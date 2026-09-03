// GET/PUT /api/order-punch/settings - admin-only. Reads/writes order_punch_settings (facility
// codes, channel-routing lists, cooldown days, max suffix) - the Python worker reads the same
// table directly via its own connection, see
// docs/superpowers/specs/2026-08-21-order-punch-design.md.
const { getSession } = require('../_lib/session');
const { getOrderPunchSettings, upsertOrderPunchSetting } = require('../_lib/db');

const CARD_KEY = 'calling';
const TAB_KEY = 'exports';
const SUB_TAB_KEY = 'order-punch';

// Value type per key - a PUT with the wrong shape is rejected rather than silently stored and
// breaking the Python worker's own reads (which trust these types without re-validating).
const SETTINGS_TYPES = {
  facility_codes: 'array',
  mcaffeine_channels: 'array',
  hyphen_channels: 'array',
  target_mcaffeine: 'string',
  target_hyphen: 'string',
  cooldown_days: 'number',
  max_suffix: 'number',
};

// isAdmin bypasses everything below, same as before this permission existed. A non-admin needs
// 'order-punch' EXPLICITLY in their tab list - unlike every other sub-permission on this card,
// being unrestricted/untouched does NOT imply Order Punch access (see api/_lib/tabs.js's own
// comment on why: this creates real Unicommerce orders).
function checkAccess(session) {
  if (!session) return 'Not authenticated';
  const hasOrderPunchTab = Array.isArray(session.tabPerms?.[CARD_KEY]) && session.tabPerms[CARD_KEY].includes(SUB_TAB_KEY);
  if (!session.isAdmin && !hasOrderPunchTab) return 'Only admins (or an explicitly granted agent) can view or change Order Punch settings.';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to Calling Team exports.';
  const tabs = session.tabPerms && session.tabPerms[CARD_KEY];
  if (Array.isArray(tabs) && tabs.length && !tabs.includes(TAB_KEY)) return 'You do not have access to Calling Team exports.';
  return null;
}

function typeMatches(key, value) {
  const expected = SETTINGS_TYPES[key];
  if (expected === 'array') return Array.isArray(value) && value.every((v) => typeof v === 'string');
  if (expected === 'string') return typeof value === 'string' && value.trim().length > 0;
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value) && value > 0;
  return false;
}

module.exports = async (req, res) => {
  const session = await getSession(req);
  const denied = checkAccess(session);
  if (denied) return res.status(session ? 403 : 401).json({ error: denied });

  if (req.method === 'GET') {
    try {
      const settings = await getOrderPunchSettings();
      return res.status(200).json({ settings });
    } catch (e) {
      console.error('api/order-punch/settings GET error:', e);
      return res.status(500).json({ error: e.message || 'Could not load settings' });
    }
  }

  if (req.method === 'PUT') {
    const { key, value } = req.body || {};
    if (!SETTINGS_TYPES[key]) {
      return res.status(400).json({ error: `Unknown setting key '${key}'` });
    }
    if (!typeMatches(key, value)) {
      return res.status(400).json({ error: `'${key}' must be a ${SETTINGS_TYPES[key]}` });
    }
    try {
      await upsertOrderPunchSetting(key, value, session.email);
      const settings = await getOrderPunchSettings();
      return res.status(200).json({ settings });
    } catch (e) {
      console.error('api/order-punch/settings PUT error:', e);
      return res.status(500).json({ error: e.message || 'Could not save this setting' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
