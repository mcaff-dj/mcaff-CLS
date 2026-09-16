'use client';

import { useEffect } from 'react';

export default function AdminPage() {
  useEffect(() => {
    var CARD_KEYS = [];
    var CARD_TABS = {}; // { cardKey: [{key,label}, ...] } - only cards with internal tabs appear here
    function esc(s) { var d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; }

    var BADGE_COLORS = ['#e8863a', '#6b4a86', '#3f8f5f', '#2b7de0', '#c2740c', '#9333ea', '#c1447e', '#1b998b'];
    function colorForKey(key) {
      var hash = 0;
      for (var i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
      return BADGE_COLORS[hash % BADGE_COLORS.length];
    }

    function initials(nameOrEmail) {
      var s = (nameOrEmail || '').trim();
      if (!s) return '?';
      var parts = s.indexOf('@') !== -1 ? [s.split('@')[0]] : s.split(/\s+/);
      var first = parts[0] ? parts[0][0] : '';
      var second = parts[1] ? parts[1][0] : (parts[0] && parts[0][1] ? parts[0][1] : '');
      return (first + second).toUpperCase();
    }

    var ACTION_META = {
      view: { icon: '◎', color: '#3f8f5f', bg: '#e7f3ea' },
      login: { icon: '⇥', color: '#6b4a86', bg: '#eee6f4' },
      csv_export: { icon: '⇩', color: '#e8863a', bg: '#fbe6d4' },
      raw_download: { icon: '⬇', color: '#2b7de0', bg: '#e3edfb' }
    };
    function timeAgo(iso) {
      var diff = Date.now() - new Date(iso).getTime();
      if (!(diff >= 0)) diff = 0;
      var m = Math.floor(diff / 60000);
      if (m < 1) return 'just now';
      if (m < 60) return m + 'm ago';
      var h = Math.floor(m / 60);
      if (h < 24) return h + 'h ago';
      return Math.floor(h / 24) + 'd ago';
    }

    // One card's chip, plus - if that card has internal tabs (CARD_TABS[key]) - a
    // "customize tabs" link revealing a checklist to restrict the grant to just
    // those tabs (UI-level convenience only, see report_tab_permissions in db.js).
    // Leaving the checklist untouched (never expanded) grants every tab, same as
    // before this feature existed.
    function renderPermBlock(key) {
      var chip = '<label class="chip"><input type="checkbox" class="card-chk" value="' + esc(key) + '"> ' + esc(key) + '</label>';
      var tabs = CARD_TABS[key];
      if (!tabs || !tabs.length) return '<div class="card-perm-block">' + chip + '</div>';
      var tabChips = tabs.map(function (t) {
        return '<label class="tab-chip"><input type="checkbox" class="tab-chk" value="' + esc(t.key) + '"> ' + esc(t.label) + '</label>';
      }).join('');
      return '<div class="card-perm-block" data-card="' + esc(key) + '">' + chip +
        ' <a href="#" class="tab-toggle-link" data-card="' + esc(key) + '">customize tabs</a>' +
        '<div class="tab-subrow" data-card="' + esc(key) + '" style="display:none;">' + tabChips + '</div>' +
        '</div>';
    }

    function wireTabToggleLinks(container) {
      container.querySelectorAll('.tab-toggle-link').forEach(function (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          var subrow = container.querySelector('.tab-subrow[data-card="' + link.dataset.card + '"]');
          var showing = subrow.style.display !== 'none';
          subrow.style.display = showing ? 'none' : 'flex';
          if (!showing) subrow.dataset.touched = '1';
        });
      });
    }

    // perms = checked top-level card checkboxes. tabPermissions only includes a
    // card key if its "customize tabs" checklist was actually expanded - so a card
    // nobody touched never gets an (accidentally empty) restriction.
    function collectPerms(containerId) {
      var container = document.getElementById(containerId);
      var perms = Array.prototype.slice.call(container.querySelectorAll('.card-chk:checked')).map(function (c) { return c.value; });
      var tabPermissions = {};
      Array.prototype.slice.call(container.querySelectorAll('.tab-subrow')).forEach(function (subrow) {
        if (subrow.dataset.touched !== '1') return;
        tabPermissions[subrow.dataset.card] = Array.prototype.slice.call(subrow.querySelectorAll('.tab-chk:checked')).map(function (c) { return c.value; });
      });
      return { perms: perms, tabPermissions: tabPermissions };
    }

    function renderInvitePerms() {
      var invWrap = document.getElementById('inv-perms');
      invWrap.innerHTML = CARD_KEYS.map(renderPermBlock).join('');
      wireTabToggleLinks(invWrap);
      var bulkWrap = document.getElementById('bulk-perms');
      bulkWrap.innerHTML = CARD_KEYS.map(renderPermBlock).join('');
      wireTabToggleLinks(bulkWrap);
    }

    function parseBulkEmails(raw) {
      return raw.split('\n').map(function (line) {
        line = line.trim();
        if (!line) return null;
        var parts = line.split(',');
        var email = (parts[0] || '').trim().toLowerCase();
        var name = parts.slice(1).join(',').trim();
        if (!email) return null;
        return { email: email, name: name };
      }).filter(Boolean);
    }

    function togglePerm(userId, cardKey, on) {
      fetch('/api/admin/permissions', {
        method: on ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userId, cardKey: cardKey })
      }).then(function (r) { return r.json(); }).then(function () {
        loadUsers();
      });
    }

    var ALL_USERS = [];
    var EXPANDED = {}; // uid -> bool, survives loadUsers() re-renders so an open row stays open

    function renderUsersTable(users) {
        var body = document.getElementById('users-body');
        var rows = [];
        users.forEach(function (u) {
          var grantedCount = u.permissions.length;
          var badges = CARD_KEYS.map(function (k) {
            var on = u.permissions.indexOf(k) !== -1;
            var tabs = CARD_TABS[k];
            var tabsLink = (on && tabs && tabs.length) ? ' <a href="#" class="tabs-edit-link" data-uid="' + u.id + '" data-key="' + esc(k) + '">tabs</a>' : '';
            var style = on ? ' style="background:' + colorForKey(k) + '"' : '';
            return '<span class="perm-toggle' + (on ? '' : ' off') + '"' + style + ' data-uid="' + u.id + '" data-key="' + esc(k) + '" data-on="' + on + '">' + esc(k) + '</span>' + tabsLink;
          }).join('');
          rows.push('<div class="ucard' + (EXPANDED[u.id] ? ' expanded' : '') + '" data-uid="' + u.id + '">' +
            '<div class="ucard-head" data-uid="' + u.id + '">' +
            '<span class="avatar" style="background:' + colorForKey(u.email) + '">' + esc(initials(u.name || u.email)) + '</span>' +
            '<div class="uinfo"><div class="uname">' + esc(u.name || u.email) + (u.is_admin ? ' <span class="admin-star" title="Admin">⭐</span>' : '') + '</div>' +
            '<div class="uemail">' + esc(u.email) + '</div></div>' +
            '<span class="perm-count">' + grantedCount + ' of ' + CARD_KEYS.length + ' reports</span>' +
            '<span class="chevron">&#8964;</span>' +
            '</div>' +
            '<a href="#" class="delete-user-link" data-uid="' + u.id + '" data-email="' + esc(u.email) + '">Remove</a>' +
            '<div class="utags">' + badges + '</div>' +
            '</div>');
          // One hidden edit-row per restrictable card, pre-checked from the user's
          // current tabPermissions - revealed by the "tabs" link above.
          CARD_KEYS.forEach(function (k) {
            var tabs = CARD_TABS[k];
            if (!tabs || !tabs.length) return;
            var current = (u.tabPermissions && u.tabPermissions[k]) || [];
            var checks = tabs.map(function (t) {
              var checked = current.indexOf(t.key) !== -1;
              return '<label class="tab-chip"><input type="checkbox" class="edit-tab-chk" value="' + esc(t.key) + '"' + (checked ? ' checked' : '') + '> ' + esc(t.label) + '</label>';
            }).join('');
            rows.push('<div class="tab-edit-row" data-uid="' + u.id + '" data-key="' + esc(k) + '" style="display:none;">' +
              '<b>' + esc(k) + '</b> tabs (none checked = full access): ' + checks +
              '<button type="button" class="save-tabs-btn" data-uid="' + u.id + '" data-key="' + esc(k) + '">Save</button></div>');
          });
        });
        body.innerHTML = rows.join('');
        body.querySelectorAll('.ucard-head').forEach(function (el) {
          el.addEventListener('click', function () {
            var card = el.closest('.ucard');
            EXPANDED[el.dataset.uid] = card.classList.toggle('expanded');
          });
        });
        body.querySelectorAll('.perm-toggle').forEach(function (el) {
          el.addEventListener('click', function () {
            togglePerm(el.dataset.uid, el.dataset.key, el.dataset.on === 'true');
          });
        });
        body.querySelectorAll('.tabs-edit-link').forEach(function (el) {
          el.addEventListener('click', function (e) {
            e.preventDefault();
            var row = body.querySelector('.tab-edit-row[data-uid="' + el.dataset.uid + '"][data-key="' + el.dataset.key + '"]');
            if (row) row.style.display = (row.style.display === 'none') ? 'block' : 'none';
          });
        });
        body.querySelectorAll('.save-tabs-btn').forEach(function (el) {
          el.addEventListener('click', function () {
            var row = el.closest('.tab-edit-row');
            var tabKeys = Array.prototype.slice.call(row.querySelectorAll('.edit-tab-chk:checked')).map(function (c) { return c.value; });
            fetch('/api/admin/permissions', {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: el.dataset.uid, cardKey: el.dataset.key, tabKeys: tabKeys })
            }).then(function (r) { return r.json(); }).then(function () { loadUsers(); });
          });
        });
        body.querySelectorAll('.delete-user-link').forEach(function (el) {
          el.addEventListener('click', function (e) {
            e.preventDefault();
            if (!confirm('Delete ' + el.dataset.email + '? This removes their account and all report access. This cannot be undone.')) return;
            fetch('/api/admin/users', {
              method: 'DELETE', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: el.dataset.uid })
            }).then(function (r) { return r.json(); }).then(function (d) {
              if (d.error) { alert(d.error); return; }
              loadUsers();
            });
          });
        });
    }

    function loadUsers() {
      fetch('/api/admin/users').then(function (r) { return r.json(); }).then(function (d) {
        CARD_KEYS = d.cardKeys || [];
        CARD_TABS = d.cardTabs || {};
        ALL_USERS = d.users || [];
        renderInvitePerms();
        renderUsersTable(filterUsers(document.getElementById('user-search').value));
        document.getElementById('stat-users').textContent = ALL_USERS.length;
        document.getElementById('stat-admins').textContent = ALL_USERS.filter(function (u) { return u.is_admin; }).length;
        document.getElementById('stat-reports').textContent = CARD_KEYS.length;
      });
    }

    function filterUsers(query) {
      query = (query || '').trim().toLowerCase();
      if (!query) return ALL_USERS;
      return ALL_USERS.filter(function (u) {
        return (u.email || '').toLowerCase().indexOf(query) !== -1 ||
          (u.name || '').toLowerCase().indexOf(query) !== -1;
      });
    }

    document.getElementById('user-search').addEventListener('input', function () {
      renderUsersTable(filterUsers(this.value));
    });

    var ACTION_LABELS = { view: 'viewed', login: 'logged in', csv_export: 'exported CSV from', raw_download: 'downloaded raw data from' };
    function loadAudit() {
      fetch('/api/admin/audit').then(function (r) { return r.json(); }).then(function (d) {
        var entries = d.entries || [];
        var body = document.getElementById('audit-body');
        body.innerHTML = entries.map(function (e) {
          var meta = ACTION_META[e.action] || { icon: '•', color: '#7d7061', bg: '#efe4d3' };
          var verb = ACTION_LABELS[e.action] || esc(e.action || 'viewed');
          var what = verb + (e.cardLabel ? ' ' + esc(e.cardLabel) : '') + (e.detail ? ' — ' + esc(e.detail) : '');
          return '<div class="feed-row"><span class="feed-icon" style="background:' + meta.bg + ';color:' + meta.color + '">' + meta.icon + '</span>' +
            '<span class="feed-who">' + esc(e.email) + '</span>' +
            '<span class="feed-what">' + what + '</span>' +
            '<span class="feed-when" title="' + esc(new Date(e.accessed_at).toLocaleString()) + '">' + timeAgo(e.accessed_at) + '</span></div>';
        }).join('');
        var dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        document.getElementById('stat-events').textContent = entries.filter(function (e) { return new Date(e.accessed_at).getTime() >= dayAgo; }).length;
      });
    }

    document.getElementById('inv-submit').addEventListener('click', function () {
      var email = document.getElementById('inv-email').value.trim();
      var name = document.getElementById('inv-name').value.trim();
      var picked = collectPerms('inv-perms');
      var msg = document.getElementById('inv-msg');
      if (!email) { msg.textContent = 'Email is required.'; return; }
      fetch('/api/admin/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, name: name, permissions: picked.perms, tabPermissions: picked.tabPermissions })
      }).then(function (r) { return r.json(); }).then(function (d) {
        msg.textContent = d.error ? d.error : 'Saved.';
        document.getElementById('inv-email').value = '';
        document.getElementById('inv-name').value = '';
        renderInvitePerms();
        loadUsers();
      });
    });

    document.getElementById('bulk-submit').addEventListener('click', function () {
      var raw = document.getElementById('bulk-emails').value;
      var users = parseBulkEmails(raw);
      var picked = collectPerms('bulk-perms');
      var msg = document.getElementById('bulk-msg');
      if (!users.length) { msg.textContent = 'Enter at least one email.'; return; }
      msg.textContent = 'Inviting ' + users.length + ' people…';
      fetch('/api/admin/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ users: users, permissions: picked.perms, tabPermissions: picked.tabPermissions })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d.error) { msg.textContent = d.error; return; }
        var results = d.results || [];
        var ok = results.filter(function (r) { return r.ok; }).length;
        var failed = results.filter(function (r) { return !r.ok; });
        var text = ok + ' of ' + results.length + ' invited.';
        if (failed.length) {
          text += ' Failed: ' + failed.map(function (f) { return f.email + ' (' + f.error + ')'; }).join(', ');
        }
        msg.textContent = text;
        document.getElementById('bulk-emails').value = '';
        renderInvitePerms();
        loadUsers();
      });
    });

    fetch('/api/auth/me').then(function (r) { return r.json(); }).then(function (d) {
      if (!d.authenticated) { location.href = '/login?next=' + encodeURIComponent('/admin'); return; }
      if (!d.isAdmin) { document.getElementById('denied').style.display = 'block'; return; }
      document.getElementById('app').style.display = 'block';
      loadUsers();
      loadAudit();
    });
  }, []);

  return (
    <div className="admin-page">
      <div className="wrap" id="app" style={{ display: 'none' }}>
        <a className="home-link" href="/" target="_top">&larr; Home</a>
        <h1>Access Management</h1>
        <p className="sub">Invite people, grant/revoke per-report access, and see who&apos;s viewed what.</p>

        <div className="stats">
          <div className="stat"><div className="stat-v" id="stat-users" style={{ color: '#e8863a' }}>&mdash;</div><div className="stat-l">Users</div></div>
          <div className="stat"><div className="stat-v" id="stat-admins" style={{ color: '#6b4a86' }}>&mdash;</div><div className="stat-l">Admins</div></div>
          <div className="stat"><div className="stat-v" id="stat-reports" style={{ color: '#3f8f5f' }}>&mdash;</div><div className="stat-l">Reports</div></div>
          <div className="stat"><div className="stat-v" id="stat-events" style={{ color: '#c2740c' }}>&mdash;</div><div className="stat-l">Events / 24h</div></div>
        </div>

        <section>
          <h2>Invite a user</h2>
          <div className="row">
            <div><label htmlFor="inv-email">Email</label><input type="email" id="inv-email" placeholder="name@company.com" /></div>
            <div><label htmlFor="inv-name">Name (optional)</label><input type="text" id="inv-name" placeholder="Full name" /></div>
          </div>
          <div className="row">
            <div className="chip-row" id="inv-perms"></div>
          </div>
          <button id="inv-submit">Invite / Update</button>
          <div className="msg" id="inv-msg"></div>
        </section>

        <section>
          <h2>Bulk invite</h2>
          <p className="sub" style={{ marginBottom: 14 }}>One person per line: <code>email</code> or <code>email, Name</code>. Same permissions are applied to everyone in the list.</p>
          <div className="row">
            <div style={{ flex: 1, minWidth: 260 }}>
              <label htmlFor="bulk-emails">Emails</label>
              <textarea id="bulk-emails" rows={6} placeholder={'jane@company.com, Jane Doe\njohn@company.com'} className="bulk-emails-textarea"></textarea>
            </div>
          </div>
          <div className="row">
            <div className="chip-row" id="bulk-perms"></div>
          </div>
          <button id="bulk-submit">Invite all</button>
          <div className="msg" id="bulk-msg"></div>
        </section>

        <section>
          <div className="section-head">
            <h2>Users &amp; permissions</h2>
            <input type="text" id="user-search" className="search-input" placeholder="Search email or name…" />
          </div>
          <div id="users-body"></div>
        </section>

        <section>
          <h2>Recent access (last 200)</h2>
          <div id="audit-body"></div>
        </section>
      </div>
      <div id="denied" className="denied" style={{ display: 'none' }}>
        <p>You don&apos;t have admin access.</p>
        <a className="home-link" href="/" target="_top" style={{ justifyContent: 'center' }}>&larr; Back to Home</a>
      </div>
    </div>
  );
}
