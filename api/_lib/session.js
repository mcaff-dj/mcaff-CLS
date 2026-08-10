// Small HMAC-signed session token - not full JWT, same security property (tamper-proof,
// server-verified, expiring) without adding a JWT dependency for a single internal tool.
const crypto = require('crypto');
const { getUserById, getUserPermissions, getUserTabPermissions, CARD_KEYS } = require('./db');

const COOKIE_NAME = 'pkyc_session';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('Missing SESSION_SECRET env var');
  return s;
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expectedMac = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() / 1000 > payload.exp) return null;
  return payload;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

// The signed cookie only proves who logged in and when - it can't reflect a user being
// deleted or having permissions changed *after* it was issued (cookies last up to
// MAX_AGE_SECONDS). So every call re-checks the user's current row and re-derives
// perms/isAdmin/tabPerms from the database instead of trusting what was baked into the
// cookie at login time; a user deleted (or de-admin'd) after logging in loses access
// on their very next request rather than whenever their cookie happens to expire.
async function getSession(req) {
  const cookies = parseCookies(req);
  const payload = verify(cookies[COOKIE_NAME]);
  if (!payload) return null;
  const user = await getUserById(payload.uid);
  if (!user) return null;
  // Both queries are independent (neither's result feeds the other), so run them
  // concurrently instead of back-to-back - this function runs on every gated request
  // across the whole API, so halving its DB round-trip time matters everywhere.
  const [perms, tabPerms] = user.is_admin
    ? [CARD_KEYS, {}]
    : await Promise.all([getUserPermissions(user.id), getUserTabPermissions(user.id)]);
  return {
    uid: user.id,
    email: user.email,
    name: user.name,
    isAdmin: !!user.is_admin,
    perms,
    tabPerms,
  };
}

function setSessionCookie(res, payload) {
  const token = sign({ ...payload, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS });
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

module.exports = { getSession, setSessionCookie, clearSessionCookie, parseCookies };
