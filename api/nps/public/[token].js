// GET  /api/nps/public/:token  -> survey + questions for this link, or the link's own state
//                                  ({ status: 'expired' | 'invalid' | 'already_responded' | 'ok' })
// POST /api/nps/public/:token   body { answers: [{ questionId, value }] } -> records the response
//
// Genuinely unauthenticated - no cookie session at all. The signed token (api/_lib/npsToken.js)
// is the only authorization: it proves which recipient this link was issued to and that it
// hasn't expired. Anyone with the link can view/answer once; that's the intended shape of a
// survey link shared over WhatsApp.
const { sql } = require('../../_lib/db');
const { verifyNpsToken } = require('../../_lib/npsToken');
const { validateAnswers } = require('../../_lib/npsAnswers');
const { conditionsMet } = require('../../_lib/npsConditions');

async function loadRecipientAndQuestions(recipientId) {
  const { rows: recipients } = await sql`SELECT id, survey_id FROM nps_recipient WHERE id = ${recipientId}`;
  const recipient = recipients[0];
  if (!recipient) return null;
  const { rows: surveys } = await sql`SELECT id, name FROM nps_survey WHERE id = ${recipient.survey_id}`;
  const { rows: rawQuestions } = await sql`
    SELECT id, position, type, question_text, options_json, required, conditions_json, condition_logic
    FROM nps_question WHERE survey_id = ${recipient.survey_id} ORDER BY position ASC
  `;
  const questions = rawQuestions.map((q) => ({
    id: q.id, position: q.position, type: q.type, question_text: q.question_text, required: q.required,
    options: q.options_json ? JSON.parse(q.options_json) : null,
    conditions: q.conditions_json ? JSON.parse(q.conditions_json) : [],
    conditionLogic: q.condition_logic,
  }));
  return { recipient, survey: surveys[0], questions };
}

module.exports = async (req, res) => {
  const result = verifyNpsToken(req.query.token);
  if (!result.valid) {
    res.status(result.expired ? 403 : 400).json({ status: result.expired ? 'expired' : 'invalid' });
    return;
  }
  const recipientId = result.payload.recipientId;

  const { rows: existingResponse } = await sql`SELECT id FROM nps_response WHERE recipient_id = ${recipientId}`;

  if (req.method === 'GET') {
    if (existingResponse[0]) { res.status(200).json({ status: 'already_responded' }); return; }
    const data = await loadRecipientAndQuestions(recipientId);
    if (!data || !data.survey) { res.status(400).json({ status: 'invalid' }); return; }
    res.status(200).json({
      status: 'ok',
      survey: { id: data.survey.id, name: data.survey.name },
      questions: data.questions,
    });
    return;
  }

  if (req.method === 'POST') {
    if (existingResponse[0]) { res.status(409).json({ error: 'This survey has already been submitted.' }); return; }

    const data = await loadRecipientAndQuestions(recipientId);
    if (!data || !data.survey) { res.status(400).json({ status: 'invalid' }); return; }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const answers = Array.isArray((body || {}).answers) ? body.answers : [];

    const validation = validateAnswers(data.questions, answers);
    if (!validation.valid) { res.status(400).json({ error: validation.error }); return; }

    let insertId;
    try {
      ({ insertId } = await sql`INSERT INTO nps_response (recipient_id) VALUES (${recipientId})`);
    } catch (e) {
      // UNIQUE(recipient_id) racing a second submit lands here - same outcome as the
      // pre-check above, just closing the window between the SELECT and this INSERT.
      res.status(409).json({ error: 'This survey has already been submitted.' });
      return;
    }

    // Only store an answer for a question whose own conditions are actually met by the rest of
    // the submission - guards against a tampered request smuggling in a follow-up answer for a
    // question the customer was never shown.
    const rawByQuestionId = Object.fromEntries(answers.map((a) => [Number(a.questionId), a.value]));
    const questionsById = new Map(data.questions.map((q) => [q.id, q]));
    for (const a of answers) {
      const questionId = Number(a.questionId);
      const question = questionsById.get(questionId);
      if (!question) continue;
      if (!conditionsMet(question.conditions, question.conditionLogic, rawByQuestionId)) continue;
      await sql`INSERT INTO nps_response_answer (response_id, question_id, answer_value) VALUES (${insertId}, ${questionId}, ${String(a.value)})`;
    }
    await sql`UPDATE nps_recipient SET status = 'responded' WHERE id = ${recipientId}`;

    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
