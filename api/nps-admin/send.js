// POST /api/nps-admin/send   body { surveyId, recipientIds?: number[] }
// Sends (or re-sends) the WhatsApp survey link to recipients of a survey. Without
// recipientIds, targets every 'pending' recipient for that survey; with recipientIds, targets
// exactly those (used for re-sending to 'failed' ones). Same code path serves both the manual
// "Send" button and the future Shiprocket cron trigger (scripts/nps_shiprocket_trigger.py) -
// this file is the one place that knows how to build a link and call sendWhatsApp.
const { getSession } = require('../_lib/session');
const { sql } = require('../_lib/db');
const { signNpsToken } = require('../_lib/npsToken');
const { sendWhatsApp } = require('../_lib/npsWhatsapp');

const CARD_KEY = 'nps';
const TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days
// ponytail: one Lambda invocation sends synchronously, capped so a huge pending backlog
// can't run past Lambda's timeout. Re-running "Send" picks up the rest (still 'pending').
// Upgrade path if this becomes a real limit: move sending to an SQS-fed queue.
const MAX_SEND_BATCH = 300;

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to NPS Survey Admin.';
  return null;
}

function buildLink(recipientId) {
  const base = process.env.NPS_PUBLIC_BASE_URL;
  if (!base) throw new Error('Missing NPS_PUBLIC_BASE_URL env var');
  const token = signNpsToken({ recipientId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS });
  return `${base.replace(/\/+$/, '')}/nps/${token}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const session = await getSession(req);
  const accessError = checkAccess(session);
  if (accessError) {
    res.status(session ? 403 : 401).json({ error: accessError });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const surveyId = Number(body.surveyId);
  if (!surveyId) { res.status(400).json({ error: 'surveyId is required.' }); return; }

  const { rows: surveys } = await sql`SELECT id, name FROM nps_survey WHERE id = ${surveyId}`;
  const survey = surveys[0];
  if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

  const recipientIds = Array.isArray(body.recipientIds) ? body.recipientIds.map(Number).filter(Boolean) : null;

  // mysql2's tagged template doesn't expand an array into "IN (?,?,?)" - fetch all of the
  // survey's recipients and filter in JS rather than hand-building IN-clause SQL.
  let targets;
  if (recipientIds && recipientIds.length > 0) {
    const { rows: all } = await sql`SELECT id, phone FROM nps_recipient WHERE survey_id = ${surveyId}`;
    targets = all.filter((r) => recipientIds.includes(r.id));
  } else {
    const { rows: pending } = await sql`SELECT id, phone FROM nps_recipient WHERE survey_id = ${surveyId} AND status = 'pending'`;
    targets = pending;
  }

  const capped = targets.slice(0, MAX_SEND_BATCH);
  let sent = 0;
  let failed = 0;
  for (const recipient of capped) {
    try {
      const link = buildLink(recipient.id);
      const message = `We'd love your feedback! Please take a moment to answer "${survey.name}": ${link}`;
      await sendWhatsApp(recipient.phone, message);
      await sql`UPDATE nps_recipient SET status = 'sent', sent_at = NOW() WHERE id = ${recipient.id}`;
      sent++;
    } catch (e) {
      await sql`UPDATE nps_recipient SET status = 'failed' WHERE id = ${recipient.id}`;
      failed++;
    }
  }

  res.status(200).json({ ok: true, sent, failed, remaining: targets.length - capped.length });
};
