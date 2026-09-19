// "Open with Google Docs" for the Org Overview report tabs (currently KYC Trends).
// Converts the same markup the print/PDF path renders into a real Google Doc via the
// Drive API's HTML import, shares it with the requesting user, and hands back the
// edit link - so the button opens a live, editable doc instead of a file the user has
// to download and import into Drive by hand.
//
// Reuses the Sheets service-account credential (GOOGLE_SHEETS_CLIENT_EMAIL /
// GOOGLE_SHEETS_PRIVATE_KEY - see api/rto/sheet.js) with an extra 'drive.file' scope,
// rather than provisioning a second credential for one more Google product.
//
// Two things this needs beyond what Sheets already has, both one-time setup in Google
// Cloud/Workspace admin (not something this code can do for itself):
//   1. Enable the Google Drive API on the same GCP project the Sheets API lives on.
//   2. A bare service account has had zero Drive storage quota of its own since
//      Google's 2021 policy change, so it cannot create a file in "My Drive". It needs
//      a Shared Drive to create into instead (storage there comes from the Shared
//      Drive's pooled quota, not the service account's). Create/reuse a Shared Drive,
//      add the service account email as a Content Manager, and set that Shared
//      Drive's ID as GOOGLE_DOCS_SHARED_DRIVE_ID.
// Missing either shows up as a named 500 below rather than a silent failure.
const { JWT } = require('google-auth-library');
const { getSession } = require('../_lib/session');

const CARD_KEY = 'orgoverview';
const MAX_HTML_BYTES = 4 * 1024 * 1024;

let _client = null;
function getClient() {
  if (_client) return _client;
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars');
  _client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/drive.file'] });
  return _client;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Google's HTML-import reads a <style> block in <head> for the common properties
// (borders, padding, color, font-weight, text-align) but never fetches an external
// stylesheet - the report's own CSS classes (og-table, og-card, ...) mean nothing to it
// without this, so every table would land as unstyled, unbordered text.
function wrapDoc(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<style>
      body { font-family: Arial, sans-serif; font-size: 10pt; color: #111; }
      h2 { font-size: 16pt; margin: 0 0 6px; }
      h3, .og-section-title { font-size: 12pt; color: #4a3aa7; margin: 18px 0 8px; }
      .og-card-title { font-size: 11pt; font-weight: 700; margin: 14px 0 4px; }
      p, .og-note, .og-card-sub { font-size: 9.5pt; color: #444; }
      table { border-collapse: collapse; width: 100%; margin: 6px 0 16px; }
      th, td { border: 1px solid #999; padding: 4px 7px; font-size: 9pt; text-align: right; }
      th:first-child, td:first-child, .og-rowlabel, .og-wrap-cell { text-align: left; }
      th { background: #362a7d; color: #fff; font-weight: 700; }
      li { font-size: 9.5pt; margin-bottom: 4px; }
    </style></head><body>${bodyHtml}</body></html>`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (!(session.perms || []).includes(CARD_KEY)) {
    res.status(403).json({ error: 'You do not have access to Org Overview.' });
    return;
  }

  const html = (req.body || {}).html;
  const title = String((req.body || {}).title || 'KYC Complaint Trends').slice(0, 200);
  if (!html || typeof html !== 'string') {
    res.status(400).json({ error: 'Missing html' });
    return;
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    res.status(413).json({ error: 'Report content too large to export' });
    return;
  }

  const sharedDriveId = process.env.GOOGLE_DOCS_SHARED_DRIVE_ID;
  if (!sharedDriveId) {
    res.status(500).json({ error: 'Missing GOOGLE_DOCS_SHARED_DRIVE_ID env var - see this file\'s header comment for setup.' });
    return;
  }

  let token;
  try {
    const client = getClient();
    ({ token } = await client.getAccessToken());
  } catch (e) {
    res.status(500).json({ error: 'Google credentials not configured: ' + (e.message || e) });
    return;
  }

  const boundary = `orgoverview-doc-${Date.now()}`;
  const metadata = { name: title, mimeType: 'application/vnd.google-apps.document', parents: [sharedDriveId] };
  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\n\r\n` +
    `${wrapDoc(title, html)}\r\n` +
    `--${boundary}--`;

  try {
    const createResp = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipartBody,
      }
    );
    const created = await createResp.json().catch(() => ({}));
    if (!createResp.ok || !created.id) {
      res.status(createResp.status || 500).json({ error: (created.error && created.error.message) || 'Google Drive rejected the doc' });
      return;
    }

    const shareResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${created.id}/permissions?supportsAllDrives=true&sendNotificationEmail=false`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: session.email }),
      }
    );
    if (!shareResp.ok) {
      const err = await shareResp.json().catch(() => ({}));
      res.status(shareResp.status).json({ error: (err.error && err.error.message) || 'Doc created but could not be shared with you' });
      return;
    }

    res.status(200).json({ url: created.webViewLink || `https://docs.google.com/document/d/${created.id}/edit` });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
};
