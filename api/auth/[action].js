// Consolidated auth routes (login/logout/callback/me/presence) into one dynamic-route
// file to stay under Vercel Hobby's 12-serverless-function cap. req.query.action tells
// us which logical route was hit; URLs are unchanged.
const { CARD_KEYS, CARD_LABELS, getUserByEmail, getUserPermissions, getUserTabPermissions, bootstrapAdminIfNeeded, logEvent, upsertAgentPresence } = require('../_lib/db');
const { getSession, setSessionCookie, clearSessionCookie } = require('../_lib/session');

const PRESENCE_STATUSES = new Set(['Online', 'Busy', 'Offline']);
const GH_REPO = 'Vikash-P/mcaff-CLS';
const GH_ASSIGN_WORKFLOW = 'assign-leads.yml';

// Fires the same assign-leads workflow the 5-minute cron runs, on demand, so an agent
// who comes online with an empty queue doesn't have to wait up to 5 minutes for the
// next scheduled pass. Needs a GitHub PAT (Actions: write on this repo only) in
// GH_ACTIONS_TOKEN - best-effort: if it's not configured, or the dispatch call fails,
// this silently no-ops and the agent just gets picked up by the next scheduled run
// instead, so a missing/expired token never blocks the agent from working.
async function triggerImmediateAssignment() {
  const token = process.env.GH_ACTIONS_TOKEN;
  if (!token) return;
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GH_REPO}/actions/workflows/${GH_ASSIGN_WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );
    if (!resp.ok) {
      console.error('triggerImmediateAssignment failed:', resp.status, await resp.text());
    }
  } catch (e) {
    console.error('triggerImmediateAssignment error:', e.message || e);
  }
}

async function handleLogin(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('Server not configured: missing GOOGLE_CLIENT_ID.');
    return;
  }
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/callback`;
  const next = (req.query && req.query.next) || '/';
  const state = Buffer.from(JSON.stringify({ next })).toString('base64url');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state,
  });
  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  res.end();
}

async function handleLogout(req, res) {
  clearSessionCookie(res);
  res.writeHead(302, { Location: '/' });
  res.end();
}

async function handleMe(req, res) {
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
    tabPerms: session.tabPerms || {},
  });
}

async function handleCallback(req, res) {
  try {
    const { code, state } = req.query || {};
    if (!code) {
      res.status(400).send('Missing authorization code.');
      return;
    }
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.status(500).send('Server not configured: missing Google OAuth credentials.');
      return;
    }
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const redirectUri = `${proto}://${host}/api/auth/callback`;

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResp.ok) {
      const errBody = await tokenResp.text();
      console.error('Google token exchange failed:', tokenResp.status, errBody);
      let detail = errBody;
      try {
        const parsed = JSON.parse(errBody);
        detail = parsed.error_description || parsed.error || errBody;
      } catch { /* not JSON, use raw body */ }
      res.status(502).send('Google token exchange failed: ' + detail);
      return;
    }
    const tokenData = await tokenResp.json();

    const infoResp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenData.id_token)}`);
    if (!infoResp.ok) {
      res.status(502).send('Google token verification failed.');
      return;
    }
    const info = await infoResp.json();
    if (info.aud !== clientId) {
      res.status(401).send('Token audience mismatch.');
      return;
    }
    if (info.email_verified !== 'true' && info.email_verified !== true) {
      res.status(401).send('Google account email is not verified.');
      return;
    }

    const email = (info.email || '').toLowerCase();
    const name = info.name || email;

    let user = await getUserByEmail(email);
    if (!user) {
      user = await bootstrapAdminIfNeeded(email, name);
    }
    if (!user) {
      res.status(403).send('You do not have access to this site yet. Ask your admin to grant you access, then try signing in again.');
      return;
    }

    // Admins always get every card, regardless of what's in the permissions table - so a
    // newly-added card (e.g. today's mom/ndr/rto) is automatically visible to admins on
    // their next login, with no manual grant/backfill step needed. Same for tab
    // restrictions: admins never get one (empty object = every tab of every card).
    const permissions = user.is_admin ? CARD_KEYS : await getUserPermissions(user.id);
    const tabPerms = user.is_admin ? {} : await getUserTabPermissions(user.id);
    setSessionCookie(res, {
      uid: user.id,
      email: user.email,
      name: user.name,
      isAdmin: !!user.is_admin,
      perms: permissions,
      tabPerms,
    });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
    logEvent(user.id, user.email, null, 'login', null, ip).catch(() => {});

    let next = '/';
    try {
      if (state) next = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')).next || '/';
    } catch {
      /* ignore malformed state, fall back to / */
    }
    res.writeHead(302, { Location: next });
    res.end();
  } catch (e) {
    res.status(500).send('Login failed: ' + (e.message || String(e)));
  }
}

// RTO CRM agent presence (replaces the removed Supabase agent_status writes). Keyed
// by the caller's own session email/name by default - a non-admin can only ever
// report their own status, never spoof anyone else's. An admin caller may pass
// body.email to set a DIFFERENT agent's status instead (the roster table's per-row
// Status dropdown works for every row, not just the admin's own) - only honored when
// session.isAdmin is true, so a regular agent still can't touch anyone else's row.
//
// body.pendingBox (optional, a plain count the client already computes for its own
// UI - see rto-crm.html's `pend`) triggers an immediate off-cycle assignment run when
// the agent is going Online with an empty queue, instead of waiting up to 5 minutes
// for the next scheduled pass. Trusting the client's self-reported count here is low-
// risk: the worst a wrong/spoofed value can do is fire an extra (harmless, idempotent)
// assignment pass - assign_leads.py itself remains the sole authority on who actually
// gets which lead.
async function handlePresence(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = getSession(req);
  if (!session || !session.email) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  if (!PRESENCE_STATUSES.has(body.status)) {
    res.status(400).json({ error: 'status must be one of Online, Busy, Offline' });
    return;
  }
  let targetEmail = session.email;
  let targetName = session.name || session.email;
  if (session.isAdmin && body.email) {
    targetEmail = String(body.email).toLowerCase();
    targetName = body.name || targetEmail;
  }
  await upsertAgentPresence(targetEmail, targetName, body.status);
  if (body.status === 'Online' && body.pendingBox === 0) {
    triggerImmediateAssignment().catch(() => {});
  }
  res.status(200).json({ ok: true });
}

const HANDLERS = { login: handleLogin, logout: handleLogout, me: handleMe, callback: handleCallback, presence: handlePresence };

module.exports = async (req, res) => {
  const action = req.query && req.query.action;
  const handler = HANDLERS[action];
  if (!handler) {
    res.status(404).send('Not found.');
    return;
  }
  await handler(req, res);
};
