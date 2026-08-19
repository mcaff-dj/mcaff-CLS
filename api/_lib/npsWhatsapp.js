// Single Gupshup WhatsApp sender for NPS survey links - one function, not a multi-provider
// abstraction (see api/refund/gokwik-initiate.js for the same per-vendor-env-var pattern
// used elsewhere in this repo). Swap provider later by editing this file only.
//
// No unit test: this is a thin network proxy with no branching logic to verify offline (same
// as gokwik-initiate.js), and there's no live Gupshup account yet to test against for real.
const GUPSHUP_URL = 'https://api.gupshup.io/wa/api/v1/msg';

async function sendWhatsApp(phone, message) {
  const apiKey = process.env.GUPSHUP_API_KEY;
  const source = process.env.GUPSHUP_SOURCE;
  const appName = process.env.GUPSHUP_APP_NAME;
  if (!apiKey || !source || !appName) {
    throw new Error('Missing GUPSHUP_API_KEY / GUPSHUP_SOURCE / GUPSHUP_APP_NAME env vars');
  }

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source,
    destination: phone,
    'src.name': appName,
    message: JSON.stringify({ type: 'text', text: message }),
  });

  const res = await fetch(GUPSHUP_URL, {
    method: 'POST',
    headers: { apikey: apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    throw new Error(`Gupshup send failed: HTTP ${res.status} - ${text}`);
  }
  return data;
}

module.exports = { sendWhatsApp };
