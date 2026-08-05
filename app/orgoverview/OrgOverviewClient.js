'use client';

import { useState } from 'react';
import OrgKycTrendsTab from './OrgKycTrendsTab';

// One tab today - Org_KYC_Trends - but this is the same tab-shell pattern
// app/deepdive/DeepdiveClient.js uses for its own multi-tab card, so a second
// org-wide view can be added here later (new TABS entry + panel) without restructuring.
const TABS = [
  { key: 'kyctrends', label: 'Org_KYC_Trends' },
];

export default function OrgOverviewClient() {
  const [activeTab, setActiveTab] = useState('kyctrends');

  return (
    <div className="orgoverview-page">
      <div className="wrap">
        <a className="home-link" href="/">&larr; Home</a>

        <nav className="tab-nav" id="main-tab-nav">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={'tab-btn' + (t.key === activeTab ? ' active' : '')}
              data-tab={t.key}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className={'tab-panel' + (activeTab === 'kyctrends' ? ' active' : '')} id="panel-kyctrends">
          {activeTab === 'kyctrends' && <OrgKycTrendsTab />}
        </div>
      </div>
    </div>
  );
}
