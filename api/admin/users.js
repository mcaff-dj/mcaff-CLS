// GET  /api/admin/users -> list all users + their permissions (admin only)
// POST /api/admin/users -> create/invite a user: { email, name, permissions: ['mcaffeine',...] }
const { sql, ensureSchema, CARD_KEYS, CARD_LABELS } = require('../_lib/db');
const { getSession } = require('../_lib/session');
const { sendMail, siteBaseUrl } = require('../_lib/mail');

module.exports = async (req, res) => {
  const session = getSession(req);
  if (!session || !session.isAdmin) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  await ensureSchema();

  if (req.method === 'GET') {
    const { rows: users } = await sql`SELECT id, email, name, is_admin, created_at FROM users ORDER BY created_at ASC`;
    const { rows: perms } = await sql`SELECT user_id, card_key FROM permissions`;
    const byUser = {};
    perms.forEach((p) => {
      (byUser[p.user_id] = byUser[p.user_id] || []).push(p.card_key);
    });
    const result = users.map((u) => ({ ...u, permissions: byUser[u.id] || [] }));
    res.status(200).json({ users: result, cardKeys: CARD_KEYS });
    return;
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};
    const email = (body.email || '').trim().toLowerCase();
    const name = (body.name || '').trim();
    const perms = Array.isArray(body.permissions) ? body.permissions.filter((k) => CARD_KEYS.includes(k)) : [];
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    const isNewUser = existing.rows.length === 0;

    const { rows } = await sql`
      INSERT INTO users (email, name) VALUES (${email}, ${name})
      ON CONFLICT (email) DO UPDATE SET name = COALESCE(NULLIF(EXCLUDED.name, ''), users.name)
      RETURNING id, email, name, is_admin
    `;
    const user = rows[0];
    for (const key of perms) {
      await sql`INSERT INTO permissions (user_id, card_key) VALUES (${user.id}, ${key}) ON CONFLICT DO NOTHING`;
    }

    const { rows: permRows } = await sql`SELECT card_key FROM permissions WHERE user_id = ${user.id}`;
    const cardLabels = permRows.map((r) => CARD_LABELS[r.card_key] || r.card_key);

    // Best-effort notification - awaited before responding so Vercel doesn't freeze
    // the function mid-send (which can happen if you write the response first), but
    // failures here still never block the invite itself from succeeding.
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

    res.status(200).json({ user });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
