// GET  /api/admin/users -> list all users + their permissions (admin only)
// POST /api/admin/users -> create/invite a user: { email, name, permissions: ['mcaffeine',...] }
//                       -> or bulk-invite: { users: [{email,name},...], permissions: ['mcaffeine',...] }
const { sql, ensureSchema, CARD_KEYS, CARD_LABELS } = require('../_lib/db');
const { getSession } = require('../_lib/session');
const { sendMail, siteBaseUrl } = require('../_lib/mail');

async function upsertAndInvite(email, name, perms, req) {
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

  return user;
}

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
    const perms = Array.isArray(body.permissions) ? body.permissions.filter((k) => CARD_KEYS.includes(k)) : [];

    if (Array.isArray(body.users)) {
      // Bulk mode: shared `perms` applied to every entry, invited one at a time
      // (sequential, not parallel - keeps DB/Resend load predictable for a
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
          const user = await upsertAndInvite(entry.email, entry.name, perms, req);
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
    const user = await upsertAndInvite(email, name, perms, req);
    res.status(200).json({ user });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
