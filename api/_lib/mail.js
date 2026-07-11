// Minimal transactional email via Resend's REST API (no SDK dependency - just fetch).
// Requires RESEND_API_KEY. FROM_EMAIL is optional; defaults to Resend's shared sandbox
// sender, which works immediately but has lower deliverability than a verified domain -
// verify your own domain in Resend and set FROM_EMAIL once you want better deliverability.
async function sendMail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set - skipping email send.');
    return { skipped: true };
  }
  const from = process.env.FROM_EMAIL || 'onboarding@resend.dev';
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Resend API error (${resp.status}): ${detail}`);
  }
  return resp.json();
}

function siteBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  return `${proto}://${host}`;
}

module.exports = { sendMail, siteBaseUrl };
