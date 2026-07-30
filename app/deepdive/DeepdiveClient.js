'use client';

import { useEffect, useState } from 'react';
import AgentShiftTab from './AgentShiftTab';

var ddRefreshPollTimer = null;

function ddSetStatus(text, isError) {
  var el = document.getElementById('ddRefreshStatus');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

function ddSetBusy(busy) {
  var btn = document.getElementById('ddRefreshBtn');
  btn.disabled = busy;
  btn.classList.toggle('spinning', busy);
}

function ddFormatRefreshedAt(isoString) {
  var d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function ddShowLastRefreshed(statusResp) {
  var el = document.getElementById('ddLastRefreshed');
  if (!statusResp || !statusResp.updated_at) { el.textContent = ''; return; }
  var label = statusResp.status === 'completed' && statusResp.conclusion !== 'success' ? ' (with issues)' : '';
  el.textContent = 'Last refreshed: ' + ddFormatRefreshedAt(statusResp.updated_at) + label;
}

function ddPollRefreshStatus() {
  fetch('/api/refresh-status?workflow=deepdive').then(function (r) { return r.json(); }).then(function (d) {
    if (d.status === 'completed') {
      clearInterval(ddRefreshPollTimer);
      ddRefreshPollTimer = null;
      ddSetBusy(false);
      ddShowLastRefreshed(d);
      if (d.conclusion === 'success') {
        ddSetStatus('Refresh complete - reloading...');
        setTimeout(function () { window.location.reload(); }, 1200);
      } else {
        ddSetStatus('Refresh finished with issues - try again or check the workflow run.', true);
      }
    } else if (d.status === 'in_progress' || d.status === 'queued') {
      ddSetBusy(true);
      ddSetStatus('Refreshing data... (' + d.status.replace('_', ' ') + ')');
    }
  }).catch(function () { /* keep polling silently through a transient network blip */ });
}

function ddTriggerRefresh() {
  ddSetBusy(true);
  ddSetStatus('Starting refresh...');
  fetch('/api/refresh?workflow=deepdive', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.status === 'started' || d.status === 'already_running') {
        ddSetStatus(d.message);
        if (!ddRefreshPollTimer) ddRefreshPollTimer = setInterval(ddPollRefreshStatus, 10000);
      } else {
        ddSetBusy(false);
        ddSetStatus(d.message || 'Could not start refresh.', true);
      }
    })
    .catch(function () {
      ddSetBusy(false);
      ddSetStatus('Could not reach the server - try again.', true);
    });
}

const TABS = [
  { key: 'csat', label: 'CSAT Deep Dive' },
  { key: 'nps', label: 'NPS' },
  { key: 'agent', label: 'Agent wise analysis' },
  { key: 'agentactivity', label: 'Agent Activity Analysis' },
];

function NotYetMigrated({ label }) {
  return (
    <p className="card-sub dd-not-migrated">
      {label} hasn&apos;t been moved to the new dashboard yet - it&apos;s being worked on in a
      follow-up pass. Nothing is broken; this tab is simply not built here yet.
    </p>
  );
}

// NPS mapping review - the tab shell is wired up (nav entry, panel, and a 'nps' entry in
// api/_lib/tabs.js so it can be granted per-user) but the mapping table itself isn't built
// yet; which mapping this reviews is still being pinned down. Replace this component's body
// once that's settled - nothing else here needs to change.
function NpsMappingReview() {
  return (
    <p className="card-sub dd-not-migrated">
      NPS mapping review is coming soon - this tab is wired up but the mapping table isn&apos;t
      built yet.
    </p>
  );
}

export default function DeepdiveClient() {
  // "Agent wise analysis" is the only tab actually ported so far (see the phase 3b
  // plan) - default there instead of the original's "csat" so this page opens on
  // real content rather than a placeholder.
  const [activeTab, setActiveTab] = useState('agent');

  useEffect(() => {
    fetch('/api/refresh-status?workflow=deepdive').then(function (r) { return r.json(); }).then(function (d) {
      ddShowLastRefreshed(d);
      if (d.status === 'in_progress' || d.status === 'queued') {
        ddSetBusy(true);
        ddSetStatus('Refreshing data... (' + d.status.replace('_', ' ') + ')');
        if (!ddRefreshPollTimer) ddRefreshPollTimer = setInterval(ddPollRefreshStatus, 10000);
      }
    }).catch(function () { /* no last-refreshed info available - leave it blank */ });
    return () => {
      if (ddRefreshPollTimer) { clearInterval(ddRefreshPollTimer); ddRefreshPollTimer = null; }
    };
  }, []);

  return (
    <div className="deepdive-page">
      <div className="wrap">
        <div className="dd-refresh-row">
          <button type="button" className="dd-refresh-btn" id="ddRefreshBtn" onClick={ddTriggerRefresh}>
            <span className="dd-spin">&#8635;</span> Refresh Agent Data
          </button>
          <span className="dd-refresh-status" id="ddRefreshStatus"></span>
          <span className="dd-last-refreshed" id="ddLastRefreshed"></span>
        </div>

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

        <div className={'tab-panel' + (activeTab === 'csat' ? ' active' : '')} id="panel-csat">
          {activeTab === 'csat' && <NotYetMigrated label="CSAT Deep Dive" />}
        </div>

        <div className={'tab-panel' + (activeTab === 'nps' ? ' active' : '')} id="panel-nps">
          {activeTab === 'nps' && <NpsMappingReview />}
        </div>

        <div className={'tab-panel' + (activeTab === 'agent' ? ' active' : '')} id="panel-agent">
          {activeTab === 'agent' && <AgentShiftTab />}
        </div>

        <div className={'tab-panel' + (activeTab === 'agentactivity' ? ' active' : '')} id="panel-agentactivity">
          {activeTab === 'agentactivity' && <NotYetMigrated label="Agent Activity Analysis" />}
        </div>
      </div>
      <div className="tooltip" id="tooltip"></div>
    </div>
  );
}
