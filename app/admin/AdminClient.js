'use client';

import { useEffect } from 'react';

export default function AdminPage() {
  useEffect(() => {
    var CARD_KEYS = [];
    var CARD_TABS = {}; // { cardKey: [{key,label}, ...] } - only cards with internal tabs appear here
    function esc(s) { var d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; }

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

    function loadUsers() {
      fetch('/api/admin/users').then(function (r) { return r.json(); }).then(function (d) {
        CARD_KEYS = d.cardKeys || [];
        CARD_TABS = d.cardTabs || {};
        renderInvitePerms();
        var body = document.getElementById('users-body');
        var rows = [];
        (d.users || []).forEach(function (u) {
          var perms = CARD_KEYS.map(function (k) {
            var on = u.permissions.indexOf(k) !== -1;
            var tabs = CARD_TABS[k];
            var tabsLink = (on && tabs && tabs.length) ? ' <a href="#" class="tabs-edit-link" data-uid="' + u.id + '" data-key="' + esc(k) + '">tabs</a>' : '';
            return '<span class="perm-toggle' + (on ? ' on' : '') + '" data-uid="' + u.id + '" data-key="' + esc(k) + '" data-on="' + on + '">' + esc(k) + (on ? ' ✓' : ' +') + '</span>' + tabsLink;
          }).join('');
          rows.push('<tr><td>' + esc(u.email) + '</td><td>' + esc(u.name || '') + '</td><td>' + (u.is_admin ? 'Yes' : '') + '</td><td>' + perms + '</td>' +
            '<td><a href="#" class="delete-user-link" data-uid="' + u.id + '" data-email="' + esc(u.email) + '">Delete</a></td></tr>');
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
            rows.push('<tr class="tab-edit-row" data-uid="' + u.id + '" data-key="' + esc(k) + '" style="display:none;"><td colspan="5">' +
              '<b>' + esc(k) + '</b> tabs (none checked = full access): ' + checks +
              '<button type="button" class="save-tabs-btn" data-uid="' + u.id + '" data-key="' + esc(k) + '">Save</button></td></tr>');
          });
        });
        body.innerHTML = rows.join('');
        body.querySelectorAll('.perm-toggle').forEach(function (el) {
          el.addEventListener('click', function () {
            togglePerm(el.dataset.uid, el.dataset.key, el.dataset.on === 'true');
          });
        });
        body.querySelectorAll('.tabs-edit-link').forEach(function (el) {
          el.addEventListener('click', function (e) {
            e.preventDefault();
            var row = body.querySelector('.tab-edit-row[data-uid="' + el.dataset.uid + '"][data-key="' + el.dataset.key + '"]');
            if (row) row.style.display = (row.style.display === 'none') ? 'table-row' : 'none';
          });
        });
        body.querySelectorAll('.save-tabs-btn').forEach(function (el) {
          el.addEventListener('click', function () {
            var row = el.closest('tr');
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
      });
    }

    var ACTION_LABELS = { view: 'View', login: 'Login', csv_export: 'CSV export', raw_download: 'Raw download' };
    function loadAudit() {
      fetch('/api/admin/audit').then(function (r) { return r.json(); }).then(function (d) {
        var body = document.getElementById('audit-body');
        body.innerHTML = (d.entries || []).map(function (e) {
          var action = ACTION_LABELS[e.action] || e.action || 'View';
          return '<tr><td>' + esc(e.email) + '</td><td>' + esc(action) + '</td><td>' + esc(e.cardLabel) + '</td><td>' + esc(e.detail || '') + '</td><td>' + esc(new Date(e.accessed_at).toLocaleString()) + '</td><td>' + esc(e.ip || '') + '</td></tr>';
        }).join('');
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
          <h2>Users &amp; permissions</h2>
          <table>
            <thead><tr><th>Email</th><th>Name</th><th>Admin</th><th>Reports</th><th></th></tr></thead>
            <tbody id="users-body"></tbody>
          </table>
        </section>

        <section>
          <h2>Recent access (last 200)</h2>
          <table>
            <thead><tr><th>Email</th><th>Action</th><th>Report</th><th>Detail</th><th>When</th><th>IP</th></tr></thead>
            <tbody id="audit-body"></tbody>
          </table>
        </section>
      </div>
      <div id="denied" className="denied" style={{ display: 'none' }}>
        <p>You don&apos;t have admin access.</p>
        <a className="home-link" href="/" target="_top" style={{ justifyContent: 'center' }}>&larr; Back to Home</a>
      </div>
    </div>
  );
}
