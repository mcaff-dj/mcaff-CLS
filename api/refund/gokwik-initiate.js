// POST /api/refund/gokwik-initiate - server-side proxy for GoKwik's refund API. Each vendor
// (Hyphen, Fien, mcaffeine-direct) has its own appid/appsecret, selected by the order
// number's prefix; all live only in Vercel env vars and never reach the browser. COD orders
// never reach this endpoint because the UI only offers refund initiation for Prepaid orders.
const { logEvent } = require('../_lib/db');
const { getSession } = require('../_lib/session');

const GOKWIK_URL = 'https://api.gokwik.co/v2/order/refund/initiate';

// Order number prefix -> env var prefix for that vendor's GoKwik credentials, plus how to
// build the moid GoKwik actually expects. Checked in order; anything that doesn't match a
// known prefix is a plain-numeric mcaffeine-direct (Shopify) order number, so that vendor is
// the catch-all and must stay last. mcaffeine orders carry no prefix in the sheet, but
// GoKwik's mcaffeine merchant account expects moid as "MCaff<order number>".
const VENDORS = [
  { key: 'hyphen', prefixPattern: /^HYP/i, envPrefix: 'GOKWIK_HYPHEN', formatMoid: (m) => m },
  { key: 'fien', prefixPattern: /^Fien/i, envPrefix: 'GOKWIK_FIEN', formatMoid: (m) => m },
  { key: 'mcaffeine', prefixPattern: /.*/, envPrefix: 'GOKWIK_MCAFFEINE', formatMoid: (m) => `MCaff${m}` },
];

function resolveVendor(moid) {
  if (!moid) return null;
  return VENDORS.find((v) => v.prefixPattern.test(moid)) || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const moid = typeof body.moid === 'string' ? body.moid.trim() : '';
  const amount = Number(body.amount);

  const vendor = resolveVendor(moid);
  if (!vendor) {
    res.status(400).json({ error: 'Missing or invalid order number (moid).' });
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: 'Invalid refund amount.' });
    return;
  }

  const appId = process.env[`${vendor.envPrefix}_APPID`];
  const appSecret = process.env[`${vendor.envPrefix}_APPSECRET`];
  if (!appId || !appSecret) {
    res.status(500).json({ error: `Server not configured: missing GoKwik credentials for ${vendor.key}.` });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  const gokwikMoid = vendor.formatMoid(moid);

  let gkRes, text;
  try {
    gkRes = await fetch(GOKWIK_URL, {
      method: 'POST',
      headers: {
        appid: appId,
        appsecret: appSecret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount, moid: gokwikMoid }),
    });
    text = await gkRes.text();
  } catch (e) {
    logEvent(session.uid, session.email, vendor.key, 'refund_initiate_error', `${moid} ₹${amount} — ${e.message}`, ip).catch(() => {});
    res.status(502).json({ error: 'Failed to reach GoKwik', detail: e.message });
    return;
  }

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!gkRes.ok) {
    logEvent(session.uid, session.email, vendor.key, 'refund_initiate_failed', `${moid} ₹${amount} — HTTP ${gkRes.status}`, ip).catch(() => {});
    res.status(502).json({ error: 'GoKwik refund failed', status: gkRes.status, detail: data });
    return;
  }

  logEvent(session.uid, session.email, vendor.key, 'refund_initiate', `${moid} ₹${amount}`, ip).catch(() => {});
  res.status(200).json({ ok: true, vendor: vendor.key, moid: gokwikMoid, gokwik: data });
};
