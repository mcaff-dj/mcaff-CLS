// Consolidated admin routes (users/permissions/audit) into one dynamic-route file,
// same technique already used by api/auth/[action].js. req.query.action tells us
// which logical route was hit; URLs are unchanged:
//   GET    /api/admin/users       -> list all users + their permissions (admin only)
//   POST   /api/admin/users       -> create/invite a user: { email, name, permissions: ['mcaffeine',...], tabPermissions: {hyphen:['csat']} }
//                                  -> or bulk-invite: { users: [{email,name},...], permissions: [...], tabPermissions: {...} }
//   DELETE /api/admin/users       -> delete a user outright: { userId }
//   POST   /api/admin/permissions -> grant whole card         { userId, cardKey }
//   DELETE /api/admin/permissions -> revoke whole card        { userId, cardKey }
//   PUT    /api/admin/permissions -> set tab restriction      { userId, cardKey, tabKeys }
//   GET    /api/admin/audit       -> most recent 200 access events (admin only)
const { sql, ensureSchema, CARD_KEYS, CARD_LABELS, setTabPermissions, deleteUser } = require('../_lib/db');
const { CARD_TABS } = require('../_lib/tabs');
const { getSession } = require('../_lib/session');
const { sendMail, siteBaseUrl } = require('../_lib/mail');

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body || {};
}

async function upsertAndInvite(email, name, perms, tabPerms, req) {
  const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
  const isNewUser = existing.rows.length === 0;

  await sql`
    INSERT INTO users (email, name) VALUES (${email}, ${name})
    ON DUPLICATE KEY UPDATE name = COALESCE(NULLIF(VALUES(name), ''), name)
  `;
  const { rows } = await sql`SELECT id, email, name, is_admin FROM users WHERE email = ${email}`;
  const user = rows[0];
  for (const key of perms) {
    await sql`INSERT IGNORE INTO permissions (user_id, card_key) VALUES (${user.id}, ${key})`;
  }
  for (const [cardKey, tabKeys] of Object.entries(tabPerms || {})) {
    if (!perms.includes(cardKey)) continue;
    const validKeys = new Set((CARD_TABS[cardKey] || []).map((t) => t.key));
    await setTabPermissions(user.id, cardKey, (Array.isArray(tabKeys) ? tabKeys : []).filter((k) => validKeys.has(k)));
  }

  const { rows: permRows } = await sql`SELECT card_key FROM permissions WHERE user_id = ${user.id}`;
  const cardLabels = permRows.map((r) => CARD_LABELS[r.card_key] || r.card_key);

  // Best-effort notification - awaited before responding so a slow send never risks
  // the function tearing down mid-send, but failures here still never block the
  // invite itself from succeeding.
  try {
    const base = siteBaseUrl(req);
    const listHtml = cardLabels.length ? `<ul>${cardLabels.map((l) => `<li>${l}</li>`).join('')}</ul>` : '<p>(no reports yet)</p>';
    await sendMail({
      to: email,
      subject: isNewUser ? "You've been invited to Customer Query Segment Reports" : 'Your report access was updated',
      html: `
        <p>Hi ${name || email},</p>
        <p>${isNewUser ? "You've been given access to the Customer Query Segment Reports site." : 'Your access was just updated.'} You can currently view:</p>
        ${listHtml}
        <p><a href="${base}/">Sign in with Google</a> using this email address (${email}) to view them.</p>
      `,
    });
  } catch (e) {
    console.error('Invite email failed:', e.message || e);
  }

  return user;
}

async function handleUsers(req, res, session) {
  if (req.method === 'GET') {
    const { rows: users } = await sql`SELECT id, email, name, is_admin, created_at FROM users ORDER BY created_at ASC`;
    const { rows: perms } = await sql`SELECT user_id, card_key FROM permissions`;
    const { rows: tabPerms } = await sql`SELECT user_id, card_key, tab_key FROM report_tab_permissions`;
    const byUser = {};
    perms.forEach((p) => {
      (byUser[p.user_id] = byUser[p.user_id] || []).push(p.card_key);
    });
    const tabsByUser = {};
    tabPerms.forEach((p) => {
      const u = (tabsByUser[p.user_id] = tabsByUser[p.user_id] || {});
      (u[p.card_key] = u[p.card_key] || []).push(p.tab_key);
    });
    const result = users.map((u) => ({ ...u, permissions: byUser[u.id] || [], tabPermissions: tabsByUser[u.id] || {} }));
    res.status(200).json({ users: result, cardKeys: CARD_KEYS, cardTabs: CARD_TABS });
    return;
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    const perms = Array.isArray(body.permissions) ? body.permissions.filter((k) => CARD_KEYS.includes(k)) : [];
    const tabPerms = (body.tabPermissions && typeof body.tabPermissions === 'object') ? body.tabPermissions : {};

    if (Array.isArray(body.users)) {
      // Bulk mode: shared `perms`/`tabPerms` applied to every entry, invited one at
      // a time (sequential, not parallel - keeps DB/Resend load predictable for a
      // human-triggered admin action and keeps per-row error isolation simple).
      const seen = new Set();
      const entries = body.users
        .map((u) => ({ email: ((u && u.email) || '').trim().toLowerCase(), name: ((u && u.name) || '').trim() }))
        .filter((e) => {
          if (!e.email || seen.has(e.email)) return false;
          seen.add(e.email);
          return true;
        });
      if (!entries.length) {
        res.status(400).json({ error: 'No valid emails supplied' });
        return;
      }
      const results = [];
      for (const entry of entries) {
        try {
          const user = await upsertAndInvite(entry.email, entry.name, perms, tabPerms, req);
          results.push({ email: entry.email, ok: true, user });
        } catch (e) {
          console.error('Bulk invite failed for', entry.email, e.message || e);
          results.push({ email: entry.email, ok: false, error: e.message || 'Failed' });
        }
      }
      res.status(200).json({ results });
      return;
    }

    const email = (body.email || '').trim().toLowerCase();
    const name = (body.name || '').trim();
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    const user = await upsertAndInvite(email, name, perms, tabPerms, req);
    res.status(200).json({ user });
    return;
  }

  if (req.method === 'DELETE') {
    const body = parseBody(req);
    const userId = parseInt(body.userId, 10);
    if (!userId) {
      res.status(400).json({ error: 'Invalid userId' });
      return;
    }
    if (userId === session.uid) {
      res.status(400).json({ error: "You can't delete your own account." });
      return;
    }
    const deleted = await deleteUser(userId);
    if (!deleted) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.status(200).json({ ok: true, email: deleted.email });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}

async function handlePermissions(req, res) {
  const body = parseBody(req);
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
}

async function handleAudit(req, res) {
  const { rows } = await sql`SELECT email, card_key, action, detail, accessed_at, ip FROM audit_log ORDER BY accessed_at DESC LIMIT 200`;
  res.status(200).json({ entries: rows.map((r) => ({ ...r, cardLabel: r.card_key ? (CARD_LABELS[r.card_key] || r.card_key) : '' })) });
}

module.exports = async (req, res) => {
  const session = await getSession(req);
  if (!session || !session.isAdmin) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  await ensureSchema();

  const action = req.query && req.query.action;
  if (action === 'users') return handleUsers(req, res, session);
  if (action === 'permissions') return handlePermissions(req, res);
  if (action === 'audit') return handleAudit(req, res);

  res.status(404).json({ error: 'Unknown admin route' });
};
