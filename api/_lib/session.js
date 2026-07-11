// Small HMAC-signed session token - not full JWT, same security property (tamper-proof,
// server-verified, expiring) without adding a JWT dependency for a single internal tool.
const crypto = require('crypto');

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

function getSession(req) {
  const cookies = parseCookies(req);
  return verify(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, payload) {
  const token = sign({ ...payload, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS });
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

module.exports = { getSession, setSessionCookie, clearSessionCookie, parseCookies };
