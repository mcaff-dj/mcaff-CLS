// GET /api/admin/audit -> most recent 200 access events (admin only)
const { sql, ensureSchema, CARD_LABELS } = require('../_lib/db');
const { getSession } = require('../_lib/session');

module.exports = async (req, res) => {
  const session = getSession(req);
  if (!session || !session.isAdmin) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  await ensureSchema();
  const { rows } = await sql`SELECT email, card_key, accessed_at, ip FROM audit_log ORDER BY accessed_at DESC LIMIT 200`;
  res.status(200).json({ entries: rows.map((r) => ({ ...r, cardLabel: CARD_LABELS[r.card_key] || r.card_key })) });
};
