'use client';

import { useState } from 'react';
import OrgKycTrendsTab from './OrgKycTrendsTab';
import RepeatRateTab from './RepeatRateTab';
import CsatRepeatRateTab from './CsatRepeatRateTab';

// Same tab-shell pattern app/deepdive/DeepdiveClient.js uses for its own multi-tab card, so a
// further org-wide view can be added here later (new TABS entry + panel) without restructuring.
const TABS = [
  { key: 'kyctrends', label: 'Org_KYC_Trends' },
  { key: 'repeatrate', label: 'Repeat Rate analysis' },
  { key: 'csatrepeatrate', label: 'CSAT Repeat rate' },
];

export default function OrgOverviewClient() {
  const [activeTab, setActiveTab] = useState('kyctrends');

  return (
    <div className="orgoverview-page">
      <div className="wrap">
        <a className="home-link" href="/" target="_top">&larr; Home</a>

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
        <div className={'tab-panel' + (activeTab === 'repeatrate' ? ' active' : '')} id="panel-repeatrate">
          {activeTab === 'repeatrate' && <RepeatRateTab />}
        </div>
        <div className={'tab-panel' + (activeTab === 'csatrepeatrate' ? ' active' : '')} id="panel-csatrepeatrate">
          {activeTab === 'csatrepeatrate' && <CsatRepeatRateTab />}
        </div>
      </div>
    </div>
  );
}
