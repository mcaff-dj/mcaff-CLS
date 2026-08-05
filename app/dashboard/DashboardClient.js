'use client';

import { useEffect } from 'react';

var currentBrand = '';
var currentTabId = '';
var userCards = [];
var brandColors = {
  mcaffeine: { accent: 'var(--mcaff)', bg: 'rgba(74, 58, 167, 0.08)', fg: 'var(--mcaff)' },
  hyphen: { accent: 'var(--hyphen)', bg: 'rgba(25, 156, 92, 0.08)', fg: 'var(--hyphen)' },
  productkyc: { accent: 'var(--pkyc)', bg: 'rgba(194, 116, 12, 0.08)', fg: 'var(--pkyc)' }
};

function toggleMobileSidebar() {
  var sidebar = document.querySelector('.dashboard-page .sidebar');
  var toggle = document.getElementById('menuToggle');
  sidebar.classList.toggle('open');
  toggle.innerHTML = sidebar.classList.contains('open') ? '✕' : '☰';
}

// Handle Brand Switch
function onBrandChange(brandKey) {
  currentBrand = brandKey;
  var config = brandColors[brandKey] || brandColors.mcaffeine;

  // Update Brand accent colors in UI
  var root = document.documentElement;
  root.style.setProperty('--brand-accent', config.accent);
  root.style.setProperty('--active-bg', config.bg);
  root.style.setProperty('--active-fg', config.fg);

  // Hide/Show Granularity switcher (Only mcaffeine and hyphen have weekly data)
  var hasWeekly = (brandKey === 'mcaffeine' || brandKey === 'hyphen');
  document.getElementById('granularitySection').style.display = hasWeekly ? 'flex' : 'none';

  // Load Report in iframe
  var iframe = document.getElementById('reportIframe');
  iframe.classList.remove('loaded');
  document.getElementById('loadingOverlay').style.opacity = '1';
  document.getElementById('loadingOverlay').style.visibility = 'visible';
  document.getElementById('loadingText').textContent = 'Loading ' + brandKey + ' report...';

  iframe.src = '/api/report/' + encodeURIComponent(brandKey);
}

// Handles Iframe loaded event
function onIframeLoaded() {
  var iframe = document.getElementById('reportIframe');
  if (!iframe.src || iframe.src.indexOf('about:blank') !== -1) return;

  var doc = iframe.contentDocument || iframe.contentWindow.document;

  // Inject CSS into iframe to hide header, home link, tabs and footer
  var style = doc.createElement('style');
  style.textContent = `
    header.hero, nav.tab-nav, footer, .home-link { display: none !important; }
    .wrap { max-width: 100% !important; padding: 0 !important; margin: 0 !important; }
    body { padding: 8px 16px 40px !important; background: transparent !important; }
    section { border-radius: 12px !important; box-shadow: none !important; border: 1px solid var(--border) !important; margin-bottom: 20px !important; }
  `;
  doc.head.appendChild(style);

  // Extract tabs from iframe
  var tabBtns = doc.querySelectorAll('.tab-nav .tab-btn');
  var navList = document.getElementById('navList');

  if (tabBtns.length > 0) {
    navList.innerHTML = Array.prototype.slice.call(tabBtns).map(function (btn) {
      var id = btn.getAttribute('data-tab');
      var label = btn.textContent.trim();
      var isActive = btn.classList.contains('active');
      if (isActive) currentTabId = id;

      return '<button class="nav-btn' + (isActive ? ' active' : '') + '" data-tab="' + id + '" onclick="selectTab(\'' + id + '\')">'
        + label + ' <span style="font-size: 10px; opacity: 0.6;">&rarr;</span></button>';
    }).join('');
  } else {
    navList.innerHTML = '<span style="font-size:12px; color:var(--text-muted); padding-left:8px;">General View</span>';
  }

  // Sync active granularity
  syncGranularityUI();

  // Show iframe
  iframe.classList.add('loaded');
  document.getElementById('loadingOverlay').style.opacity = '0';
  document.getElementById('loadingOverlay').style.visibility = 'hidden';

  // Auto close mobile sidebar
  document.querySelector('.dashboard-page .sidebar').classList.remove('open');
  document.getElementById('menuToggle').innerHTML = '☰';
}

// Switch tab inside iframe
function selectTab(tabId) {
  currentTabId = tabId;
  var iframe = document.getElementById('reportIframe');
  var doc = iframe.contentDocument || iframe.contentWindow.document;

  // Click the tab button inside the iframe
  var innerBtn = doc.querySelector('.tab-nav .tab-btn[data-tab="' + tabId + '"]');
  if (innerBtn) {
    innerBtn.click();
  }

  // Update Active Navigation Button in Sidebar
  var btns = document.querySelectorAll('#navList .nav-btn');
  btns.forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
  });

  // Sync time granularity if weekly is selected and tab is switched
  var activeGranBtn = document.querySelector('.gran-toggle .gran-btn.active');
  if (activeGranBtn) {
    var gran = activeGranBtn.getAttribute('id') === 'granWeekly' ? 'weekly' : 'monthly';
    setGranularity(gran);
  }
}

// Set Time Granularity in Iframe
function setGranularity(mode) {
  // Update UI active state
  document.getElementById('granMonthly').classList.toggle('active', mode === 'monthly');
  document.getElementById('granWeekly').classList.toggle('active', mode === 'weekly');

  var iframe = document.getElementById('reportIframe');
  if (!iframe || !iframe.contentWindow) return;

  // Call report's native granularity switches
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

  // See if active class contains monthly/weekly controls
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

export default function DashboardPage() {
  useEffect(() => {
    // Expose the tab-switch handler on window since populateReportNav's dynamically
    // built innerHTML (above) still wires it via a literal onclick="selectTab(...)"
    // attribute string, same as the original static HTML page.
    window.selectTab = selectTab;

    function onDomReady() {
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
          if (userCards.length === 0) {
            document.getElementById('loadingText').textContent = 'No reports shared with you yet. Contact your admin.';
            return;
          }

          // Populate select list
          var brandSelect = document.getElementById('brandSelect');
          brandSelect.innerHTML = userCards.map(function (c) {
            return '<option value="' + c.key + '">' + c.label + '</option>';
          }).join('');

          // Select first brand
          onBrandChange(userCards[0].key);
        })
        .catch(function () {
          window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
        });

      // Hook iframe load event
      var iframe = document.getElementById('reportIframe');
      iframe.addEventListener('load', onIframeLoaded);
    }

    onDomReady();
  }, []);

  return (
    <div className="dashboard-page">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <a className="home-link" href="/" target="_top">&larr; Dashboard Home</a>
          <div className="logo-container">
            <h1 className="logo-title">CX Unified Dashboard</h1>
          </div>
        </div>

        <div className="sidebar-scroll">
          <div className="section">
            <span className="section-title">Brand Report</span>
            <div className="brand-select-wrapper">
              <select id="brandSelect" className="brand-select" onChange={(e) => onBrandChange(e.target.value)}>
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

      {/* Main Content Area */}
      <main className="main-content">
        <div className="loading-overlay" id="loadingOverlay">
          <div className="spinner"></div>
          <div className="loading-text" id="loadingText">Fetching report data...</div>
        </div>

        <iframe className="report-iframe" id="reportIframe" name="reportIframe"></iframe>
      </main>

      <button className="mobile-menu-toggle" id="menuToggle" onClick={toggleMobileSidebar}>☰</button>
    </div>
  );
}
