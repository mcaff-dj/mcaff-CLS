'use client';

import { useEffect } from 'react';

var currentBrand = '';
var currentTabId = '';
var userCards = [];
var userTabPerms = {}; // { cardKey: [tabKey, ...] } - absent/empty key = every tab allowed
var brandColors = {
  mcaffeine: { accent: 'var(--mcaff)', bg: 'rgba(74, 58, 167, 0.08)', fg: 'var(--mcaff)' },
  hyphen: { accent: 'var(--hyphen)', bg: 'rgba(25, 156, 92, 0.08)', fg: 'var(--hyphen)' },
  productkyc: { accent: 'var(--pkyc)', bg: 'rgba(194, 116, 12, 0.08)', fg: 'var(--pkyc)' },
  mom: { accent: 'var(--mom)', bg: 'rgba(147, 51, 234, 0.08)', fg: 'var(--mom)' }
};

// Cards with no report wired up yet - onBrandChange shows a plain placeholder instead
// of pointing the iframe at /api/report/{key} (which would 404/500, since there's no
// api/_reports/{key}.html for these). Remove an entry here once its report exists.
var COMING_SOON = {
};

// Cards that have been migrated to a real Next.js page instead of a Python-generated
// api/_reports/{key}.html file - the iframe points straight at the route rather than
// through /api/report/{key}'s static-file-serving path.
var NEXT_PAGE_ROUTES = {
  onboarding: '/onboarding',
  productkyc: '/productkyc',
  deepdive: '/deepdive',
  orgoverview: '/orgoverview',
  nps: '/nps-admin',
  mom: '/mom'
};

// Calling Team has its own nested nav sub-items instead of one blanket "coming soon"
// card. Detractor and Product KYC still have no workspace at all, so they stay behind
// /rto-crm's own Process switcher (see callingProcesses.json + RtoCrmClient.js's
// `!currentProcess.implemented` branch) until they get one. NDR and Escalation each have a
// real, independent workspace and their own sidebar entry, same as RTO - see the plan for
// splitting Calling processes into their own pages, one folder per process. Access is still
// enforced server-side via invitedProcessKeys/report_tab_permissions regardless of what's
// listed here - removing a process from this sidebar list is purely navigational, not a
// permission change.
//
// Escalation is the RTO-confirmed-by-both-courier-and-logistics desk (app/escalation/), ported
// in from a separately-deployed standalone app. Its source folder is still called "NDR Calling"
// but it is NOT the NDR process above and shares no data with it - different sheet, different
// columns, different queue.
//
// Delivery-Escalation (app/delivery-escalation/) is a third, unrelated sheet again - delivery-
// partner query/escalation tickets, brand-tabbed (HYPHEN/mCaffeine). Unlike every other entry
// here, it has no Postgres-backed roster/presence/business-hours behind it at all - see
// api/_lib/callingProcesses.json's "deliveryescalation" entry.
var CALLING_TEAM_SUBITEMS = {
  overview: { label: 'Overview', text: 'Calling Team Overview', url: '/calling-overview' },
  rto: { label: 'RTO-Calling', text: 'RTO CRM Agent & Refund Portal', url: '/rto-crm' },
  ndr: { label: 'NDR-Calling', text: 'NDR Calling Agent Portal', url: '/ndr-calling' },
  escalation: { label: 'Escalation', text: 'Escalation Agent Portal', url: '/escalation' },
  deliveryescalation: { label: 'Delivery-Escalation', text: 'Delivery-Escalation Agent Portal', url: '/delivery-escalation' },
  exports: { label: 'Exports', text: 'Refund Export', url: '/refund-export' }
};

function selectCallingTeamView(view) {
  Array.prototype.slice.call(document.querySelectorAll('#navList .nav-btn[data-calling-team-view]')).forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-calling-team-view') === view);
  });
  var sub = CALLING_TEAM_SUBITEMS[view];
  var iframe = document.getElementById('reportIframe');
  var placeholder = document.getElementById('placeholderPanel');
  if (sub && sub.url) {
    placeholder.style.display = 'none';
    iframe.style.display = 'block';
    iframe.src = sub.url;
  } else {
    iframe.style.display = 'none';
    document.getElementById('placeholderTitle').textContent = sub ? sub.label : '';
    document.getElementById('placeholderDesc').textContent = sub ? sub.text : '';
    placeholder.style.display = 'flex';
  }
}

function toggleMobileSidebar() {
  var sidebar = document.querySelector('.home-page .sidebar');
  var toggle = document.getElementById('menuToggle');
  sidebar.classList.toggle('open');
  toggle.innerHTML = sidebar.classList.contains('open') ? '✕' : '☰';
}

// "Refresh Data" button - calls the existing /api/refresh (dispatches the refresh.yml
// GitHub Actions workflow server-side) and /api/refresh-status (polled until the run
// finishes) endpoints; both already existed for this exact purpose, just had no button
// wired up since the dashboard's sidebar redesign.
var refreshPollTimer = null;

function setRefreshStatus(text, isError) {
  var el = document.getElementById('refreshStatus');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

function setRefreshBusy(busy) {
  var btn = document.getElementById('refreshBtn');
  btn.disabled = busy;
  btn.classList.toggle('spinning', busy);
  document.getElementById('refreshProgress').classList.toggle('active', busy);
}

function formatRefreshedAt(isoString) {
  var d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function showLastRefreshed(statusResp) {
  var el = document.getElementById('lastRefreshed');
  if (!statusResp || !statusResp.updated_at) { el.textContent = ''; return; }
  var label = statusResp.status === 'completed' && statusResp.conclusion !== 'success' ? ' (with issues)' : '';
  el.textContent = 'Last refreshed: ' + formatRefreshedAt(statusResp.updated_at) + label;
}

function pollRefreshStatus() {
  fetch('/api/refresh-status').then(function (r) { return r.json(); }).then(function (d) {
    if (d.status === 'completed') {
      clearInterval(refreshPollTimer);
      refreshPollTimer = null;
      setRefreshBusy(false);
      showLastRefreshed(d);
      if (d.conclusion === 'success') {
        setRefreshStatus('Refresh complete - reloading...');
        setTimeout(function () {
          var iframe = document.getElementById('reportIframe');
          if (iframe && iframe.src && iframe.src.indexOf('/api/report/') !== -1) {
            iframe.src = iframe.src;
          }
          setRefreshStatus('');
        }, 1200);
      } else {
        setRefreshStatus('Refresh finished with issues - try again or check the workflow run.', true);
      }
    } else if (d.status === 'in_progress' || d.status === 'queued') {
      setRefreshBusy(true);
      setRefreshStatus('Refreshing data... (' + d.status.replace('_', ' ') + ')');
    }
  }).catch(function () { /* keep polling silently through a transient network blip */ });
}

function triggerRefresh() {
  setRefreshBusy(true);
  setRefreshStatus('Starting refresh...');
  fetch('/api/refresh', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.status === 'started' || d.status === 'already_running') {
        setRefreshStatus(d.message);
        if (!refreshPollTimer) refreshPollTimer = setInterval(pollRefreshStatus, 10000);
      } else {
        setRefreshBusy(false);
        setRefreshStatus(d.message || 'Could not start refresh.', true);
      }
    })
    .catch(function () {
      setRefreshBusy(false);
      setRefreshStatus('Could not reach the server - try again.', true);
    });
}

// On page load, show when data was last refreshed - and if a refresh happens to
// already be running (e.g. triggered by another tab, or the daily schedule), pick up
// the progress bar/polling immediately instead of only reacting to this tab's own click.
function initRefreshStatus() {
  fetch('/api/refresh-status').then(function (r) { return r.json(); }).then(function (d) {
    showLastRefreshed(d);
    if (d.status === 'in_progress' || d.status === 'queued') {
      setRefreshBusy(true);
      setRefreshStatus('Refreshing data... (' + d.status.replace('_', ' ') + ')');
      if (!refreshPollTimer) refreshPollTimer = setInterval(pollRefreshStatus, 10000);
    }
  }).catch(function () { /* no last-refreshed info available - leave it blank */ });
}

// Handle Brand Switch. isUserAction is true only when triggered by an actual
// dropdown selection (not the initial auto-select on page load) - it gates the
// auto-popup below so we never spawn a tab the user didn't ask for.
function onBrandChange(brandKey, isUserAction) {
  currentBrand = brandKey;
  var config = brandColors[brandKey] || brandColors.mcaffeine;

  var root = document.documentElement;
  root.style.setProperty('--brand-accent', config.accent);
  root.style.setProperty('--active-bg', config.bg);
  root.style.setProperty('--active-fg', config.fg);

  var iframe = document.getElementById('reportIframe');
  var placeholderPanel = document.getElementById('placeholderPanel');
  document.getElementById('navList').innerHTML = '';

  if (brandKey === 'calling') {
    iframe.style.display = 'none';
    iframe.src = 'about:blank';
    document.getElementById('granularitySection').style.display = 'none';
    document.getElementById('loadingOverlay').style.opacity = '0';
    document.getElementById('loadingOverlay').style.visibility = 'hidden';

    var callingViews = Object.keys(CALLING_TEAM_SUBITEMS);
    var allowedViews = userTabPerms['calling'];
    if (Array.isArray(allowedViews) && allowedViews.length) {
      var allowedViewSet = {};
      allowedViews.forEach(function (k) { allowedViewSet[k] = true; });
      callingViews = callingViews.filter(function (v) { return allowedViewSet[v]; });
    }
    document.getElementById('navList').innerHTML = callingViews.map(function (v) {
      return '<button class="nav-btn" data-calling-team-view="' + v + '" onclick="selectCallingTeamView(\'' + v + '\')">' + CALLING_TEAM_SUBITEMS[v].label + '</button>';
    }).join('');
    selectCallingTeamView(callingViews.indexOf('rto') !== -1 ? 'rto' : (callingViews[0] || 'rto'));
    return;
  }

  if (COMING_SOON[brandKey]) {
    iframe.style.display = 'none';
    iframe.src = 'about:blank';
    document.getElementById('granularitySection').style.display = 'none';
    document.getElementById('loadingOverlay').style.opacity = '0';
    document.getElementById('loadingOverlay').style.visibility = 'hidden';
    var label = (userCards.filter(function (c) { return c.key === brandKey; })[0] || {}).label || brandKey;
    document.getElementById('placeholderTitle').textContent = label;
    document.getElementById('placeholderDesc').textContent = COMING_SOON[brandKey];
    placeholderPanel.style.display = 'flex';
    return;
  }
  placeholderPanel.style.display = 'none';
  iframe.style.display = 'block';

  document.getElementById('granularitySection').style.display =
    (brandKey === 'mcaffeine' || brandKey === 'hyphen') ? 'flex' : 'none';

  iframe.classList.remove('loaded');
  document.getElementById('loadingOverlay').style.opacity = '1';
  document.getElementById('loadingOverlay').style.visibility = 'visible';

  document.getElementById('loadingText').textContent = 'Loading ' + brandKey + ' report...';
  iframe.src = NEXT_PAGE_ROUTES[brandKey] || ('/api/report/' + encodeURIComponent(brandKey));
}

// Handles Iframe loaded event
function onIframeLoaded() {
  var iframe = document.getElementById('reportIframe');
  if (!iframe.src || iframe.src.indexOf('about:blank') !== -1) return;

  syncGranularityUI();

  // Calling Team manages its own static Report Views list (Overview/RTO-Calling) via
  // selectCallingTeamView - mirroring the iframe's internal tab bar here would otherwise
  // wipe that list out every time RTO-Calling's iframe (/rto-crm, which has no .tab-nav)
  // finishes loading or reloads internally.
  if (currentBrand !== 'calling') {
    populateReportNav();
  }

  iframe.classList.add('loaded');
  document.getElementById('loadingOverlay').style.opacity = '0';
  document.getElementById('loadingOverlay').style.visibility = 'hidden';

  document.querySelector('.home-page .sidebar').classList.remove('open');
  document.getElementById('menuToggle').innerHTML = '☰';
}

// Mirrors the report's own internal tab bar (.tab-nav .tab-btn, inside the iframe)
// into the sidebar's "Report Views" list - same nav-btn/#navList pattern Calling
// Team's static sub-items use - then hides the now-redundant tab row inside the
// iframe. selectTab() still works: clicking a hidden tab-btn still fires its click
// handler, so the report's own tabjs script (active class + panel toggling) is
// untouched.
function populateReportNav() {
  var iframe = document.getElementById('reportIframe');
  var doc = iframe.contentDocument || iframe.contentWindow.document;
  var innerBtns = Array.prototype.slice.call(doc.querySelectorAll('.tab-nav .tab-btn'));
  var navList = document.getElementById('navList');
  navList.innerHTML = '';
  if (!innerBtns.length) return;

  var allowedTabs = userTabPerms[currentBrand];
  if (Array.isArray(allowedTabs) && allowedTabs.length) {
    var allowedSet = {};
    allowedTabs.forEach(function (k) { allowedSet[k] = true; });
    innerBtns = innerBtns.filter(function (b) { return allowedSet[b.dataset.tab]; });
  }

  innerBtns.forEach(function (b) {
    var btn = document.createElement('button');
    btn.className = 'nav-btn' + (b.classList.contains('active') ? ' active' : '');
    btn.setAttribute('data-tab', b.dataset.tab);
    btn.textContent = b.textContent;
    btn.onclick = function () { selectTab(b.dataset.tab); };
    navList.appendChild(btn);
  });

  var innerNav = doc.querySelector('.tab-nav');
  if (innerNav) innerNav.style.display = 'none';

  var activeIsAllowed = innerBtns.some(function (b) { return b.classList.contains('active'); });
  if (innerBtns.length && !activeIsAllowed) {
    selectTab(innerBtns[0].dataset.tab);
  }
}

// Switch tab inside iframe
function selectTab(tabId) {
  currentTabId = tabId;
  var iframe = document.getElementById('reportIframe');
  var doc = iframe.contentDocument || iframe.contentWindow.document;

  var innerBtn = doc.querySelector('.tab-nav .tab-btn[data-tab="' + tabId + '"]');
  if (innerBtn) {
    innerBtn.click();
  }

  var btns = document.querySelectorAll('#navList .nav-btn');
  btns.forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
  });

  var activeGranBtn = document.querySelector('.gran-toggle .gran-btn.active');
  if (activeGranBtn) {
    var gran = activeGranBtn.getAttribute('id') === 'granWeekly' ? 'weekly' : 'monthly';
    setGranularity(gran);
  }
}

// Set Time Granularity in Iframe
function setGranularity(mode) {
  document.getElementById('granMonthly').classList.toggle('active', mode === 'monthly');
  document.getElementById('granWeekly').classList.toggle('active', mode === 'weekly');

  var iframe = document.getElementById('reportIframe');
  if (!iframe || !iframe.contentWindow) return;

  if (iframe.contentWindow.setGranularity) {
    iframe.contentWindow.setGranularity(mode);
  }
  if (iframe.contentWindow.setMaGranularity) {
    iframe.contentWindow.setMaGranularity(mode);
  }
}

// Sync current granularity buttons to match iframe
function syncGranularityUI() {
  var iframe = document.getElementById('reportIframe');
  if (!iframe) return;

  var doc = iframe.contentDocument || iframe.contentWindow.document;

  var activeGranBtn = doc.querySelector('.gran-toggle .gran-btn.active');
  var activeMaGranBtn = doc.querySelector('.ma-gran-toggle .gran-btn.active');

  var isWeekly = false;
  if (activeGranBtn) {
    isWeekly = activeGranBtn.getAttribute('data-gran') === 'weekly';
  } else if (activeMaGranBtn) {
    isWeekly = activeMaGranBtn.getAttribute('data-magran') === 'weekly';
  }

  document.getElementById('granMonthly').classList.toggle('active', !isWeekly);
  document.getElementById('granWeekly').classList.toggle('active', isWeekly);
}

export default function HomePage() {
  useEffect(() => {
    // Dynamically-built nav markup (selectCallingTeamView's calling-team sub-items)
    // still wires clicks via a literal onclick="..." attribute string, same as the
    // original static HTML page, so it needs the handler reachable on window.
    window.selectCallingTeamView = selectCallingTeamView;

    fetch('/api/auth/me')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.authenticated) {
          window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
          return;
        }

        document.getElementById('userName').textContent = d.name || d.email;
        if (d.isAdmin) {
          document.getElementById('userRole').textContent = 'Administrator';
          document.getElementById('adminLink').style.display = 'inline';
        }

        userCards = d.cards || [];
        userTabPerms = d.tabPerms || {};
        if (userCards.length === 0) {
          document.getElementById('loadingText').textContent = 'No reports shared with you yet. Contact your admin.';
          return;
        }

        var brandSelect = document.getElementById('brandSelect');
        brandSelect.innerHTML = userCards.map(function (c) {
          return '<option value="' + c.key + '">' + c.label + '</option>';
        }).join('');

        onBrandChange(userCards[0].key, false);
      })
      .catch(function () {
        window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      });

    var iframe = document.getElementById('reportIframe');
    iframe.addEventListener('load', onIframeLoaded);

    initRefreshStatus();
  }, []);

  return (
    <div className="home-page">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="logo-container">
            <h1 className="logo-title">CX Unified Dashboard</h1>
          </div>
          <button type="button" className="refresh-btn" id="refreshBtn" onClick={triggerRefresh}>
            <span className="spin">&#8635;</span> Refresh Data
          </button>
          <div className="refresh-progress" id="refreshProgress"><div className="refresh-progress-bar"></div></div>
          <div className="refresh-status" id="refreshStatus"></div>
          <div className="last-refreshed" id="lastRefreshed"></div>
        </div>

        <div className="sidebar-scroll">
          <div className="section">
            <span className="section-title">Brand Report</span>
            <div className="brand-select-wrapper">
              <select id="brandSelect" className="brand-select" onChange={(e) => onBrandChange(e.target.value, true)}>
                {/* Populated via API */}
              </select>
            </div>
          </div>

          <div className="section" id="granularitySection" style={{ display: 'none' }}>
            <span className="section-title">Time Resolution</span>
            <div className="gran-toggle">
              <button type="button" className="gran-btn active" id="granMonthly" onClick={() => setGranularity('monthly')}>Monthly</button>
              <button type="button" className="gran-btn" id="granWeekly" onClick={() => setGranularity('weekly')}>Weekly</button>
            </div>
          </div>

          <div className="section">
            <span className="section-title" id="panelsSectionTitle">Report Views</span>
            <nav className="nav-list" id="navList">
              {/* Populated from iframe loaded tabs */}
            </nav>
          </div>
        </div>

        <div className="sidebar-footer">
          <div className="user-profile">
            <span className="user-name" id="userName">Loading profile...</span>
            <span className="user-role" id="userRole">Viewer</span>
          </div>
          <div className="footer-actions">
            <a href="/admin" id="adminLink" style={{ display: 'none' }}>Admin Panel</a>
            <a href="/api/auth/logout">Sign Out</a>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <div className="loading-overlay" id="loadingOverlay">
          <div className="spinner"></div>
          <div className="loading-text" id="loadingText">Fetching report data...</div>
        </div>

        <iframe className="report-iframe" id="reportIframe" name="reportIframe"></iframe>

        <div className="placeholder-panel" id="placeholderPanel">
          <div className="placeholder-card">
            <h2 id="placeholderTitle"></h2>
            <p id="placeholderDesc"></p>
          </div>
        </div>
      </main>

      <button className="mobile-menu-toggle" id="menuToggle" onClick={toggleMobileSidebar}>☰</button>
    </div>
  );
}
