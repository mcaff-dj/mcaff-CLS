'use client';

// Order Punch tab - admin-only. Queues a batch of orders for repunch via the background
// Lambda worker (mcaff-cls-order-punch-worker); see
// docs/superpowers/specs/2026-08-21-order-punch-design.md. Both the CSV upload and the manual
// rows table build the same {doc, reason, facility_code}[] shape and POST it to the same
// /api/order-punch/start endpoint.
import { useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 3000;
const TERMINAL_STATUSES = new Set(['done', 'failed', 'stopped']);
const SETTINGS_FIELDS = [
  { key: 'facility_codes', label: 'Facility codes', type: 'array' },
  { key: 'mcaffeine_channels', label: 'mCaffeine channels', type: 'array' },
  { key: 'hyphen_channels', label: 'Hyphen channels', type: 'array' },
  { key: 'target_mcaffeine', label: 'Target channel (mCaffeine)', type: 'string' },
  { key: 'target_hyphen', label: 'Target channel (Hyphen)', type: 'string' },
  { key: 'cooldown_days', label: 'Repunch cooldown (days)', type: 'number' },
  { key: 'max_suffix', label: 'Max duplicate suffix', type: 'number' },
];

function parseCsvRows(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const docIdx = header.indexOf('display_order_code');
  const reasonIdx = header.indexOf('reason');
  const facilityIdx = header.indexOf('facility_code');
  if (docIdx === -1) return [];
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return {
      doc: (cells[docIdx] || '').trim(),
      reason: reasonIdx >= 0 ? (cells[reasonIdx] || '').trim() : '',
      facility_code: facilityIdx >= 0 ? (cells[facilityIdx] || '').trim() : '',
    };
  }).filter((r) => r.doc);
}

export default function OrderPunchClient() {
  const [manualRows, setManualRows] = useState([{ doc: '', reason: '', facility_code: '' }]);
  const [csvText, setCsvText] = useState('');
  const [csvFileName, setCsvFileName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState(null);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(null);
  const [settingsError, setSettingsError] = useState('');
  const pollRef = useRef(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function loadSettings() {
    setSettingsError('');
    fetch('/api/order-punch/settings').then((r) => r.json()).then((d) => {
      if (d.settings) setSettings(d.settings);
      else setSettingsError(d.error || 'Could not load settings');
    }).catch((e) => setSettingsError(e.message));
  }

  function openSettings() {
    setShowSettings(true);
    if (!settings) loadSettings();
  }

  async function saveSetting(key, value) {
    setSettingsError('');
    try {
      const res = await fetch('/api/order-punch/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save');
      setSettings(data.settings);
    } catch (e) {
      setSettingsError(e.message);
    }
  }

  function readCsvFile(f) {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { setCsvText(String(reader.result || '')); setCsvFileName(f.name); };
    reader.readAsText(f);
  }

  function addManualRow() {
    setManualRows((rows) => [...rows, { doc: '', reason: '', facility_code: '' }]);
  }

  function updateManualRow(i, field, value) {
    setManualRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  }

  function removeManualRow(i) {
    setManualRows((rows) => rows.filter((_, idx) => idx !== i));
  }

  function pollJob(id) {
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/order-punch/status?jobId=${id}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not fetch status');
        setJobStatus(data);
        if (TERMINAL_STATUSES.has(data.status)) clearInterval(pollRef.current);
      } catch (e) {
        clearInterval(pollRef.current);
        setError(e.message);
      }
    }, POLL_INTERVAL_MS);
  }

  async function handleStart() {
    setError('');
    const csvRows = parseCsvRows(csvText);
    const rows = [...csvRows, ...manualRows.filter((r) => r.doc.trim())];
    if (!rows.length) { setError('Add at least one order code (CSV or manual row)'); return; }

    setSubmitting(true);
    setJobId(null);
    setJobStatus(null);
    try {
      const res = await fetch('/api/order-punch/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start');
      setJobId(data.jobId);
      setJobStatus({ status: 'queued', totalRows: data.queued, processedCount: 0, successCount: 0, errorCount: 0, skippedCount: 0 });
      pollJob(data.jobId);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStop() {
    if (!jobId) return;
    try {
      await fetch('/api/order-punch/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
    } catch (e) {
      setError(e.message);
    }
  }

  function handleDownloadResults() {
    if (!jobId) return;
    window.location.href = `/api/order-punch/results?jobId=${jobId}`;
  }

  const running = jobStatus && !TERMINAL_STATUSES.has(jobStatus.status);

  return (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 20 }}>Order Punch</h1>
        <button onClick={openSettings} style={{ padding: '6px 12px', fontSize: 13 }}>Settings</button>
      </div>

      {showSettings && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Order Punch settings</h3>
          {settingsError && <p style={{ color: '#c0392b', fontSize: 13 }}>{settingsError}</p>}
          {!settings ? <p style={{ fontSize: 13 }}>Loading…</p> : SETTINGS_FIELDS.map((f) => (
            <div key={f.key} style={{ marginBottom: 10 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{f.label}</label>
              <input
                type="text"
                defaultValue={f.type === 'array' ? (settings[f.key] || []).join(', ') : settings[f.key]}
                style={{ width: '100%', padding: 6, fontSize: 13 }}
                onBlur={(e) => {
                  const raw = e.target.value;
                  const value = f.type === 'array'
                    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
                    : f.type === 'number' ? Number(raw) : raw.trim();
                  saveSetting(f.key, value);
                }}
              />
            </div>
          ))}
          <button onClick={() => setShowSettings(false)} style={{ padding: '6px 12px', fontSize: 13, marginTop: 8 }}>Close</button>
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          Upload CSV (columns: display_order_code, reason, facility_code)
        </label>
        <input
          type="file"
          accept=".csv,.tsv,.txt,text/csv"
          onChange={(e) => readCsvFile(e.target.files?.[0])}
        />
        {csvFileName && <span style={{ fontSize: 12, color: '#666', marginLeft: 8 }}>{csvFileName}</span>}
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          Or add rows manually
        </label>
        {manualRows.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <input placeholder="Order code" value={r.doc} onChange={(e) => updateManualRow(i, 'doc', e.target.value)} style={{ flex: 2, padding: 6, fontSize: 13 }} />
            <input placeholder="Reason (optional)" value={r.reason} onChange={(e) => updateManualRow(i, 'reason', e.target.value)} style={{ flex: 2, padding: 6, fontSize: 13 }} />
            <input placeholder="Facility code (optional)" value={r.facility_code} onChange={(e) => updateManualRow(i, 'facility_code', e.target.value)} style={{ flex: 2, padding: 6, fontSize: 13 }} />
            {manualRows.length > 1 && <button onClick={() => removeManualRow(i)} style={{ padding: '0 8px' }}>×</button>}
          </div>
        ))}
        <button onClick={addManualRow} style={{ padding: '4px 10px', fontSize: 12 }}>+ Add row</button>
      </div>

      <button
        onClick={handleStart}
        disabled={submitting || running}
        style={{ padding: '8px 16px', fontSize: 14, fontWeight: 600 }}
      >
        {submitting ? 'Starting…' : 'Start Order Punch'}
      </button>

      {error && <p style={{ color: '#c0392b', marginTop: 12 }}>{error}</p>}

      {jobStatus && (
        <div style={{ marginTop: 20, padding: 16, border: '1px solid #ddd', borderRadius: 8 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13, marginBottom: 8 }}>
            <span>Status: <strong>{jobStatus.status}</strong></span>
            <span>{jobStatus.processedCount ?? 0}/{jobStatus.totalRows} processed</span>
            <span>✅ {jobStatus.successCount ?? 0}</span>
            <span>❌ {jobStatus.errorCount ?? 0}</span>
            <span>⊘ {jobStatus.skippedCount ?? 0}</span>
          </div>
          {jobStatus.status === 'failed' && jobStatus.errorMessage && (
            <p style={{ color: '#c0392b', fontSize: 13 }}>{jobStatus.errorMessage}</p>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            {running && <button onClick={handleStop} style={{ padding: '6px 12px', fontSize: 13 }}>Stop</button>}
            {TERMINAL_STATUSES.has(jobStatus.status) && (
              <button onClick={handleDownloadResults} style={{ padding: '6px 12px', fontSize: 13 }}>Download Results CSV</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
