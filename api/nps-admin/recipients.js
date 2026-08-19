// GET  /api/nps-admin/recipients?surveyId=123  -> recipient list + status for that survey
// POST /api/nps-admin/recipients                body { surveyId, recipients: [{ name, phone, email, orderRef }] }
//      manual bulk upload; each row needs at least a phone (the only channel wired up in v1).
const { getSession } = require('../_lib/session');
const { sql } = require('../_lib/db');

const CARD_KEY = 'nps';
// Backstop against an accidentally-huge paste hammering the 5-connection MySQL pool with
// one INSERT per row - same guard shape as delivery-escalation's bulk dispose.
const MAX_BULK_ROWS = 2000;

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to NPS Survey Admin.';
  return null;
}

module.exports = async (req, res) => {
  const session = await getSession(req);
  const accessError = checkAccess(session);
  if (accessError) {
    res.status(session ? 403 : 401).json({ error: accessError });
    return;
  }

  if (req.method === 'GET') {
    const surveyId = Number(req.query.surveyId);
    if (!surveyId) { res.status(400).json({ error: 'surveyId is required.' }); return; }
    const { rows } = await sql`
      SELECT id, name, phone, email, trigger_source, order_ref, status, sent_at, created_at
      FROM nps_recipient WHERE survey_id = ${surveyId} ORDER BY created_at DESC
    `;
    res.status(200).json({ recipients: rows });
    return;
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const surveyId = Number(body.surveyId);
    if (!surveyId) { res.status(400).json({ error: 'surveyId is required.' }); return; }
    const { rows: survey } = await sql`SELECT id FROM nps_survey WHERE id = ${surveyId}`;
    if (!survey[0]) { res.status(404).json({ error: 'Survey not found' }); return; }

    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    if (recipients.length === 0) { res.status(400).json({ error: 'At least one recipient is required.' }); return; }
    if (recipients.length > MAX_BULK_ROWS) {
      res.status(400).json({ error: `Too many rows - max ${MAX_BULK_ROWS} per upload.` });
      return;
    }
    const withoutPhone = recipients.filter((r) => !r.phone || !String(r.phone).trim());
    if (withoutPhone.length > 0) {
      res.status(400).json({ error: `${withoutPhone.length} row(s) are missing a phone number.` });
      return;
    }

    let inserted = 0;
    for (const r of recipients) {
      await sql`
        INSERT INTO nps_recipient (survey_id, name, phone, email, trigger_source, order_ref, status)
        VALUES (${surveyId}, ${r.name || null}, ${String(r.phone).trim()}, ${r.email || null}, 'manual', ${r.orderRef || null}, 'pending')
      `;
      inserted++;
    }
    res.status(200).json({ ok: true, inserted });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
