'use client';

// Calling Team's "Exports" tab - filtered CSV download of PEP_CLS.nps_product via
// GET /api/nps-product-export. Same shape as ../refund-export/RefundExportClient.js, minus
// PII branching (this export has none - see that endpoint's own column list in api/_lib/db.js).
import { useState } from 'react';

const BRAND_OPTIONS = [
  { value: 'Mcaffeine', label: 'mCaffeine' },
  { value: 'Hyphen', label: 'Hyphen' },
];

export default function NpsProductExportClient() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [brand, setBrand] = useState(new Set());
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  function toggleBrand(value) {
    const next = new Set(brand);
    if (next.has(value)) next.delete(value); else next.add(value);
    setBrand(next);
  }

  async function handleDownload() {
    setError('');
    setDownloading(true);
    try {
      const params = new URLSearchParams({ from, to });
      if (brand.size) params.set('brand', [...brand].join(','));

      const res = await fetch(`/api/nps-product-export?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nps-product-export_${from}_to_${to}.csv`;
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
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Export Product NPS</h1>

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

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Brand</div>
        {BRAND_OPTIONS.map((opt) => (
          <label key={opt.value} style={{ marginRight: 12, fontSize: 13 }}>
            <input type="checkbox" checked={brand.has(opt.value)} onChange={() => toggleBrand(opt.value)} /> {opt.label}
          </label>
        ))}
      </div>

      <button onClick={handleDownload} disabled={!canDownload} style={{ marginTop: 16, padding: '8px 16px' }}>
        {downloading ? 'Preparing…' : 'Download CSV'}
      </button>

      {error && <p style={{ color: '#c0392b', marginTop: 12 }}>{error}</p>}
    </div>
  );
}
