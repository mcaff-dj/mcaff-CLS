// Handles Google's OAuth redirect: exchanges the code, verifies the ID token, checks
// whether this email has been granted access (or matches ADMIN_EMAILS for bootstrap),
// and issues a session cookie. No self-serve signup - unrecognized emails are rejected.
const { getUserByEmail, getUserPermissions, bootstrapAdminIfNeeded } = require('../_lib/db');
const { setSessionCookie } = require('../_lib/session');

module.exports = async (req, res) => {
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
      res.status(502).send('Google token exchange failed.');
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

    const permissions = await getUserPermissions(user.id);
    setSessionCookie(res, {
      uid: user.id,
      email: user.email,
      name: user.name,
      isAdmin: !!user.is_admin,
      perms: permissions,
    });

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
};
