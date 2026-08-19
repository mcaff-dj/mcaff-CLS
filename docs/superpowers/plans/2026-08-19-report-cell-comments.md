# Private Per-Cell Comments on Report Pivot Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user click any cell in any `.pivot-table` on the mCaffeine/Hyphen
reports, leave a note only they can see, and have it follow them across devices.

**Architecture:** Reuse the existing Google OAuth session verbatim (no new auth, no new
gate — `api/report/[card].js` already requires one before the report ever renders). A new
`report_cell_comments` MySQL table + one `[action].js` route (`list`/`save`), keyed by
`(user_id, page, cell_key)`. One generic script added once to `scripts/_shell_head.html`
scans every `.pivot-table` on the page (client-side, no Python changes) — a click on a
`td` opens a small popover; a persistent dot marks cells with a saved note.

**Tech Stack:** Node (Express handler, `mysql2`), vanilla JS (no framework — matches
every other script in `_shell_head.html`).

**Spec:** `docs/superpowers/specs/2026-08-19-report-cell-comments-design.md`

## Global Constraints

- Identity: the existing Google OAuth session (`api/_lib/session.js`'s `getSession`) —
  no new auth mechanism.
- One note per `(user, page, cell)` — overwritten on save, no history/threads.
- Never visible to any other user — comments are always scoped to `session.uid`.
- Scope: every `.pivot-table` in both reports, implemented once generically — no
  per-table wiring in `scripts/generate_report.py` / `scripts/gen_panels.py`.
- `page` = `window.REPORT_CARD` (e.g. `'mcaffeine'`/`'hyphen'`, already injected by
  `gen_panels.py:1813` and already used for the same purpose by the existing CSV-export
  log call) — **not** `location.pathname` as an earlier draft of the spec said; this was
  corrected during planning once `window.REPORT_CARD` was found. Falls back to
  `location.pathname` only if `REPORT_CARD` is ever unset.
- No offline queueing: a save while offline/signed-out fails visibly, note text stays in
  the textarea so the user can retry.
- No automated test can touch the real MySQL/session (standing project rule — the user
  runs anything against real data/deploys themselves). Every test below is a pure/offline
  Node script, same convention as `api/_lib/db.mom.test.js` and
  `api/delivery-escalation/fresh-export.test.js` — no live DB connection, ever.

---

## Task 1: `report_cell_comments` table + db.js functions

**Files:**
- Modify: `api/_lib/db.js:357` (schema), `api/_lib/db.js:2485` (new functions), `api/_lib/db.js:2517` (exports)
- Test: `api/_lib/db.reportCellComments.test.js`

**Interfaces:**
- Produces: `shouldDeleteCellComment(text) -> boolean`, `getCellComments(userId, page) -> Promise<{[cellKey]: string}>`, `saveCellComment(userId, page, cellKey, text) -> Promise<void>`. Task 2 imports `getCellComments`/`saveCellComment` from `../_lib/db`.

- [ ] **Step 1: Write the failing test**

Create `api/_lib/db.reportCellComments.test.js`:

```js
// Offline self-check for shouldDeleteCellComment in db.js - pure/offline, never opens a
// connection. Run with `node api/_lib/db.reportCellComments.test.js`.
const assert = require('assert');
const { shouldDeleteCellComment } = require('./db');

(async () => {
  assert.strictEqual(shouldDeleteCellComment(''), true);
  assert.strictEqual(shouldDeleteCellComment('   '), true);
  assert.strictEqual(shouldDeleteCellComment(undefined), true);
  assert.strictEqual(shouldDeleteCellComment(null), true);
  assert.strictEqual(shouldDeleteCellComment('a note'), false);
  assert.strictEqual(shouldDeleteCellComment('  a note  '), false);

  console.log('db.reportCellComments.test.js: all assertions passed');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node api/_lib/db.reportCellComments.test.js`
Expected: throws `TypeError: shouldDeleteCellComment is not a function` (not yet exported).

- [ ] **Step 3: Add the schema + functions**

In `api/_lib/db.js`, find this exact block (end of `bootstrapSchema`, currently lines
347-358):

```js
  await sql`
    CREATE TABLE IF NOT EXISTS mom_task_field_values (
      task_id INT NOT NULL,
      column_id INT NOT NULL,
      value TEXT,
      PRIMARY KEY (task_id, column_id),
      FOREIGN KEY (task_id) REFERENCES mom_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (column_id) REFERENCES mom_columns(id) ON DELETE CASCADE
    )
  `;
  schemaReady = true;
}
```

Replace with (adds the new table right before the function's closing line):

```js
  await sql`
    CREATE TABLE IF NOT EXISTS mom_task_field_values (
      task_id INT NOT NULL,
      column_id INT NOT NULL,
      value TEXT,
      PRIMARY KEY (task_id, column_id),
      FOREIGN KEY (task_id) REFERENCES mom_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (column_id) REFERENCES mom_columns(id) ON DELETE CASCADE
    )
  `;
  // Private per-cell notes on report pivot tables (see docs/superpowers/specs/
  // 2026-08-19-report-cell-comments-design.md) - one row per (user, page, cell), never
  // read by anyone but the user who wrote it. `cell_key` is a client-derived, content-based
  // string (pivot title + row label + column header path), not a DOM position, so it stays
  // stable across the nightly report regeneration.
  await sql`
    CREATE TABLE IF NOT EXISTS report_cell_comments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      page VARCHAR(255) NOT NULL,
      cell_key VARCHAR(255) NOT NULL,
      comment TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_user_page_cell (user_id, page, cell_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `;
  schemaReady = true;
}
```

Then, in `api/_lib/db.js`, find this exact block (end of `deleteMomStatus`, currently
lines 2478-2486):

```js
async function deleteMomStatus(boardId, statusKey) {
  const { rows: statuses } = await sql`
    SELECT status_key, position FROM mom_statuses WHERE board_id = ${boardId}
  `;
  const target = resolveStatusForDeletion(statuses, statusKey);
  await sql`UPDATE mom_tasks SET status_key = ${target} WHERE board_id = ${boardId} AND status_key = ${statusKey}`;
  await sql`DELETE FROM mom_statuses WHERE board_id = ${boardId} AND status_key = ${statusKey}`;
}

module.exports = {
```

Replace with:

```js
async function deleteMomStatus(boardId, statusKey) {
  const { rows: statuses } = await sql`
    SELECT status_key, position FROM mom_statuses WHERE board_id = ${boardId}
  `;
  const target = resolveStatusForDeletion(statuses, statusKey);
  await sql`UPDATE mom_tasks SET status_key = ${target} WHERE board_id = ${boardId} AND status_key = ${statusKey}`;
  await sql`DELETE FROM mom_statuses WHERE board_id = ${boardId} AND status_key = ${statusKey}`;
}

// Pure - whether saving `text` should delete the row instead of writing it. Split out from
// saveCellComment so the branch is testable without a DB connection (see
// db.reportCellComments.test.js).
function shouldDeleteCellComment(text) {
  return !String(text || '').trim();
}

async function getCellComments(userId, page) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT cell_key AS cellKey, comment FROM report_cell_comments WHERE user_id = ${userId} AND page = ${page}
  `;
  const out = {};
  rows.forEach((r) => { out[r.cellKey] = r.comment; });
  return out;
}

async function saveCellComment(userId, page, cellKey, text) {
  await ensureSchema();
  if (shouldDeleteCellComment(text)) {
    await sql`DELETE FROM report_cell_comments WHERE user_id = ${userId} AND page = ${page} AND cell_key = ${cellKey}`;
    return;
  }
  const trimmed = String(text).trim();
  await sql`
    INSERT INTO report_cell_comments (user_id, page, cell_key, comment) VALUES (${userId}, ${page}, ${cellKey}, ${trimmed})
    ON DUPLICATE KEY UPDATE comment = VALUES(comment)
  `;
}

module.exports = {
```

Finally, find this exact line (currently line 2517, the last export before the closing
`};`):

```js
  createMomStatus, updateMomStatus, deleteMomStatus,
};
```

Replace with:

```js
  createMomStatus, updateMomStatus, deleteMomStatus,
  getCellComments, saveCellComment,
  // Exported for api/_lib/db.reportCellComments.test.js only - nothing in the app calls this directly.
  shouldDeleteCellComment,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node api/_lib/db.reportCellComments.test.js`
Expected: `db.reportCellComments.test.js: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add api/_lib/db.js api/_lib/db.reportCellComments.test.js
git commit -m "feat: add report_cell_comments table + db functions"
```

---

## Task 2: `/api/report-comments/:action` route

**Files:**
- Create: `api/report-comments/[action].js`
- Test: `api/report-comments/[action].test.js`
- Modify: `api/_lambda/app.js:104-105`

**Interfaces:**
- Consumes: `getSession(req)` from `../_lib/session` (returns `null` or `{uid, email, ...}`); `getCellComments(userId, page)`, `saveCellComment(userId, page, cellKey, text)` from `../_lib/db` (Task 1).
- Produces: `GET /api/report-comments/list?page=<key>` -> `{comments: {[cellKey]: string}}` (401 if signed out); `POST /api/report-comments/save {page, cellKey, text}` -> `{ok: true}` (401 if signed out). Task 3's client script calls both.

- [ ] **Step 1: Write the failing test**

Create `api/report-comments/[action].test.js`:

```js
// Offline self-check for api/report-comments/[action].js - pure/offline, never opens a
// connection. Run with `node "api/report-comments/[action].test.js"`. getSession(req) with
// no cookie header returns null without touching the DB (see api/_lib/session.js's
// parseCookies/verify), so the 401 path is safely testable here; list/save's DB-touching
// happy paths are not (same convention as api/delivery-escalation/fresh-export.test.js).
const assert = require('assert');
const handler = require('./[action]');

(async () => {
  // 1. No session -> 401 on the list action.
  {
    let statusCode, body;
    const req = { method: 'GET', headers: {}, query: { action: 'list' } };
    const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
    await handler(req, res);
    assert.strictEqual(statusCode, 401);
    assert.match(body.error, /Not signed in/);
  }

  // 2. No session -> 401 on the save action too (auth is checked before routing).
  {
    let statusCode, body;
    const req = { method: 'POST', headers: {}, query: { action: 'save' }, body: { page: 'mcaffeine', cellKey: 'x', text: 'y' } };
    const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
    await handler(req, res);
    assert.strictEqual(statusCode, 401);
    assert.match(body.error, /Not signed in/);
  }

  // 3. No session -> 401 even for an unrecognized action (auth still checked first).
  {
    let statusCode, body;
    const req = { method: 'GET', headers: {}, query: { action: 'bogus' } };
    const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
    await handler(req, res);
    assert.strictEqual(statusCode, 401);
    assert.match(body.error, /Not signed in/);
  }

  console.log('[action].test.js: all assertions passed');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node "api/report-comments/[action].test.js"`
Expected: `Cannot find module './[action]'` (file doesn't exist yet).

- [ ] **Step 3: Write the route handler**

Create `api/report-comments/[action].js`:

```js
// Private per-cell notes on report pivot tables (mcaffeine.html/hyphen.html and any other
// report reusing scripts/_shell_head.html's shared CSS/JS) - one note per (signed-in user,
// page, cell), never visible to anyone else. Same [action].js convention as
// api/auth/[action].js and api/escalation/[action].js, mounted the same way in
// api/_lambda/app.js.
//
// Actions: list | save
//
// By the time a report renders at all, api/report/[card].js has already required a
// session (see that file's header comment) - so in normal use this route is never
// actually reached signed-out. The 401 path below only matters if the session cookie
// expires while the report tab stays open (see the design doc's Client behavior section
// for how the sign-in link handles that from inside the report's iframe).
const { getSession } = require('../_lib/session');
const { getCellComments, saveCellComment } = require('../_lib/db');

const handler = async (req, res) => {
  const action = (req.query && req.query.action) || '';
  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  try {
    if (action === 'list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const page = (req.query && req.query.page) || '';
      if (!page) return res.status(400).json({ error: 'page is required' });
      const comments = await getCellComments(session.uid, page);
      return res.status(200).json({ comments });
    }

    if (action === 'save') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { page, cellKey, text } = req.body || {};
      if (!page) return res.status(400).json({ error: 'page is required' });
      if (!cellKey) return res.status(400).json({ error: 'cellKey is required' });
      await saveCellComment(session.uid, page, cellKey, text || '');
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Unknown report-comments route' });
  } catch (e) {
    console.error(`api/report-comments/${action} error:`, e);
    return res.status(500).json({ error: e.message || 'Report-comments request failed' });
  }
};

module.exports = handler;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node "api/report-comments/[action].test.js"`
Expected: `[action].test.js: all assertions passed`

- [ ] **Step 5: Mount the route**

In `api/_lambda/app.js`, find this exact block (currently lines 102-105):

```js
// The Escalation desk's whole API surface - one dynamic-segment handler, same shape as the
// two :action mounts above (agents/orders/assign/tag/update/bulk-update/import/export/sample).
mount('all', '/api/escalation/:action', '../escalation/[action].js', 'action');
```

Replace with:

```js
// The Escalation desk's whole API surface - one dynamic-segment handler, same shape as the
// two :action mounts above (agents/orders/assign/tag/update/bulk-update/import/export/sample).
mount('all', '/api/escalation/:action', '../escalation/[action].js', 'action');

// Private per-cell report comments (list/save) - see docs/superpowers/specs/
// 2026-08-19-report-cell-comments-design.md.
mount('all', '/api/report-comments/:action', '../report-comments/[action].js', 'action');
```

- [ ] **Step 6: Commit**

```bash
git add api/report-comments/[action].js "api/report-comments/[action].test.js" api/_lambda/app.js
git commit -m "feat: mount /api/report-comments list/save route"
```

---

## Task 3: Client — comment popover on every pivot table

**Files:**
- Modify: `scripts/_shell_head.html` (CSS block near line 147; `tableToGrid` near lines 581-610; new script block after the CSV-export script, currently ending line 668)

**Interfaces:**
- Consumes: `window.tableToGrid` (extended in this task), `/api/auth/me` (existing), `/api/report-comments/list`/`save` (Task 2), `window.REPORT_CARD` (already set by `gen_panels.py:1813`).
- Produces: nothing consumed by a later task — this is the last task.

No automated test: this is plain browser JS with no test runner anywhere in this repo's
`scripts/*.html` (matches the CSV-export script it sits beside, which also has none).
Verified via the manual QA checklist in Step 4 — **the user runs this after their own
deploy**, per this project's standing rule that live DB/server checks and deploys are
never run by the assistant.

- [ ] **Step 1: Extend `tableToGrid` to expose element positions and an unfiltered mode**

In `scripts/_shell_head.html`, find this exact block (currently lines 579-610):

```js
  function isVisible(el){ return el.offsetParent !== null; }

  function tableToGrid(table){
    var rows = Array.prototype.filter.call(table.querySelectorAll('tr'), isVisible);
    var grid = [];
    var rowSpans = {};
    rows.forEach(function(tr, r){
      grid[r] = grid[r] || [];
      var cells = Array.prototype.filter.call(tr.querySelectorAll('th,td'), isVisible);
      var c = 0, ci = 0;
      while (ci < cells.length || rowSpans[c]) {
        if (rowSpans[c] && rowSpans[c].remaining > 0) {
          grid[r][c] = rowSpans[c].value;
          rowSpans[c].remaining--;
          if (rowSpans[c].remaining === 0) delete rowSpans[c];
          c++;
          continue;
        }
        if (ci >= cells.length) break;
        var td = cells[ci++];
        var text = td.textContent.replace(/\s+/g,' ').trim();
        var colspan = parseInt(td.getAttribute('colspan') || '1', 10) || 1;
        var rowspan = parseInt(td.getAttribute('rowspan') || '1', 10) || 1;
        for (var k = 0; k < colspan; k++) {
          grid[r][c] = text;
          if (rowspan > 1) { rowSpans[c] = { remaining: rowspan - 1, value: text }; }
          c++;
        }
      }
    });
    return grid;
  }
```

Replace with (adds an optional `posMap` the caller can read `element -> [row, col]` back
out of, and an optional `includeHidden` flag the comment feature needs because most tabs
start `display:none` - `isVisible` would otherwise see zero rows in every inactive tab;
the CSV export's own call site is unchanged and keeps filtering hidden rows, since that's
what makes it match whatever the visitor is currently looking at):

```js
  function isVisible(el){ return el.offsetParent !== null; }

  function tableToGrid(table, posMap, includeHidden){
    var keep = includeHidden ? function(){ return true; } : isVisible;
    var rows = Array.prototype.filter.call(table.querySelectorAll('tr'), keep);
    var grid = [];
    var rowSpans = {};
    rows.forEach(function(tr, r){
      grid[r] = grid[r] || [];
      var cells = Array.prototype.filter.call(tr.querySelectorAll('th,td'), keep);
      var c = 0, ci = 0;
      while (ci < cells.length || rowSpans[c]) {
        if (rowSpans[c] && rowSpans[c].remaining > 0) {
          grid[r][c] = rowSpans[c].value;
          rowSpans[c].remaining--;
          if (rowSpans[c].remaining === 0) delete rowSpans[c];
          c++;
          continue;
        }
        if (ci >= cells.length) break;
        var td = cells[ci++];
        var text = td.textContent.replace(/\s+/g,' ').trim();
        var colspan = parseInt(td.getAttribute('colspan') || '1', 10) || 1;
        var rowspan = parseInt(td.getAttribute('rowspan') || '1', 10) || 1;
        for (var k = 0; k < colspan; k++) {
          grid[r][c] = text;
          if (rowspan > 1) { rowSpans[c] = { remaining: rowspan - 1, value: text }; }
          if (posMap) posMap.set(td, [r, c]);
          c++;
        }
      }
    });
    return grid;
  }
  window.tableToGrid = tableToGrid;
```

- [ ] **Step 2: Verify the CSV export still works from this change alone**

Run: `node -e "require('fs').readFileSync('scripts/_shell_head.html','utf8')" ` (just a
syntax sanity read — this file has no test harness). Then re-read the modified block and
confirm `window.exportPivotTable`'s own call, `tableToGrid(table)` (one argument, further
down in the same script, unchanged by this step), still gets `posMap=undefined,
includeHidden=undefined` → `keep = isVisible` → byte-for-byte the same behavior as
before this step.

- [ ] **Step 3: Add the popover CSS**

In `scripts/_shell_head.html`, find this exact line (currently line 147):

```css
  .slot-hit:hover{opacity:.045;}
```

Replace with:

```css
  .slot-hit:hover{opacity:.045;}

  /* Private per-cell comments (see docs/superpowers/specs/2026-08-19-report-cell-comments-design.md) */
  .pivot-table td{cursor:pointer;}
  .pivot-table td:hover{box-shadow:inset 0 0 0 1px var(--s1);}
  .cell-comment-dot{position:relative;}
  .cell-comment-dot::after{content:'';position:absolute;top:2px;right:2px;width:5px;height:5px;border-radius:50%;background:var(--s1);}
  .cell-comment-popover{position:fixed;z-index:50;width:260px;background:var(--surface-1);
    border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.22);
    padding:12px;display:none;font-size:13px;box-sizing:border-box;}
  .cell-comment-popover.open{display:block;}
  .cell-comment-popover .ccp-head{font-weight:600;margin-bottom:6px;font-size:12px;color:var(--text-secondary);}
  .cell-comment-popover textarea{width:100%;min-height:70px;resize:vertical;font:inherit;
    color:var(--text-primary);background:var(--surface-card);border:1px solid var(--border);
    border-radius:6px;padding:6px 8px;box-sizing:border-box;}
  .cell-comment-popover .ccp-actions{display:flex;gap:8px;margin-top:8px;justify-content:flex-end;}
  .cell-comment-popover button{font:inherit;border:1px solid var(--border);background:var(--surface-card);
    color:var(--text-primary);border-radius:6px;padding:5px 10px;cursor:pointer;}
  .cell-comment-popover button.ccp-save{background:var(--s1);border-color:var(--s1);color:#fff;}
  .cell-comment-popover .ccp-error{color:var(--s6);font-size:11.5px;margin-top:6px;}
  .cell-comment-popover .ccp-signin{color:var(--text-secondary);}
  .cell-comment-popover .ccp-signin a{color:var(--s1);font-weight:600;text-decoration:none;}
```

- [ ] **Step 4: Add the comment-feature script**

In `scripts/_shell_head.html`, find this exact ending (currently the last 4 lines of the
file, closing the CSV-export script):

```js
  window.injectButtons = injectButtons;
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', injectButtons); } else { injectButtons(); }
})();
</script>
```

Replace with (keeps that block exactly as-is, then adds a new sibling `<script>` after
it):

```js
  window.injectButtons = injectButtons;
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', injectButtons); } else { injectButtons(); }
})();
</script>
<script>
(function(){
  // Private per-cell comments - see docs/superpowers/specs/2026-08-19-report-cell-comments-design.md.
  // One popover element, reused for every cell; a click delegated at the document level
  // (not one listener per td) so it keeps working for tables whose rows are rebuilt later
  // (e.g. the ProdPkg drill-down's tbody swap).
  var SEP = '␟';
  var popover = null, currentTd = null, comments = {}, signedOut = false;

  function pageKey(){ return window.REPORT_CARD || location.pathname; }

  function tableTitle(table){
    var wrap = table.closest('.pivot-wrap');
    var titleEl = wrap && wrap.querySelector('.pivot-title');
    if (!titleEl) return '';
    var span = titleEl.querySelector('.pivot-title-text');
    return (span || titleEl).textContent.trim();
  }

  function buildKey(title, grid, headRows, r, c){
    var colPath = grid.slice(0, headRows).map(function(row){ return ((row && row[c]) || '').trim(); }).join(' / ');
    var rowLabel = (grid[r] && grid[r][0]) || '';
    return [title, rowLabel, colPath].join(SEP);
  }

  // Comment keys are content-derived (table title + row label + column header path), not
  // positional, so they stay stable even though the *index* tableToGrid assigns a cell can
  // shift depending on what else is hidden at read time (a year filter, a collapsed
  // drill-down row) - see the design doc's Data model section for why this is safe.
  function cellKeyFor(td){
    var table = td.closest('table.pivot-table');
    if (!table) return null;
    var posMap = new Map();
    var grid = window.tableToGrid(table, posMap, true);
    var pos = posMap.get(td);
    if (!pos) return null;
    var headRows = table.querySelectorAll('thead tr').length || 1;
    return buildKey(tableTitle(table), grid, headRows, pos[0], pos[1]);
  }

  function markDot(td, on){ td.classList.toggle('cell-comment-dot', !!on); }

  function markAllDots(){
    document.querySelectorAll('table.pivot-table').forEach(function(table){
      var posMap = new Map();
      var grid = window.tableToGrid(table, posMap, true);
      var headRows = table.querySelectorAll('thead tr').length || 1;
      var title = tableTitle(table);
      posMap.forEach(function(pos, td){
        markDot(td, !!comments[buildKey(title, grid, headRows, pos[0], pos[1])]);
      });
    });
  }

  function ensurePopover(){
    if (popover) return popover;
    popover = document.createElement('div');
    popover.className = 'cell-comment-popover';
    document.body.appendChild(popover);
    document.addEventListener('mousedown', function(ev){
      if (popover.classList.contains('open') && !popover.contains(ev.target) && ev.target !== currentTd) closePopover();
    });
    document.addEventListener('keydown', function(ev){ if (ev.key === 'Escape') closePopover(); });
    return popover;
  }

  function closePopover(){
    if (popover) popover.classList.remove('open');
    currentTd = null;
  }

  function renderSignedOut(){
    var next = encodeURIComponent(window.top.location.href);
    popover.innerHTML =
      '<div class="ccp-head">Private note</div>' +
      '<div class="ccp-signin">Sign in to add a note only you can see.<br>' +
      '<a href="/api/auth/login?next=' + next + '" target="_top">Sign in with Google</a></div>';
  }

  function renderEditor(key){
    popover.innerHTML =
      '<div class="ccp-head">Private note</div>' +
      '<textarea class="ccp-text"></textarea>' +
      '<div class="ccp-error" style="display:none;"></div>' +
      '<div class="ccp-actions">' +
        '<button type="button" class="ccp-close">Close</button>' +
        '<button type="button" class="ccp-clear">Clear</button>' +
        '<button type="button" class="ccp-save">Save</button>' +
      '</div>';
    var ta = popover.querySelector('.ccp-text');
    ta.value = comments[key] || '';
    ta.focus();
    var errEl = popover.querySelector('.ccp-error');
    function showError(msg){ errEl.textContent = msg; errEl.style.display = 'block'; }
    var savingTd = currentTd;
    function doSave(text){
      fetch('/api/report-comments/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: pageKey(), cellKey: key, text: text })
      }).then(function(r){
        if (r.status === 401) { signedOut = true; renderSignedOut(); return; }
        if (!r.ok) { showError('Could not save - try again.'); return; }
        if (text.trim()) { comments[key] = text; markDot(savingTd, true); }
        else { delete comments[key]; markDot(savingTd, false); }
        closePopover();
      }).catch(function(){ showError('Could not save - check your connection.'); });
    }
    popover.querySelector('.ccp-close').onclick = closePopover;
    popover.querySelector('.ccp-save').onclick = function(){ doSave(ta.value); };
    popover.querySelector('.ccp-clear').onclick = function(){ ta.value = ''; doSave(''); };
  }

  function openPopoverFor(td, ev){
    ensurePopover();
    currentTd = td;
    var key = cellKeyFor(td);
    if (!key) { currentTd = null; return; }
    if (signedOut) renderSignedOut(); else renderEditor(key);
    popover.classList.add('open');
    var pw = 260;
    var left = Math.min(ev.clientX + 8, window.innerWidth - pw - 8);
    var top = Math.min(ev.clientY + 8, window.innerHeight - 200);
    popover.style.left = Math.max(8, left) + 'px';
    popover.style.top = Math.max(8, top) + 'px';
  }

  document.addEventListener('click', function(ev){
    var td = ev.target.closest && ev.target.closest('td');
    if (!td || !td.closest('table.pivot-table')) return;
    openPopoverFor(td, ev);
  });

  fetch('/api/auth/me').then(function(r){ return r.json(); }).then(function(d){
    if (!d || !d.authenticated) { signedOut = true; return; }
    return fetch('/api/report-comments/list?page=' + encodeURIComponent(pageKey()))
      .then(function(r){ return r.ok ? r.json() : { comments: {} }; })
      .then(function(d2){ comments = d2.comments || {}; markAllDots(); });
  }).catch(function(){ signedOut = true; });
})();
</script>
```

- [ ] **Step 5: Manual QA checklist (user runs this after deploy)**

- [ ] Open a report via the dashboard (always authenticated by the time it loads).
  Hovering any pivot-table cell shows a pointer cursor and a 1px accent outline.
- [ ] Click a cell → popover opens with an empty textarea. Type a note, click Save →
  popover closes, a small dot appears on that cell.
- [ ] Reload the report → the dot is still there; click the cell → the note is still in
  the textarea.
- [ ] Open the same report on a different device/browser signed in as the same Google
  account → the dot and note both appear there too.
- [ ] Sign in as a different user → that cell has no dot, and shows no note.
- [ ] Click Clear on a noted cell → dot disappears, reload confirms it stays gone.
- [ ] Click a cell inside a currently-hidden tab (switch tabs first, or - to test the
  `includeHidden` path specifically - open devtools and confirm a cell in a tab you
  haven't visited yet already shows a dot if it has a saved note, without switching to
  that tab first).
- [ ] Simulate the expired-session edge case: in devtools, delete the `pkyc_session`
  cookie without navigating away, then click a cell → popover shows "Sign in with
  Google" instead of a textarea, and clicking it navigates the whole tab (not just the
  iframe) to Google's login screen.
- [ ] Click outside the popover, or press Escape → popover closes without saving.

- [ ] **Step 6: Commit**

```bash
git add scripts/_shell_head.html
git commit -m "feat: click-to-comment popover on every report pivot-table cell"
```
