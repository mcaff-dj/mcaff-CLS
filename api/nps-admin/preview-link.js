// GET /api/nps-admin/preview-link?surveyId=123 -> { link } for the admin to open the public
// form themselves, without uploading a real recipient or sending WhatsApp. Reuses (rather
// than recreates) one 'preview' recipient row per survey, so repeated clicks don't pile up
// rows in the recipients table - it's excluded from bulk sends (see api/nps-admin/send.js).
const { getSession } = require('../_lib/session');
const { sql } = require('../_lib/db');
const { buildNpsLink } = require('../_lib/npsToken');

const CARD_KEY = 'nps';

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to NPS Survey Admin.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const session = await getSession(req);
  const accessError = checkAccess(session);
  if (accessError) {
    res.status(session ? 403 : 401).json({ error: accessError });
    return;
  }

  const surveyId = Number(req.query.surveyId);
  if (!surveyId) { res.status(400).json({ error: 'surveyId is required.' }); return; }
  const { rows: surveys } = await sql`SELECT id FROM nps_survey WHERE id = ${surveyId}`;
  if (!surveys[0]) { res.status(404).json({ error: 'Survey not found' }); return; }

  const { rows: existing } = await sql`
    SELECT id FROM nps_recipient WHERE survey_id = ${surveyId} AND trigger_source = 'preview'
  `;
  const recipientId = existing[0]
    ? existing[0].id
    : (await sql`
        INSERT INTO nps_recipient (survey_id, name, phone, trigger_source, status)
        VALUES (${surveyId}, 'Preview', '__preview__', 'preview', 'pending')
      `).insertId;

  // Reset any prior test submission on this same preview recipient - otherwise the second
  // "Preview form" click would permanently show "already submitted" instead of the form,
  // since a recipient can only respond once (see api/nps/public/[token].js).
  const { rows: priorResponses } = await sql`SELECT id FROM nps_response WHERE recipient_id = ${recipientId}`;
  for (const r of priorResponses) {
    await sql`DELETE FROM nps_response_answer WHERE response_id = ${r.id}`;
    await sql`DELETE FROM nps_response WHERE id = ${r.id}`;
  }
  if (priorResponses.length > 0) {
    await sql`UPDATE nps_recipient SET status = 'pending' WHERE id = ${recipientId}`;
  }

  res.status(200).json({ link: buildNpsLink(recipientId) });
};
