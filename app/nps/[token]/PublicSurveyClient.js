'use client';

// The one genuinely public, unauthenticated page in this app - reached via a WhatsApp link,
// no login involved. The signed token in the URL (see api/_lib/npsToken.js) is the only
// authorization; api/nps/public/[token].js is the sole API surface it talks to.
import { useState, useEffect } from 'react';

function ScoreInput({ value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {Array.from({ length: 11 }, (_, n) => n).map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(String(n))}
          className={`w-8 h-8 rounded-lg text-sm font-semibold border ${value === String(n) ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-zinc-300 text-zinc-700'}`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

function ChoiceInput({ options, value, onChange }) {
  return (
    <div className="space-y-1.5">
      {(options || []).map((opt) => (
        <label key={opt} className={`flex items-center gap-2 border rounded-lg px-3 py-2 text-sm cursor-pointer ${value === opt ? 'border-indigo-500 bg-indigo-50' : 'border-zinc-300'}`}>
          <input type="radio" name="choice" checked={value === opt} onChange={() => onChange(opt)} />
          {opt}
        </label>
      ))}
    </div>
  );
}

export default function PublicSurveyClient({ token }) {
  const [state, setState] = useState('loading'); // loading | invalid | expired | already_responded | ok | submitted
  const [survey, setSurvey] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/nps/public/${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.status === 'ok') {
          setSurvey(d.survey);
          setQuestions(d.questions);
          setState('ok');
        } else {
          setState(d.status || 'invalid');
        }
      })
      .catch(() => setState('invalid'));
  }, [token]);

  function setAnswer(questionId, value) {
    setAnswers((a) => ({ ...a, [questionId]: value }));
  }

  async function submit() {
    setError('');
    const missing = questions.find((q) => q.required && !answers[q.id]);
    if (missing) { setError('Please answer every required question.'); return; }

    setSubmitting(true);
    try {
      const r = await fetch(`/api/nps/public/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: Object.entries(answers).map(([questionId, value]) => ({ questionId: Number(questionId), value })) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not submit. Please try again.');
      setState('submitted');
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  const Shell = ({ children }) => (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg bg-white border border-zinc-200 rounded-2xl shadow-sm p-6 space-y-4">
        {children}
      </div>
    </div>
  );

  if (state === 'loading') return <Shell><p className="text-zinc-500 text-sm">Loading...</p></Shell>;
  if (state === 'invalid') return <Shell><p className="text-zinc-700 font-semibold">This link isn&apos;t valid.</p></Shell>;
  if (state === 'expired') return <Shell><p className="text-zinc-700 font-semibold">This link has expired.</p></Shell>;
  if (state === 'already_responded') return <Shell><p className="text-zinc-700 font-semibold">You&apos;ve already submitted this survey. Thank you!</p></Shell>;
  if (state === 'submitted') return <Shell><p className="text-zinc-700 font-semibold">Thank you for your feedback!</p></Shell>;

  return (
    <Shell>
      <h1 className="text-lg font-bold text-zinc-900">{survey.name}</h1>
      {questions.map((q) => (
        <div key={q.id} className="space-y-2">
          <p className="text-sm font-medium text-zinc-800">{q.question_text}{q.required ? ' *' : ''}</p>
          {q.type === 'score' && <ScoreInput value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
          {q.type === 'choice' && <ChoiceInput options={q.options} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
          {q.type === 'text' && (
            <textarea
              className="w-full border border-zinc-300 rounded-lg px-3 py-2 text-sm"
              rows={3}
              value={answers[q.id] || ''}
              onChange={(e) => setAnswer(q.id, e.target.value)}
            />
          )}
        </div>
      ))}
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={submitting}
        className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold disabled:opacity-50"
      >
        {submitting ? 'Submitting...' : 'Submit'}
      </button>
    </Shell>
  );
}
