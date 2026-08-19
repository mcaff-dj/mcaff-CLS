// GET /api/nps-admin/dashboard?surveyId=123 -> aggregate NPS score (from the survey's first
// 'score' question) + per-recipient status + each responded recipient's answers.
const { getSession } = require('../_lib/session');
const { sql } = require('../_lib/db');
const { computeNpsAggregate } = require('../_lib/npsScore');
const { computeCsatAggregate } = require('../_lib/npsCsat');

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

  const { rows: questions } = await sql`
    SELECT id, type, question_text FROM nps_question WHERE survey_id = ${surveyId} ORDER BY position ASC
  `;
  const scoreQuestion = questions.find((q) => q.type === 'score');
  const csatQuestion = questions.find((q) => q.type === 'csat');

  const { rows: statusCounts } = await sql`
    SELECT status, COUNT(*) AS n FROM nps_recipient WHERE survey_id = ${surveyId} GROUP BY status
  `;

  const { rows: answers } = await sql`
    SELECT a.question_id, a.answer_value, r.recipient_id, resp.submitted_at
    FROM nps_response_answer a
    JOIN nps_response resp ON resp.id = a.response_id
    JOIN nps_recipient r ON r.id = resp.recipient_id
    WHERE r.survey_id = ${surveyId}
  `;

  const numericAnswersFor = (question) => question
    ? answers.filter((a) => a.question_id === question.id).map((a) => Number(a.answer_value)).filter((n) => Number.isFinite(n))
    : [];
  const scores = numericAnswersFor(scoreQuestion);
  const csatScores = numericAnswersFor(csatQuestion);

  // Group answers by recipient for the admin's per-response detail view.
  const byRecipient = {};
  for (const a of answers) {
    if (!byRecipient[a.recipient_id]) byRecipient[a.recipient_id] = { recipientId: a.recipient_id, submittedAt: a.submitted_at, answers: [] };
    byRecipient[a.recipient_id].answers.push({ questionId: a.question_id, value: a.answer_value });
  }

  res.status(200).json({
    statusCounts: Object.fromEntries(statusCounts.map((s) => [s.status, s.n])),
    nps: computeNpsAggregate(scores),
    csat: computeCsatAggregate(csatScores),
    questions,
    responses: Object.values(byRecipient),
  });
};
