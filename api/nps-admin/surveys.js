// GET  /api/nps-admin/surveys              -> list all surveys with question/recipient counts
// GET  /api/nps-admin/surveys?id=123        -> one survey + its ordered questions
// POST /api/nps-admin/surveys               body { name, questions: [{ type, questionText, options, required }] }
// PATCH /api/nps-admin/surveys              body { id, name?, status?, questions? }
//       (questions, if given, fully replaces the survey's question set - simplest correct
//       behaviour for a survey that hasn't been sent yet; editing an in-flight survey's
//       questions after responses exist is an ops judgment call, not blocked here)
const { getSession } = require('../_lib/session');
const { sql } = require('../_lib/db');

const CARD_KEY = 'nps';
const VALID_TYPES = ['score', 'csat', 'choice', 'text'];
const RANGE_CONDITION_TYPES = ['score', 'csat'];

function checkAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to NPS Survey Admin.';
  return null;
}

// A question's conditions may only reference an EARLIER question in the same list (by index) -
// no forward references, no cycles. 'range' conditions target a score/csat question's numeric
// answer; 'equals' conditions target a choice question's selected option.
function validateConditions(conditions, ownIndex, questions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return null;
  for (const c of conditions) {
    if (!Number.isInteger(c.questionIndex) || c.questionIndex < 0 || c.questionIndex >= ownIndex) {
      return 'A condition must reference an earlier question.';
    }
    const target = questions[c.questionIndex];
    if (c.type === 'range') {
      if (!RANGE_CONDITION_TYPES.includes(target.type)) return 'A range condition must target a score or CSAT question.';
      if (!Number.isFinite(c.min) || !Number.isFinite(c.max) || c.min > c.max) return 'Invalid condition range.';
    } else if (c.type === 'equals') {
      if (target.type !== 'choice') return 'An equals condition must target a choice question.';
      if (!target.options.includes(c.value)) return "A condition's value must be one of the target question's options.";
    } else {
      return `Invalid condition type: ${c.type}`;
    }
  }
  return null;
}

function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return 'At least one question is required.';
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!VALID_TYPES.includes(q.type)) return `Invalid question type: ${q.type}`;
    if (!q.questionText || !String(q.questionText).trim()) return 'Every question needs text.';
    if (q.type === 'choice' && (!Array.isArray(q.options) || q.options.length < 2)) {
      return 'Choice questions need at least 2 options.';
    }
    if (q.conditionLogic && q.conditionLogic !== 'AND' && q.conditionLogic !== 'OR') {
      return 'conditionLogic must be AND or OR.';
    }
    const condError = validateConditions(q.conditions, i, questions);
    if (condError) return condError;
  }
  return null;
}

async function insertQuestions(surveyId, questions) {
  const insertedIds = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const conditions = Array.isArray(q.conditions)
      ? q.conditions.map((c) => ({
          questionId: insertedIds[c.questionIndex],
          type: c.type,
          ...(c.type === 'range' ? { min: c.min, max: c.max } : { value: c.value }),
        }))
      : [];
    const { insertId } = await sql`
      INSERT INTO nps_question (survey_id, position, type, question_text, options_json, required, conditions_json, condition_logic)
      VALUES (${surveyId}, ${i}, ${q.type}, ${String(q.questionText).trim()},
              ${q.type === 'choice' ? JSON.stringify(q.options) : null}, ${q.required === false ? 0 : 1},
              ${conditions.length > 0 ? JSON.stringify(conditions) : null}, ${q.conditionLogic === 'OR' ? 'OR' : 'AND'})
    `;
    insertedIds.push(insertId);
  }
}

module.exports = async (req, res) => {
  const session = await getSession(req);
  const accessError = checkAccess(session);
  if (accessError) {
    res.status(session ? 403 : 401).json({ error: accessError });
    return;
  }

  if (req.method === 'GET') {
    const id = req.query.id ? Number(req.query.id) : null;
    if (id) {
      const { rows: surveys } = await sql`SELECT * FROM nps_survey WHERE id = ${id}`;
      if (!surveys[0]) { res.status(404).json({ error: 'Survey not found' }); return; }
      const { rows: questions } = await sql`
        SELECT id, position, type, question_text, options_json, required, conditions_json, condition_logic
        FROM nps_question WHERE survey_id = ${id} ORDER BY position ASC
      `;
      res.status(200).json({
        survey: surveys[0],
        questions: questions.map((q) => ({
          ...q,
          options: q.options_json ? JSON.parse(q.options_json) : null,
          conditions: q.conditions_json ? JSON.parse(q.conditions_json) : [],
        })),
      });
      return;
    }

    const { rows: surveys } = await sql`
      SELECT s.id, s.name, s.status, s.created_by, s.created_at,
        (SELECT COUNT(*) FROM nps_question q WHERE q.survey_id = s.id) AS question_count,
        (SELECT COUNT(*) FROM nps_recipient r WHERE r.survey_id = s.id) AS recipient_count,
        (SELECT COUNT(*) FROM nps_recipient r WHERE r.survey_id = s.id AND r.status = 'responded') AS responded_count
      FROM nps_survey s ORDER BY s.created_at DESC
    `;
    res.status(200).json({ surveys });
    return;
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) { res.status(400).json({ error: 'Survey name is required.' }); return; }
    const qError = validateQuestions(body.questions);
    if (qError) { res.status(400).json({ error: qError }); return; }

    const { insertId } = await sql`INSERT INTO nps_survey (name, created_by) VALUES (${name}, ${session.email})`;
    await insertQuestions(insertId, body.questions);
    res.status(200).json({ ok: true, id: insertId });
    return;
  }

  if (req.method === 'PATCH') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const id = Number(body.id);
    if (!id) { res.status(400).json({ error: 'Survey id is required.' }); return; }
    const { rows: existing } = await sql`SELECT id FROM nps_survey WHERE id = ${id}`;
    if (!existing[0]) { res.status(404).json({ error: 'Survey not found' }); return; }

    if (typeof body.name === 'string' && body.name.trim()) {
      await sql`UPDATE nps_survey SET name = ${body.name.trim()} WHERE id = ${id}`;
    }
    if (body.status === 'active' || body.status === 'archived') {
      await sql`UPDATE nps_survey SET status = ${body.status} WHERE id = ${id}`;
    }
    if (body.questions) {
      const qError = validateQuestions(body.questions);
      if (qError) { res.status(400).json({ error: qError }); return; }
      await sql`DELETE FROM nps_question WHERE survey_id = ${id}`;
      await insertQuestions(id, body.questions);
    }
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
