'use client';

import { useEffect, useState } from 'react';

function formatPct(pct) {
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
}

function BreakdownList({ items }) {
  if (!items || !items.length) return <>-</>;
  return <>{items.map((x) => `${x.value} (${formatPct(x.pct)}%)`).join(', ')}</>;
}

function ThemesBlock({ themes }) {
  if (!themes || !themes.length) return null;
  return (
    <>
      <div className="pk-themes-title">Common themes in constructive feedback</div>
      {themes.map((t) => (
        <div className="pk-theme" key={t.label}>
          <div className="pk-theme-label">{t.label}</div>
          {t.keywords && t.keywords.length > 0 && (
            <div className="pk-kw-row">
              {t.keywords.map((k) => (
                <span className="pk-kw" key={k.word}>{k.word} &times;{k.count}</span>
              ))}
            </div>
          )}
          {t.quotes.map((q, i) => (
            <p className="pk-quote" key={i}>&ldquo;{q}&rdquo;</p>
          ))}
        </div>
      ))}
    </>
  );
}

function ProductCard({ p }) {
  if (p.kind === 'comparison') {
    return (
      <div className="pk-product">
        <h3>{p.title}</h3>
        <p className="pk-meta">
          {p.meta.countA.toLocaleString('en-IN')} preferred {p.meta.shortA} &middot;{' '}
          {p.meta.countB.toLocaleString('en-IN')} preferred {p.meta.shortB} &middot;{' '}
          {p.meta.totalRows.toLocaleString('en-IN')} total rows
        </p>
        <table className="pk-table">
          <thead><tr><th>Category</th><th>{p.meta.shortA}</th><th>{p.meta.shortB}</th></tr></thead>
          <tbody>
            {p.compareTable.map((row) => (
              <tr key={row.label}>
                <td className="pk-rowlabel">{row.label}</td>
                <td><BreakdownList items={row.a} /></td>
                <td><BreakdownList items={row.b} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <ThemesBlock themes={p.themes} />
      </div>
    );
  }

  return (
    <div className="pk-product">
      <h3>{p.title}</h3>
      <p className="pk-meta">{p.meta.totalRows.toLocaleString('en-IN')} total rows</p>
      <table className="pk-table">
        <thead><tr><th>Category</th><th>Breakdown</th></tr></thead>
        <tbody>
          {p.statsTable.map((row) => (
            <tr key={row.label}>
              <td className="pk-rowlabel">{row.label}</td>
              <td><BreakdownList items={row.breakdown} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <ThemesBlock themes={p.themes} />
    </div>
  );
}

export default function ProductKycClient() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [activeCategory, setActiveCategory] = useState(null);
  const [hideTabNav, setHideTabNav] = useState(false);

  useEffect(() => {
    // Embedded in the dashboard iframe - the sidebar's mirrored Report Views list
    // already covers navigation, so hide this report's own tab row there. Leave it
    // visible on direct/standalone access, since that's the only nav available then.
    setHideTabNav(window.top !== window.self);

    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => {
        if (!d.authenticated) {
          window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
          return;
        }
        return fetch('/api/report/data/productkyc').then(async (r) => {
          if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            throw new Error(body.error || `Request failed (${r.status})`);
          }
          return r.json();
        });
      })
      .then((json) => {
        if (!json) return;
        setData(json);
        setActiveCategory(json.categories[0] && json.categories[0].key);
      })
      .catch((e) => setError(e.message || 'Could not load Product KYC data.'));
  }, []);

  if (error) {
    return (
      <div className="productkyc-page">
        <div className="wrap">
          <a className="home-link" href="/" target="_top">&larr; Home</a>
          <p className="pk-error">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="productkyc-page">
        <div className="wrap">
          <a className="home-link" href="/" target="_top">&larr; Home</a>
          <p className="pk-meta">Loading...</p>
        </div>
      </div>
    );
  }

  const productsByCategory = {};
  data.products.forEach((p) => {
    (productsByCategory[p.category] = productsByCategory[p.category] || []).push(p);
  });

  return (
    <div className="productkyc-page">
      <div className="wrap">
        <a className="home-link" href="/" target="_top">&larr; Home</a>
        <header>
          <div><span className="badge">Auto-refreshed</span></div>
          <h1>Product Calling KYC</h1>
          <p>
            Built from the &quot;Product feedback KYC&quot; workbook &middot; last updated {data.generatedAt}.<br />
            Comparison tables are computed from response counts; feedback themes are keyword frequency + verbatim quotes
            pulled directly from free-text answers &mdash; not AI-written summaries.
          </p>
        </header>

        <nav className="tab-nav" style={hideTabNav ? { display: 'none' } : undefined}>
          {data.categories.map((c) => (
            <button
              key={c.key}
              type="button"
              className={'tab-btn' + (c.key === activeCategory ? ' active' : '')}
              data-tab={c.key}
              onClick={() => setActiveCategory(c.key)}
            >
              {c.label}
            </button>
          ))}
        </nav>

        {data.categories.map((c) => (
          <div key={c.key} className={'tab-panel' + (c.key === activeCategory ? ' active' : '')} id={'panel-' + c.key}>
            <span className="status-pill">Live</span>
            {(productsByCategory[c.key] || []).map((p) => (
              <ProductCard p={p} key={p.key} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
