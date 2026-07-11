// Redirects to Google's OAuth consent screen. GET /api/auth/login?next=/some/path
module.exports = async (req, res) => {
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
};
