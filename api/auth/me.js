const { getSession } = require('../_lib/session');
const { CARD_LABELS } = require('../_lib/db');

module.exports = async (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(200).json({ authenticated: false });
    return;
  }
  res.status(200).json({
    authenticated: true,
    email: session.email,
    name: session.name,
    isAdmin: !!session.isAdmin,
    cards: (session.perms || []).map((k) => ({ key: k, label: CARD_LABELS[k] || k })),
  });
};
