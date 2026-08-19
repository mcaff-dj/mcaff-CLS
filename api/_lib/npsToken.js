// HMAC-signed, expiring token for the public NPS survey link - same tamper-proof/expiring
// property as api/_lib/session.js's cookie token, kept as its own module (own secret) since
// this token is embedded in a link handed to people outside the org, not stored in a cookie.
const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}
function secret() {
  const s = process.env.NPS_TOKEN_SECRET;
  if (!s) throw new Error('Missing NPS_TOKEN_SECRET env var');
  return s;
}

function signNpsToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  return `${body}.${mac}`;
}

function verifyNpsToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, expired: false };
  }
  const [body, mac] = token.split('.');
  const expectedMac = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, expired: false };
  }
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return { valid: false, expired: false };
  }
  if (!payload.exp || Date.now() / 1000 > payload.exp) {
    return { valid: false, expired: true };
  }
  return { valid: true, expired: false, payload };
}

const LINK_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

// Shared by api/nps-admin/send.js (real sends) and api/nps-admin/preview-link.js (admin
// preview, no WhatsApp involved) - one place that knows how a recipient id becomes a link.
function buildNpsLink(recipientId) {
  const base = process.env.NPS_PUBLIC_BASE_URL;
  if (!base) throw new Error('Missing NPS_PUBLIC_BASE_URL env var');
  const token = signNpsToken({ recipientId, exp: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS });
  return `${base.replace(/\/+$/, '')}/nps/${token}`;
}

module.exports = { signNpsToken, verifyNpsToken, buildNpsLink };
