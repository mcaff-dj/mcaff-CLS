// POST /api/onboarding/submit -> { answers: [{ id, text }, ...] }
// Grades a completed Onboarding Test attempt server-side (see api/_lib/onboardingAnswers.js)
// and returns only the marks awarded per question - never the expected answer/keywords, so a
// user can't learn the answer key from the response.
const { getSession } = require('../_lib/session');
const { QUESTIONS, POINTS_PER_QUESTION, gradeAnswer } = require('../_lib/onboardingAnswers');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (!(session.perms || []).includes('onboarding')) {
    res.status(403).json({ error: 'You do not have access to this test.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const submitted = (body && Array.isArray(body.answers)) ? body.answers : [];
  const answerById = {};
  submitted.forEach((a) => {
    if (a && typeof a.id !== 'undefined') answerById[a.id] = a.text;
  });

  const results = QUESTIONS.map((q) => ({
    id: q.id,
    score: gradeAnswer(q, answerById[q.id]),
    max: POINTS_PER_QUESTION,
  }));
  const total = results.reduce((sum, r) => sum + r.score, 0);
  const max = QUESTIONS.length * POINTS_PER_QUESTION;

  res.status(200).json({ total, max, results });
};
