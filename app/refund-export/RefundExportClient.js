'use client';

// Calling Team's "Exports" tab - filtered CSV download of PEP_CLS.refund_all_brands via
// GET /api/refund-export. No admin/PII branching here: the server (session.isAdmin) decides
// which columns come back, so this page just downloads whatever it's given - see that
// endpoint and docs/superpowers/specs/2026-08-12-refund-export-design.md for why.
import { useState } from 'react';

const STATUS_OPTIONS = ['Completed', 'Initiated', 'Failed', 'Rejected'];
const REFUND_TYPE_OPTIONS = ['Full', 'Partial'];
const SOURCE_OPTIONS = ['Shopify', 'Payment Link', 'Others'];

function FilterGroup({ label, options, selected, onToggle }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {options.map((opt) => (
        <label key={opt} style={{ marginRight: 12, fontSize: 13 }}>
          <input type="checkbox" checked={selected.has(opt)} onChange={() => onToggle(opt)} /> {opt}
        </label>
      ))}
    </div>
  );
}

export default function RefundExportClient() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState(new Set());
  const [refundType, setRefundType] = useState(new Set());
  const [source, setSource] = useState(new Set());
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  function toggle(set, setSet, value) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    setSet(next);
  }

  async function handleDownload() {
    setError('');
    setDownloading(true);
    try {
      const params = new URLSearchParams({ from, to });
      if (status.size) params.set('status', [...status].join(','));
      if (refundType.size) params.set('refundType', [...refundType].join(','));
      if (source.size) params.set('source', [...source].join(','));

      const res = await fetch(`/api/refund-export?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `refund-export_${from}_to_${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloading(false);
    }
  }

  const canDownload = Boolean(from) && Boolean(to) && !downloading;

  return (
    <div style={{ padding: 24, maxWidth: 640, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Refund Export</h1>

      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 13 }}>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 13 }}>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
        </label>
      </div>

      <FilterGroup label="Status" options={STATUS_OPTIONS} selected={status} onToggle={(v) => toggle(status, setStatus, v)} />
      <FilterGroup label="Refund Type" options={REFUND_TYPE_OPTIONS} selected={refundType} onToggle={(v) => toggle(refundType, setRefundType, v)} />
      <FilterGroup label="Source" options={SOURCE_OPTIONS} selected={source} onToggle={(v) => toggle(source, setSource, v)} />

      <button onClick={handleDownload} disabled={!canDownload} style={{ marginTop: 16, padding: '8px 16px' }}>
        {downloading ? 'Preparing…' : 'Download CSV'}
      </button>

      {error && <p style={{ color: '#c0392b', marginTop: 12 }}>{error}</p>}
    </div>
  );
}
