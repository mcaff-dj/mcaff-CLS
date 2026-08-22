'use client';

// NPS Survey Admin - build a configurable survey (score/choice/text questions), bulk-upload
// recipients, trigger the WhatsApp send, and watch responses land. Gated by the 'nps'
// permission (see api/_lib/db.js CARD_KEYS), same access model as every other card here.
import { useState, useEffect, useCallback } from 'react';

const QUESTION_TYPES = [
  { value: 'score', label: 'Score (0-10, NPS)' },
  { value: 'csat', label: 'CSAT (1-5)' },
  { value: 'choice', label: 'Multiple choice' },
  { value: 'text', label: 'Free text' },
];

// Only these types make sense as a follow-up question's trigger: a score/csat answer is a
// number to range-check, a choice answer is one of a fixed set to equality-check. A free-text
// answer has no structured value to condition on.
const CONDITIONABLE_TYPES = ['score', 'csat', 'choice'];

function optionsList(q) {
  return (q.options || '').split(',').map((o) => o.trim()).filter(Boolean);
}

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

function emptyQuestion() {
  return { type: 'score', questionText: '', options: '', required: true, conditions: [], conditionLogic: 'AND' };
}

function emptyCondition(targetIndex, targetType) {
  return targetType === 'choice'
    ? { questionIndex: targetIndex, type: 'equals', value: '' }
    : { questionIndex: targetIndex, type: 'range', min: 0, max: 10 };
}

function ConditionEditor({ questions, idx, onChange }) {
  const q = questions[idx];
  const priorTargets = questions
    .map((pq, i) => ({ ...pq, index: i }))
    .slice(0, idx)
    .filter((pq) => CONDITIONABLE_TYPES.includes(pq.type));

  if (priorTargets.length === 0) return null;

  const conditions = q.conditions || [];

  function updateCondition(cIdx, patch) {
    onChange({ conditions: conditions.map((c, i) => (i === cIdx ? { ...c, ...patch } : c)) });
  }

  return (
    <div className="border-t border-zinc-800 pt-2 space-y-2">
      <p className="text-xs text-zinc-500">Show this question only if:</p>
      {conditions.map((c, cIdx) => {
        const target = questions[c.questionIndex];
        return (
          <div key={cIdx} className="flex flex-wrap items-center gap-2 text-xs">
            <select
              className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-zinc-100"
              value={c.questionIndex}
              onChange={(e) => {
                const newTarget = questions[Number(e.target.value)];
                updateCondition(cIdx, emptyCondition(Number(e.target.value), newTarget.type));
              }}
            >
              {priorTargets.map((t) => <option key={t.index} value={t.index}>Q{t.index + 1}: {t.questionText || '(untitled)'}</option>)}
            </select>
            {(target.type === 'score' || target.type === 'csat') ? (
              <>
                <span className="text-zinc-500">between</span>
                <input type="number" className="w-14 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-zinc-100"
                  value={c.min} onChange={(e) => updateCondition(cIdx, { min: Number(e.target.value) })} />
                <span className="text-zinc-500">and</span>
                <input type="number" className="w-14 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-zinc-100"
                  value={c.max} onChange={(e) => updateCondition(cIdx, { max: Number(e.target.value) })} />
              </>
            ) : (
              <>
                <span className="text-zinc-500">equals</span>
                <select className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-zinc-100"
                  value={c.value} onChange={(e) => updateCondition(cIdx, { value: e.target.value })}>
                  <option value="">choose...</option>
                  {optionsList(target).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </>
            )}
            <button type="button" className="text-rose-400 hover:text-rose-300"
              onClick={() => onChange({ conditions: conditions.filter((_, i) => i !== cIdx) })}>
              Remove
            </button>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="text-xs text-indigo-400 hover:text-indigo-300"
          onClick={() => onChange({ conditions: [...conditions, emptyCondition(priorTargets[0].index, priorTargets[0].type)] })}
        >
          + Add condition
        </button>
        {conditions.length > 1 && (
          <select
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100"
            value={q.conditionLogic}
            onChange={(e) => onChange({ conditionLogic: e.target.value })}
          >
            <option value="AND">Match ALL conditions</option>
            <option value="OR">Match ANY condition</option>
          </select>
        )}
      </div>
    </div>
  );
}

function NewSurveyForm({ onCreated }) {
  const [name, setName] = useState('');
  const [questions, setQuestions] = useState([emptyQuestion()]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function updateQuestion(idx, patch) {
    setQuestions((qs) => qs.map((q, i) => (i === idx ? { ...q, ...patch } : q)));
  }

  // ponytail: removing/reordering a question doesn't try to auto-fix a LATER question's type
  // (e.g. a condition targeting a 'choice' question whose type was since changed to 'text') -
  // create-survey submit surfaces the server's validation error in that case; add smarter
  // repair if this trips people up in practice.
  function removeQuestion(removedIdx) {
    setQuestions((qs) => qs
      .filter((_, i) => i !== removedIdx)
      .map((q) => ({
        ...q,
        conditions: (q.conditions || [])
          .filter((c) => c.questionIndex !== removedIdx)
          .map((c) => (c.questionIndex > removedIdx ? { ...c, questionIndex: c.questionIndex - 1 } : c)),
      })));
  }

  async function submit() {
    setError('');
    if (!name.trim()) { setError('Survey name is required.'); return; }
    const payload = questions.map((q) => ({
      type: q.type,
      questionText: q.questionText,
      required: q.required,
      options: q.type === 'choice' ? optionsList(q) : undefined,
      conditions: (q.conditions || []).length > 0 ? q.conditions : undefined,
      conditionLogic: q.conditionLogic,
    }));
    setSaving(true);
    try {
      await getJson('/api/nps-admin/surveys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), questions: payload }),
      });
      setName('');
      setQuestions([emptyQuestion()]);
      onCreated();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-5 space-y-4">
      <h2 className="text-base font-bold text-zinc-100">New survey</h2>
      {error && <div className="text-sm text-rose-400">{error}</div>}
      <input
        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100"
        placeholder="Survey name (e.g. Post-delivery NPS)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="space-y-3">
        {questions.map((q, idx) => (
          <div key={idx} className="border border-zinc-800 rounded-xl p-3 space-y-2">
            <div className="flex gap-2">
              <select
                className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100"
                value={q.type}
                onChange={(e) => updateQuestion(idx, { type: e.target.value })}
              >
                {QUESTION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                <input type="checkbox" checked={q.required} onChange={(e) => updateQuestion(idx, { required: e.target.checked })} />
                Required
              </label>
              <button
                type="button"
                className="ml-auto text-xs text-rose-400 hover:text-rose-300"
                onClick={() => removeQuestion(idx)}
                disabled={questions.length === 1}
              >
                Remove
              </button>
            </div>
            <input
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100"
              placeholder="Question text"
              value={q.questionText}
              onChange={(e) => updateQuestion(idx, { questionText: e.target.value })}
            />
            {q.type === 'choice' && (
              <input
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100"
                placeholder="Options, comma-separated (e.g. Great, Okay, Bad)"
                value={q.options}
                onChange={(e) => updateQuestion(idx, { options: e.target.value })}
              />
            )}
            <ConditionEditor questions={questions} idx={idx} onChange={(patch) => updateQuestion(idx, patch)} />
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className="text-sm text-indigo-400 hover:text-indigo-300"
          onClick={() => setQuestions((qs) => [...qs, emptyQuestion()])}
        >
          + Add question
        </button>
        <button
          type="button"
          className="ml-auto px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold disabled:opacity-50"
          onClick={submit}
          disabled={saving}
        >
          {saving ? 'Creating...' : 'Create survey'}
        </button>
      </div>
    </div>
  );
}

function RecipientUpload({ surveyId, onUploaded }) {
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function upload() {
    setError('');
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const recipients = lines.map((line) => {
      const [name, phone, email, orderRef] = line.split(',').map((s) => (s || '').trim());
      return { name, phone, email, orderRef };
    });
    if (recipients.length === 0) { setError('Paste at least one row.'); return; }
    setBusy(true);
    try {
      const d = await getJson('/api/nps-admin/recipients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surveyId, recipients }),
      });
      setRaw('');
      onUploaded(d.inserted);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500">One per line: name, phone, email (optional), order ref (optional)</p>
      <textarea
        className="w-full h-24 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 font-mono"
        placeholder={'Jane Doe, 919876543210, jane@example.com, ORD123'}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      {error && <div className="text-sm text-rose-400">{error}</div>}
      <button
        type="button"
        className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm disabled:opacity-50"
        onClick={upload}
        disabled={busy}
      >
        {busy ? 'Uploading...' : 'Upload recipients'}
      </button>
    </div>
  );
}

function SurveyDetail({ surveyId, onBack }) {
  const [survey, setSurvey] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [sendStatus, setSendStatus] = useState('');
  const [error, setError] = useState('');
  const [previewLink, setPreviewLink] = useState('');
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      getJson(`/api/nps-admin/surveys?id=${surveyId}`),
      getJson(`/api/nps-admin/recipients?surveyId=${surveyId}`),
      getJson(`/api/nps-admin/dashboard?surveyId=${surveyId}`),
    ]).then(([s, r, d]) => {
      setSurvey(s);
      setRecipients(r.recipients);
      setDashboard(d);
    }).catch((e) => setError(e.message));
  }, [surveyId]);

  useEffect(() => { load(); }, [load]);

  async function openPreview() {
    setPreviewing(true);
    setError('');
    try {
      const d = await getJson(`/api/nps-admin/preview-link?surveyId=${surveyId}`);
      setPreviewLink(d.link);
      window.open(d.link, '_blank', 'noopener');
    } catch (e) {
      setError(e.message);
    } finally {
      setPreviewing(false);
    }
  }

  async function send() {
    setSendStatus('Sending...');
    setError('');
    try {
      const d = await getJson('/api/nps-admin/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surveyId }),
      });
      setSendStatus(`Sent ${d.sent}, failed ${d.failed}${d.remaining ? `, ${d.remaining} left for next run` : ''}.`);
      load();
    } catch (e) {
      setSendStatus('');
      setError(e.message);
    }
  }

  if (!survey) return <div className="text-zinc-500 text-sm">{error || 'Loading...'}</div>;

  return (
    <div className="space-y-4">
      <button type="button" className="text-sm text-indigo-400 hover:text-indigo-300" onClick={onBack}>&larr; All surveys</button>
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-5 space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-zinc-100">{survey.survey.name}</h2>
            <p className="text-xs text-zinc-500">{survey.survey.status} - {survey.questions.length} question(s)</p>
          </div>
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm disabled:opacity-50"
            onClick={openPreview}
            disabled={previewing}
          >
            {previewing ? 'Loading...' : 'Preview form'}
          </button>
        </div>
        {previewLink && (
          <p className="text-xs text-zinc-500 break-all">
            Opened in a new tab - link: <span className="text-zinc-400">{previewLink}</span>
          </p>
        )}
      </div>

      {dashboard && (
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div><p className="text-xs text-zinc-500">NPS score</p><p className="text-2xl font-bold text-zinc-100">{dashboard.nps.total ? dashboard.nps.nps : '—'}</p></div>
          {dashboard.csat.total > 0 && (
            <div><p className="text-xs text-zinc-500">CSAT</p><p className="text-2xl font-bold text-zinc-100">{dashboard.csat.satisfiedPct}%</p></div>
          )}
          <div><p className="text-xs text-zinc-500">Sent</p><p className="text-2xl font-bold text-zinc-100">{dashboard.statusCounts.sent || 0}</p></div>
          <div><p className="text-xs text-zinc-500">Responded</p><p className="text-2xl font-bold text-zinc-100">{dashboard.statusCounts.responded || 0}</p></div>
          <div><p className="text-xs text-zinc-500">Failed</p><p className="text-2xl font-bold text-zinc-100">{dashboard.statusCounts.failed || 0}</p></div>
        </div>
      )}

      <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-5 space-y-3">
        <h3 className="text-sm font-bold text-zinc-100">Recipients</h3>
        <RecipientUpload surveyId={surveyId} onUploaded={load} />
        {error && <div className="text-sm text-rose-400">{error}</div>}
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold"
            onClick={send}
          >
            Send to pending
          </button>
          {sendStatus && <span className="text-xs text-zinc-400">{sendStatus}</span>}
        </div>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-zinc-500 text-xs"><th className="py-1">Name</th><th>Phone</th><th>Status</th><th>Source</th></tr></thead>
          <tbody>
            {recipients.map((r) => (
              <tr key={r.id} className="border-t border-zinc-800 text-zinc-300">
                <td className="py-1">{r.name || '—'}</td>
                <td>{r.phone}</td>
                <td>{r.status}</td>
                <td>{r.trigger_source}</td>
              </tr>
            ))}
            {recipients.length === 0 && <tr><td className="py-2 text-zinc-500" colSpan={4}>No recipients yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function NpsAdminClient() {
  const [authState, setAuthState] = useState('checking'); // checking | denied | ok
  const [surveys, setSurveys] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [showNew, setShowNew] = useState(false);

  const loadSurveys = useCallback(() => {
    getJson('/api/nps-admin/surveys').then((d) => setSurveys(d.surveys)).catch(() => {});
  }, []);

  // Same theme setup as every other Calling page - one theme, always; body.theme-light in
  // app/globals.css repaints the zinc-9xx/bg-[#09090b] classes below to a light background.
  useEffect(() => {
    document.body.className = 'font-sans antialiased min-h-screen theme-light';
  }, []);

  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => {
      if (!d.authenticated) {
        window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
        return;
      }
      if (!d.isAdmin && !(d.cards || []).some((c) => c.key === 'nps')) {
        setAuthState('denied');
        return;
      }
      setAuthState('ok');
      loadSurveys();
    }).catch(() => { window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname); });
  }, [loadSurveys]);

  if (authState === 'checking') return <div className="min-h-screen bg-[#09090b] text-zinc-500 flex items-center justify-center text-sm">Loading...</div>;
  if (authState === 'denied') {
    return (
      <div className="min-h-screen bg-[#09090b] flex items-center justify-center">
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-8 max-w-md text-center space-y-2">
          <h2 className="text-lg font-bold text-zinc-100">No access to NPS Survey Admin</h2>
          <p className="text-sm text-zinc-500">Ask an admin to grant you the &quot;NPS Survey Admin&quot; permission.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#09090b] px-5 py-6 space-y-5">
      <div className="max-w-4xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-zinc-100">NPS Survey Admin</h1>
          <a href="/" className="text-sm text-indigo-400 hover:text-indigo-300">&larr; Home</a>
        </div>

        {selectedId ? (
          <SurveyDetail surveyId={selectedId} onBack={() => { setSelectedId(null); loadSurveys(); }} />
        ) : (
          <>
            <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-bold text-zinc-100">Surveys</h2>
                <button type="button" className="text-sm text-indigo-400 hover:text-indigo-300" onClick={() => setShowNew((v) => !v)}>
                  {showNew ? 'Cancel' : '+ New survey'}
                </button>
              </div>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-zinc-500 text-xs"><th className="py-1">Name</th><th>Status</th><th>Questions</th><th>Recipients</th><th>Responded</th></tr></thead>
                <tbody>
                  {surveys.map((s) => (
                    <tr key={s.id} className="border-t border-zinc-800 text-zinc-300 cursor-pointer hover:bg-zinc-800/50" onClick={() => setSelectedId(s.id)}>
                      <td className="py-1.5">{s.name}</td>
                      <td>{s.status}</td>
                      <td>{s.question_count}</td>
                      <td>{s.recipient_count}</td>
                      <td>{s.responded_count}</td>
                    </tr>
                  ))}
                  {surveys.length === 0 && <tr><td className="py-2 text-zinc-500" colSpan={5}>No surveys yet.</td></tr>}
                </tbody>
              </table>
            </div>
            {showNew && <NewSurveyForm onCreated={() => { setShowNew(false); loadSurveys(); }} />}
          </>
        )}
      </div>
    </div>
  );
}
