// POST   /api/admin/permissions -> grant whole card         { userId, cardKey }
// DELETE /api/admin/permissions -> revoke whole card        { userId, cardKey }
// PUT    /api/admin/permissions -> set tab restriction      { userId, cardKey, tabKeys }
//        (tabKeys: [] or omitted removes the restriction -> full access to every tab)
const { sql, ensureSchema, CARD_KEYS, setTabPermissions } = require('../_lib/db');
const { CARD_TABS } = require('../_lib/tabs');
const { getSession } = require('../_lib/session');

module.exports = async (req, res) => {
  const session = getSession(req);
  if (!session || !session.isAdmin) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  await ensureSchema();

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const userId = parseInt(body.userId, 10);
  const cardKey = body.cardKey;
  if (!userId || !CARD_KEYS.includes(cardKey)) {
    res.status(400).json({ error: 'Invalid userId or cardKey' });
    return;
  }

  if (req.method === 'POST') {
    await sql`INSERT IGNORE INTO permissions (user_id, card_key) VALUES (${userId}, ${cardKey})`;
    res.status(200).json({ ok: true });
    return;
  }
  if (req.method === 'DELETE') {
    await sql`DELETE FROM permissions WHERE user_id = ${userId} AND card_key = ${cardKey}`;
    res.status(200).json({ ok: true });
    return;
  }
  if (req.method === 'PUT') {
    const validKeys = new Set((CARD_TABS[cardKey] || []).map((t) => t.key));
    const tabKeys = Array.isArray(body.tabKeys) ? body.tabKeys.filter((k) => validKeys.has(k)) : [];
    await setTabPermissions(userId, cardKey, tabKeys);
    res.status(200).json({ ok: true });
    return;
  }
  res.status(405).json({ error: 'Method not allowed' });
};
