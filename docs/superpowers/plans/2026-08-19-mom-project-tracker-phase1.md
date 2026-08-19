# MOM Project Tracker — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `mom` card's "coming soon" placeholder into a working multi-board project tracker (boards → tasks, board-scoped members, per-board custom fields, kanban + table views).

**Architecture:** New MySQL tables (`PEP_CLS`) for boards/members/statuses/columns/tasks/field-values, one dynamic-action API handler (`api/mom/[action].js`, same shape as `api/escalation/[action].js`), and a Next.js page (`app/mom/`) with a board list and a board-detail view offering kanban and table.

**Tech Stack:** Next.js 14 (app router) + React 18, `mysql2` via this repo's `sql` tagged-template helper in `api/_lib/db.js`, Tailwind utility classes (dark `zinc`/`purple` theme, matching `app/rto-crm/RtoCrmClient.js`'s existing style), native HTML5 drag-and-drop (no DnD library — none is installed and the interaction is one axis).

**Spec:** `docs/superpowers/specs/2026-08-19-mom-project-tracker-phase1-design.md`

## Global Constraints

- Card key `mom` already exists in `CARD_KEYS`/`CARD_LABELS` (`api/_lib/db.js` line ~519) — do not add it again.
- Access is two layers everywhere: `session.perms.includes('mom')` (card), then per-board membership (`mom_board_members`) or `session.isAdmin`. For rows keyed by a surrogate id (`mom_columns`, `mom_tasks`), the board is **always resolved from the row itself** server-side — never trust a `boardId` the client sends alongside an `id`, since that would let a member of board A spoof access to a column/task that actually belongs to board B.
- Per this repo's existing convention (confirmed in `api/escalation/[action].js`, `api/rto/claim.js`, and every other DB-touching handler — none have test files), code that talks to the live MySQL pool or is an HTTP handler ships **without** an automated test; only pure, I/O-free functions get an assert-based test run via `node api/_lib/<name>.test.js` (see `api/_lib/db.refundExport.test.js` for the exact style to match).
- No script in this plan is run against the live DB or dev server by the implementer — per project convention, the user verifies manually in their own environment.
- Never hard-`DELETE` a board — `archiveMomBoard` only ever sets `archived = TRUE`.
- Status deletion must never orphan tasks silently — deleting a status re-points its tasks to the board's remaining lowest-position status, and refuses if it's the board's last status.

---

## Task 1: Schema + status-deletion helper (with test)

**Files:**
- Modify: `api/_lib/db.js` (insert before line `schemaReady = true;`, and add exported helper near the top of the MOM section)
- Create: `api/_lib/db.mom.test.js`

**Interfaces:**
- Produces: `resolveStatusForDeletion(statuses, deletedKey)` — pure function, `statuses: [{status_key, position}]`, returns the `status_key` string to re-point orphaned tasks to; throws `Error` if `deletedKey` isn't found or is the board's only status. Later tasks (`deleteMomStatus`) call this.

- [ ] **Step 1: Add the six MOM tables to `bootstrapSchema()`**

In `api/_lib/db.js`, find:
```js
  await sql`UPDATE audit_log SET card_key = 'deepdive' WHERE card_key = 'npsdeepdive'`;
  schemaReady = true;
}
```
Replace with:
```js
  await sql`UPDATE audit_log SET card_key = 'deepdive' WHERE card_key = 'npsdeepdive'`;

  // MOM project tracker (Phase 1) - multi-board task tracker behind the 'mom' card.
  // Statuses and custom fields are per-board (not a global enum) so each board's kanban
  // columns and extra fields are independently configurable, Monday.com-style.
  await sql`
    CREATE TABLE IF NOT EXISTS mom_boards (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      created_by VARCHAR(320) NOT NULL,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS mom_board_members (
      board_id INT NOT NULL,
      email VARCHAR(320) NOT NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'member',
      added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (board_id, email),
      FOREIGN KEY (board_id) REFERENCES mom_boards(id) ON DELETE CASCADE
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS mom_statuses (
      board_id INT NOT NULL,
      status_key VARCHAR(64) NOT NULL,
      label VARCHAR(64) NOT NULL,
      color VARCHAR(16) NOT NULL DEFAULT '#94a3b8',
      position INT NOT NULL DEFAULT 0,
      PRIMARY KEY (board_id, status_key),
      FOREIGN KEY (board_id) REFERENCES mom_boards(id) ON DELETE CASCADE
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS mom_columns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      board_id INT NOT NULL,
      name VARCHAR(128) NOT NULL,
      type VARCHAR(16) NOT NULL,
      options JSON,
      position INT NOT NULL DEFAULT 0,
      FOREIGN KEY (board_id) REFERENCES mom_boards(id) ON DELETE CASCADE
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS mom_tasks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      board_id INT NOT NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      status_key VARCHAR(64) NOT NULL DEFAULT 'todo',
      priority VARCHAR(16) NOT NULL DEFAULT 'medium',
      assignee_email VARCHAR(320),
      due_date DATE,
      position INT NOT NULL DEFAULT 0,
      created_by VARCHAR(320) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (board_id) REFERENCES mom_boards(id) ON DELETE CASCADE
    )
  `;
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

- [ ] **Step 2: Add `resolveStatusForDeletion` just above `module.exports`**

In `api/_lib/db.js`, find:
```js
module.exports = {
```
Insert directly before it:
```js
// Pure - given a board's statuses and the key being deleted, returns the status_key that
// orphaned tasks should move to (the remaining status with the lowest `position`). Throws
// rather than silently no-op'ing: deleting an unknown key or a board's last status are both
// caller bugs, not valid states to write to the DB.
function resolveStatusForDeletion(statuses, deletedKey) {
  const remaining = statuses.filter((s) => s.status_key !== deletedKey);
  if (remaining.length === statuses.length) {
    throw new Error(`Status "${deletedKey}" not found on this board`);
  }
  if (!remaining.length) {
    throw new Error('Cannot delete the last status on a board');
  }
  remaining.sort((a, b) => a.position - b.position);
  return remaining[0].status_key;
}

module.exports = {
```

- [ ] **Step 3: Export it**

Find:
```js
  buildRefundExportWhere,
};
```
Replace with:
```js
  buildRefundExportWhere,
  resolveStatusForDeletion,
};
```

- [ ] **Step 4: Write the test**

Create `api/_lib/db.mom.test.js`:
```js
// Offline self-check for resolveStatusForDeletion in db.js - pure/offline, never opens a
// connection. Run with `node api/_lib/db.mom.test.js`.
const assert = require('assert');
const { resolveStatusForDeletion } = require('./db');

(async () => {
  // 1. Orphaned tasks move to the remaining status with the lowest position.
  {
    const statuses = [
      { status_key: 'todo', position: 0 },
      { status_key: 'in_progress', position: 1 },
      { status_key: 'done', position: 2 },
    ];
    assert.strictEqual(resolveStatusForDeletion(statuses, 'in_progress'), 'todo');
  }

  // 2. Deleting the lowest-position status falls through to the next lowest.
  {
    const statuses = [
      { status_key: 'todo', position: 0 },
      { status_key: 'in_progress', position: 1 },
    ];
    assert.strictEqual(resolveStatusForDeletion(statuses, 'todo'), 'in_progress');
  }

  // 3. Position order is respected regardless of array order.
  {
    const statuses = [
      { status_key: 'done', position: 2 },
      { status_key: 'todo', position: 0 },
      { status_key: 'blocked', position: 1 },
    ];
    assert.strictEqual(resolveStatusForDeletion(statuses, 'todo'), 'blocked');
  }

  // 4. Refuses to delete the last remaining status.
  {
    const statuses = [{ status_key: 'todo', position: 0 }];
    assert.throws(() => resolveStatusForDeletion(statuses, 'todo'), /last status/);
  }

  // 5. Unknown key is an error, not a silent no-op.
  {
    const statuses = [{ status_key: 'todo', position: 0 }, { status_key: 'done', position: 1 }];
    assert.throws(() => resolveStatusForDeletion(statuses, 'missing'), /not found/);
  }

  console.log('db.mom.test.js: all assertions passed');
})();
```

- [ ] **Step 5: Run it**

Run: `node api/_lib/db.mom.test.js`
Expected: `db.mom.test.js: all assertions passed`

- [ ] **Step 6: Commit**

```bash
git add api/_lib/db.js api/_lib/db.mom.test.js
git commit -m "feat(mom): add project tracker schema and status-deletion helper"
```

---

## Task 2: DB helpers — boards & members

**Files:**
- Modify: `api/_lib/db.js` (add functions right after `resolveStatusForDeletion`, before `module.exports`; add names to the export list)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `getMomBoardsForUser(email, isAdmin)`, `createMomBoard(name, description, email)` → `Promise<number>` (board id), `getMomBoardRole(boardId, email)` → `Promise<string|null>`, `getMomBoardDetail(boardId)` → `Promise<{board, statuses, columns, members}|null>`, `updateMomBoard(boardId, {name, description})`, `archiveMomBoard(boardId)`, `upsertMomBoardMember(boardId, email, role)`, `removeMomBoardMember(boardId, email)` (throws if removing the last owner). Task 5's API handler calls all of these.

- [ ] **Step 1: Add the functions**

In `api/_lib/db.js`, right after the `resolveStatusForDeletion` function added in Task 1 (still before `module.exports`), insert:
```js
const MOM_DEFAULT_STATUSES = [
  { key: 'todo', label: 'To Do', color: '#94a3b8' },
  { key: 'in_progress', label: 'In Progress', color: '#3b82f6' },
  { key: 'done', label: 'Done', color: '#22c55e' },
];

async function getMomBoardsForUser(email, isAdmin) {
  if (isAdmin) {
    const { rows } = await sql`
      SELECT b.id, b.name, b.description, COALESCE(m.role, 'admin') AS role
      FROM mom_boards b
      LEFT JOIN mom_board_members m ON m.board_id = b.id AND m.email = ${email}
      WHERE b.archived = FALSE
      ORDER BY b.created_at DESC
    `;
    return rows;
  }
  const { rows } = await sql`
    SELECT b.id, b.name, b.description, m.role
    FROM mom_boards b
    JOIN mom_board_members m ON m.board_id = b.id
    WHERE m.email = ${email} AND b.archived = FALSE
    ORDER BY b.created_at DESC
  `;
  return rows;
}

async function createMomBoard(name, description, email) {
  const { insertId } = await sql`
    INSERT INTO mom_boards (name, description, created_by) VALUES (${name}, ${description || null}, ${email})
  `;
  await sql`INSERT INTO mom_board_members (board_id, email, role) VALUES (${insertId}, ${email}, 'owner')`;
  for (let i = 0; i < MOM_DEFAULT_STATUSES.length; i++) {
    const s = MOM_DEFAULT_STATUSES[i];
    await sql`
      INSERT INTO mom_statuses (board_id, status_key, label, color, position)
      VALUES (${insertId}, ${s.key}, ${s.label}, ${s.color}, ${i})
    `;
  }
  return insertId;
}

async function getMomBoardRole(boardId, email) {
  const { rows } = await sql`SELECT role FROM mom_board_members WHERE board_id = ${boardId} AND email = ${email}`;
  return rows[0] ? rows[0].role : null;
}

async function getMomBoardDetail(boardId) {
  const { rows: boards } = await sql`SELECT id, name, description, archived FROM mom_boards WHERE id = ${boardId}`;
  if (!boards.length) return null;
  const { rows: statuses } = await sql`
    SELECT status_key AS statusKey, label, color, position FROM mom_statuses
    WHERE board_id = ${boardId} ORDER BY position
  `;
  const { rows: columns } = await sql`
    SELECT id, name, type, options, position FROM mom_columns
    WHERE board_id = ${boardId} ORDER BY position
  `;
  const { rows: members } = await sql`
    SELECT email, role FROM mom_board_members WHERE board_id = ${boardId} ORDER BY added_at
  `;
  return { board: boards[0], statuses, columns, members };
}

async function updateMomBoard(boardId, { name, description }) {
  await sql`UPDATE mom_boards SET name = ${name}, description = ${description || null} WHERE id = ${boardId}`;
}

async function archiveMomBoard(boardId) {
  await sql`UPDATE mom_boards SET archived = TRUE WHERE id = ${boardId}`;
}

async function upsertMomBoardMember(boardId, email, role) {
  await sql`
    INSERT INTO mom_board_members (board_id, email, role) VALUES (${boardId}, ${email}, ${role})
    ON DUPLICATE KEY UPDATE role = ${role}
  `;
}

async function removeMomBoardMember(boardId, email) {
  const { rows } = await sql`SELECT email, role FROM mom_board_members WHERE board_id = ${boardId}`;
  const target = rows.find((r) => r.email === email);
  if (!target) return;
  if (target.role === 'owner') {
    const otherOwners = rows.filter((r) => r.email !== email && r.role === 'owner');
    if (!otherOwners.length) throw new Error('Cannot remove the last owner of a board');
  }
  await sql`DELETE FROM mom_board_members WHERE board_id = ${boardId} AND email = ${email}`;
}

```
(Leave `resolveStatusForDeletion` and the blank line before `module.exports` as they were — this block goes between them.)

- [ ] **Step 2: Export the new functions**

Find (added in Task 1):
```js
  buildRefundExportWhere,
  resolveStatusForDeletion,
};
```
Replace with:
```js
  buildRefundExportWhere,
  resolveStatusForDeletion,
  getMomBoardsForUser, createMomBoard, getMomBoardRole, getMomBoardDetail,
  updateMomBoard, archiveMomBoard, upsertMomBoardMember, removeMomBoardMember,
};
```

- [ ] **Step 3: Commit**

No automated test — these functions only wrap live MySQL queries (see Global Constraints). Sanity-check by reading the diff for typos in column/table names against Task 1's schema.

```bash
git add api/_lib/db.js
git commit -m "feat(mom): add board and board-member DB helpers"
```

---

## Task 3: DB helpers — columns & statuses

**Files:**
- Modify: `api/_lib/db.js` (add functions right after Task 2's block, before `module.exports`; add names to the export list)

**Interfaces:**
- Consumes: `resolveStatusForDeletion` (Task 1).
- Produces: `createMomColumn(boardId, name, type, options)` → `Promise<{id, name, type, options, position}>`, `getMomColumnBoardId(columnId)` → `Promise<number|null>`, `updateMomColumn(id, {name, options, position})`, `deleteMomColumn(id)`, `createMomStatus(boardId, label, color)` → `Promise<{statusKey, label, color, position}>`, `updateMomStatus(boardId, statusKey, {label, color, position})`, `deleteMomStatus(boardId, statusKey)`. Task 6's API handler calls all of these.

- [ ] **Step 1: Add the functions**

Insert right after Task 2's block (still before `module.exports`):
```js
async function createMomColumn(boardId, name, type, options) {
  const { rows } = await sql`SELECT COALESCE(MAX(position), -1) AS maxPos FROM mom_columns WHERE board_id = ${boardId}`;
  const position = rows[0].maxPos + 1;
  const { insertId } = await sql`
    INSERT INTO mom_columns (board_id, name, type, options, position)
    VALUES (${boardId}, ${name}, ${type}, ${options ? JSON.stringify(options) : null}, ${position})
  `;
  return { id: insertId, name, type, options: options || null, position };
}

async function getMomColumnBoardId(columnId) {
  const { rows } = await sql`SELECT board_id AS boardId FROM mom_columns WHERE id = ${columnId}`;
  return rows[0] ? rows[0].boardId : null;
}

async function updateMomColumn(id, { name, options, position }) {
  const { rows } = await sql`SELECT name, options, position FROM mom_columns WHERE id = ${id}`;
  if (!rows.length) throw new Error('Column not found');
  const current = rows[0];
  const nextName = name === undefined ? current.name : name;
  const nextOptions = options === undefined ? current.options : options;
  const nextPosition = position === undefined ? current.position : position;
  await sql`
    UPDATE mom_columns SET name = ${nextName}, options = ${nextOptions ? JSON.stringify(nextOptions) : null}, position = ${nextPosition}
    WHERE id = ${id}
  `;
}

async function deleteMomColumn(id) {
  await sql`DELETE FROM mom_columns WHERE id = ${id}`;
}

async function createMomStatus(boardId, label, color) {
  const baseKey = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'status';
  const { rows: existing } = await sql`SELECT status_key AS statusKey, position FROM mom_statuses WHERE board_id = ${boardId}`;
  const existingKeys = new Set(existing.map((s) => s.statusKey));
  let key = baseKey;
  let suffix = 1;
  while (existingKeys.has(key)) {
    key = `${baseKey}_${suffix}`;
    suffix += 1;
  }
  const position = existing.length ? Math.max(...existing.map((s) => s.position)) + 1 : 0;
  const finalColor = color || '#94a3b8';
  await sql`
    INSERT INTO mom_statuses (board_id, status_key, label, color, position)
    VALUES (${boardId}, ${key}, ${label}, ${finalColor}, ${position})
  `;
  return { statusKey: key, label, color: finalColor, position };
}

async function updateMomStatus(boardId, statusKey, { label, color, position }) {
  const { rows } = await sql`SELECT label, color, position FROM mom_statuses WHERE board_id = ${boardId} AND status_key = ${statusKey}`;
  if (!rows.length) throw new Error('Status not found');
  const current = rows[0];
  const nextLabel = label === undefined ? current.label : label;
  const nextColor = color === undefined ? current.color : color;
  const nextPosition = position === undefined ? current.position : position;
  await sql`
    UPDATE mom_statuses SET label = ${nextLabel}, color = ${nextColor}, position = ${nextPosition}
    WHERE board_id = ${boardId} AND status_key = ${statusKey}
  `;
}

async function deleteMomStatus(boardId, statusKey) {
  const { rows: statuses } = await sql`
    SELECT status_key, position FROM mom_statuses WHERE board_id = ${boardId}
  `;
  const target = resolveStatusForDeletion(statuses, statusKey);
  await sql`UPDATE mom_tasks SET status_key = ${target} WHERE board_id = ${boardId} AND status_key = ${statusKey}`;
  await sql`DELETE FROM mom_statuses WHERE board_id = ${boardId} AND status_key = ${statusKey}`;
}

```

- [ ] **Step 2: Export the new functions**

Find (Task 2's export additions):
```js
  getMomBoardsForUser, createMomBoard, getMomBoardRole, getMomBoardDetail,
  updateMomBoard, archiveMomBoard, upsertMomBoardMember, removeMomBoardMember,
};
```
Replace with:
```js
  getMomBoardsForUser, createMomBoard, getMomBoardRole, getMomBoardDetail,
  updateMomBoard, archiveMomBoard, upsertMomBoardMember, removeMomBoardMember,
  createMomColumn, getMomColumnBoardId, updateMomColumn, deleteMomColumn,
  createMomStatus, updateMomStatus, deleteMomStatus,
};
```

- [ ] **Step 3: Commit**

No automated test (live-DB helpers, per Global Constraints) beyond the `resolveStatusForDeletion` test already covering the one branchy piece `deleteMomStatus` depends on.

```bash
git add api/_lib/db.js
git commit -m "feat(mom): add custom-field and status DB helpers"
```

---

## Task 4: DB helpers — tasks & reorder

**Files:**
- Modify: `api/_lib/db.js` (add functions right after Task 3's block, before `module.exports`; add names to the export list)

**Interfaces:**
- Consumes: nothing new.
- Produces: `getMomTasks(boardId)` → `Promise<Array<{id, boardId, title, description, statusKey, priority, assigneeEmail, dueDate, position, createdBy, createdAt, updatedAt, customValues}>>`, `getMomTaskBoardId(taskId)` → `Promise<number|null>`, `createMomTask(boardId, {title, description, priority, assigneeEmail, dueDate, statusKey, createdBy})` → `Promise<number>`, `updateMomTask(taskId, fields)` (fields may include `customValues: {columnId: value}`), `deleteMomTask(taskId)`, `reorderMomTask(taskId, statusKey, position)`. Task 7's API handler calls all of these.

- [ ] **Step 1: Add the functions**

Insert right after Task 3's block (still before `module.exports`):
```js
async function getMomTasks(boardId) {
  const { rows: tasks } = await sql`
    SELECT id, board_id AS boardId, title, description, status_key AS statusKey, priority,
           assignee_email AS assigneeEmail, due_date AS dueDate, position, created_by AS createdBy,
           created_at AS createdAt, updated_at AS updatedAt
    FROM mom_tasks WHERE board_id = ${boardId} ORDER BY status_key, position
  `;
  const { rows: values } = await sql`
    SELECT v.task_id AS taskId, v.column_id AS columnId, v.value
    FROM mom_task_field_values v
    JOIN mom_tasks t ON t.id = v.task_id
    WHERE t.board_id = ${boardId}
  `;
  const byTask = new Map();
  values.forEach((v) => {
    if (!byTask.has(v.taskId)) byTask.set(v.taskId, {});
    byTask.get(v.taskId)[v.columnId] = v.value;
  });
  return tasks.map((t) => ({ ...t, customValues: byTask.get(t.id) || {} }));
}

async function getMomTaskBoardId(taskId) {
  const { rows } = await sql`SELECT board_id AS boardId FROM mom_tasks WHERE id = ${taskId}`;
  return rows[0] ? rows[0].boardId : null;
}

async function createMomTask(boardId, { title, description, priority, assigneeEmail, dueDate, statusKey, createdBy }) {
  let resolvedStatus = statusKey;
  if (!resolvedStatus) {
    const { rows } = await sql`SELECT status_key FROM mom_statuses WHERE board_id = ${boardId} ORDER BY position LIMIT 1`;
    resolvedStatus = rows.length ? rows[0].status_key : 'todo';
  }
  const { rows: posRows } = await sql`
    SELECT COALESCE(MAX(position), -1) AS maxPos FROM mom_tasks WHERE board_id = ${boardId} AND status_key = ${resolvedStatus}
  `;
  const position = posRows[0].maxPos + 1;
  const { insertId } = await sql`
    INSERT INTO mom_tasks (board_id, title, description, status_key, priority, assignee_email, due_date, position, created_by)
    VALUES (${boardId}, ${title}, ${description || null}, ${resolvedStatus}, ${priority || 'medium'}, ${assigneeEmail || null}, ${dueDate || null}, ${position}, ${createdBy})
  `;
  return insertId;
}

async function updateMomTask(taskId, fields) {
  const { rows } = await sql`
    SELECT title, description, priority, assignee_email AS assigneeEmail, due_date AS dueDate
    FROM mom_tasks WHERE id = ${taskId}
  `;
  if (!rows.length) throw new Error('Task not found');
  const current = rows[0];
  const next = {
    title: fields.title === undefined ? current.title : fields.title,
    description: fields.description === undefined ? current.description : fields.description,
    priority: fields.priority === undefined ? current.priority : fields.priority,
    assigneeEmail: fields.assigneeEmail === undefined ? current.assigneeEmail : fields.assigneeEmail,
    dueDate: fields.dueDate === undefined ? current.dueDate : fields.dueDate,
  };
  await sql`
    UPDATE mom_tasks SET title = ${next.title}, description = ${next.description || null}, priority = ${next.priority},
      assignee_email = ${next.assigneeEmail || null}, due_date = ${next.dueDate || null}
    WHERE id = ${taskId}
  `;
  if (fields.customValues) {
    const entries = Object.entries(fields.customValues);
    for (const [columnId, value] of entries) {
      await sql`
        INSERT INTO mom_task_field_values (task_id, column_id, value) VALUES (${taskId}, ${columnId}, ${value})
        ON DUPLICATE KEY UPDATE value = ${value}
      `;
    }
  }
}

async function deleteMomTask(taskId) {
  await sql`DELETE FROM mom_tasks WHERE id = ${taskId}`;
}

async function reorderMomTask(taskId, statusKey, position) {
  const { rows: taskRows } = await sql`SELECT board_id AS boardId FROM mom_tasks WHERE id = ${taskId}`;
  if (!taskRows.length) throw new Error('Task not found');
  const boardId = taskRows[0].boardId;
  const { rows: siblings } = await sql`
    SELECT id FROM mom_tasks WHERE board_id = ${boardId} AND status_key = ${statusKey} AND id != ${taskId} ORDER BY position
  `;
  const ids = siblings.map((s) => s.id);
  const clamped = Math.max(0, Math.min(position, ids.length));
  ids.splice(clamped, 0, taskId);
  for (let i = 0; i < ids.length; i++) {
    await sql`UPDATE mom_tasks SET position = ${i}, status_key = ${statusKey} WHERE id = ${ids[i]}`;
  }
}

```

- [ ] **Step 2: Export the new functions**

Find (Task 3's export additions):
```js
  createMomColumn, getMomColumnBoardId, updateMomColumn, deleteMomColumn,
  createMomStatus, updateMomStatus, deleteMomStatus,
};
```
Replace with:
```js
  createMomColumn, getMomColumnBoardId, updateMomColumn, deleteMomColumn,
  createMomStatus, updateMomStatus, deleteMomStatus,
  getMomTasks, getMomTaskBoardId, createMomTask, updateMomTask, deleteMomTask, reorderMomTask,
};
```

- [ ] **Step 3: Commit**

No automated test (live-DB helpers, per Global Constraints).

```bash
git add api/_lib/db.js
git commit -m "feat(mom): add task CRUD and reorder DB helpers"
```

---

## Task 5: API handler — boards & board

**Files:**
- Create: `api/mom/[action].js`

**Interfaces:**
- Consumes: `getSession` (`api/_lib/session.js`), all Task 2 DB functions.
- Produces: the `handler` module export, extended in Tasks 6–7. `checkCardAccess(session)` and `checkBoardAccess(session, boardId, {requireOwner})` are used by every later action block.

- [ ] **Step 1: Create the file**

```js
// The MOM (project tracker) API surface - one dynamic-action handler, same shape as
// api/escalation/[action].js and api/admin/[action].js.
//
// Actions: boards | board | members | columns | statuses | tasks | reorder
//
// Two-layer access control: the 'mom' card (checkCardAccess) gates the whole feature, then
// per-board membership (checkBoardAccess) gates everything scoped to one board. For rows keyed
// by a surrogate id (columns, tasks) the board is resolved from the row itself, never trusted
// from the request body - a client could otherwise pass a boardId it IS a member of while
// editing a column/task that actually belongs to a board it is NOT a member of.
const { getSession } = require('../_lib/session');
const db = require('../_lib/db');

const CARD_KEY = 'mom';

function checkCardAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to MOM.';
  return null;
}

async function checkBoardAccess(session, boardId, { requireOwner } = {}) {
  if (!boardId) return 'boardId is required';
  if (session.isAdmin) return null;
  const role = await db.getMomBoardRole(boardId, session.email);
  if (!role) return 'You are not a member of this board.';
  if (requireOwner && role !== 'owner') return 'Only board owners can do this.';
  return null;
}

const handler = async (req, res) => {
  const session = await getSession(req);
  const denied = checkCardAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  const action = (req.query && req.query.action) || '';
  const body = req.body || {};

  try {
    if (action === 'boards') {
      if (req.method === 'GET') {
        const boards = await db.getMomBoardsForUser(session.email, session.isAdmin);
        return res.status(200).json({ boards });
      }
      if (req.method === 'POST') {
        const { name, description } = body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
        const id = await db.createMomBoard(name.trim(), description || '', session.email);
        return res.status(200).json({ board: { id, name: name.trim(), description: description || '', role: 'owner' } });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'board') {
      if (req.method === 'GET') {
        const boardId = Number(req.query.id);
        if (!boardId) return res.status(400).json({ error: 'id is required' });
        const boardDenied = await checkBoardAccess(session, boardId);
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        const detail = await db.getMomBoardDetail(boardId);
        if (!detail || detail.board.archived) return res.status(404).json({ error: 'Board not found' });
        const role = session.isAdmin ? 'admin' : await db.getMomBoardRole(boardId, session.email);
        if (role !== 'owner' && !session.isAdmin) detail.members = [];
        return res.status(200).json({ ...detail, myRole: role });
      }
      if (req.method === 'PUT') {
        const { id, name, description } = body;
        if (!id || !name || !name.trim()) return res.status(400).json({ error: 'id and name are required' });
        const boardDenied = await checkBoardAccess(session, id, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        await db.updateMomBoard(id, { name: name.trim(), description: description || '' });
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'id is required' });
        const boardDenied = await checkBoardAccess(session, id, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        await db.archiveMomBoard(id);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    return res.status(404).json({ error: 'Unknown mom route' });
  } catch (e) {
    console.error(`api/mom/${action} error:`, e);
    return res.status(500).json({ error: e.message || 'MOM request failed' });
  }
};

module.exports = handler;
```

- [ ] **Step 2: Commit**

No automated test (HTTP handler, per Global Constraints — matches `api/escalation/[action].js`, which also has none). Read the diff once against Task 2's function signatures to confirm names match.

```bash
git add api/mom/[action].js
git commit -m "feat(mom): add boards/board API actions"
```

---

## Task 6: API handler — members, columns, statuses

**Files:**
- Modify: `api/mom/[action].js`

**Interfaces:**
- Consumes: Task 3's DB functions, Task 5's `checkBoardAccess`.
- Produces: the `members`, `columns`, `statuses` action blocks, extending the same handler.

- [ ] **Step 1: Insert the three action blocks**

Find:
```js
    return res.status(404).json({ error: 'Unknown mom route' });
```
Replace with:
```js
    if (action === 'members') {
      const { boardId } = body;
      if (req.method === 'POST') {
        const { email, role } = body;
        if (!email || !['owner', 'member'].includes(role)) {
          return res.status(400).json({ error: 'email and a valid role (owner|member) are required' });
        }
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        await db.upsertMomBoardMember(boardId, email.trim().toLowerCase(), role);
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const { email } = body;
        if (!email) return res.status(400).json({ error: 'email is required' });
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        try {
          await db.removeMomBoardMember(boardId, email.trim().toLowerCase());
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'columns') {
      if (req.method === 'POST') {
        const { boardId, name, type, options } = body;
        const validTypes = ['text', 'number', 'select', 'person', 'date', 'checkbox'];
        if (!name || !name.trim() || !validTypes.includes(type)) {
          return res.status(400).json({ error: `name is required and type must be one of ${validTypes.join(', ')}` });
        }
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        const column = await db.createMomColumn(boardId, name.trim(), type, options || null);
        return res.status(200).json({ column });
      }
      if (req.method === 'PUT') {
        const { id, name, options, position } = body;
        if (!id) return res.status(400).json({ error: 'id is required' });
        const boardId = await db.getMomColumnBoardId(id);
        if (!boardId) return res.status(404).json({ error: 'Column not found' });
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        await db.updateMomColumn(id, { name, options, position });
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'id is required' });
        const boardId = await db.getMomColumnBoardId(id);
        if (!boardId) return res.status(404).json({ error: 'Column not found' });
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        await db.deleteMomColumn(id);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'statuses') {
      const { boardId } = body;
      if (req.method === 'POST') {
        const { label, color } = body;
        if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        const status = await db.createMomStatus(boardId, label.trim(), color);
        return res.status(200).json({ status });
      }
      if (req.method === 'PUT') {
        const { statusKey, label, color, position } = body;
        if (!statusKey) return res.status(400).json({ error: 'statusKey is required' });
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        try {
          await db.updateMomStatus(boardId, statusKey, { label, color, position });
        } catch (e) {
          return res.status(404).json({ error: e.message });
        }
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const { statusKey } = body;
        if (!statusKey) return res.status(400).json({ error: 'statusKey is required' });
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        try {
          await db.deleteMomStatus(boardId, statusKey);
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    return res.status(404).json({ error: 'Unknown mom route' });
```

- [ ] **Step 2: Commit**

No automated test (HTTP handler, per Global Constraints).

```bash
git add api/mom/[action].js
git commit -m "feat(mom): add member/column/status API actions"
```

---

## Task 7: API handler — tasks & reorder; mount the route; wire the tab live

**Files:**
- Modify: `api/mom/[action].js`
- Modify: `api/_lambda/app.js`
- Modify: `app/HomeClient.js`

**Interfaces:**
- Consumes: Task 4's DB functions.
- Produces: the `tasks` and `reorder` action blocks; the live-mounted `/api/mom/:action` route; `mom` pointing at `/mom` instead of the placeholder.

- [ ] **Step 1: Insert the `tasks` and `reorder` action blocks**

In `api/mom/[action].js`, find:
```js
    return res.status(404).json({ error: 'Unknown mom route' });
```
Replace with:
```js
    if (action === 'tasks') {
      if (req.method === 'GET') {
        const boardId = Number(req.query.boardId);
        if (!boardId) return res.status(400).json({ error: 'boardId is required' });
        const boardDenied = await checkBoardAccess(session, boardId);
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        const tasks = await db.getMomTasks(boardId);
        return res.status(200).json({ tasks });
      }
      if (req.method === 'POST') {
        const { boardId, title, description, priority, assigneeEmail, dueDate, statusKey } = body;
        if (!boardId || !title || !title.trim()) return res.status(400).json({ error: 'boardId and title are required' });
        const boardDenied = await checkBoardAccess(session, boardId);
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        const id = await db.createMomTask(boardId, {
          title: title.trim(), description, priority, assigneeEmail, dueDate, statusKey, createdBy: session.email,
        });
        return res.status(200).json({ id });
      }
      if (req.method === 'PUT') {
        const { id, ...fields } = body;
        if (!id) return res.status(400).json({ error: 'id is required' });
        const boardId = await db.getMomTaskBoardId(id);
        if (!boardId) return res.status(404).json({ error: 'Task not found' });
        const boardDenied = await checkBoardAccess(session, boardId);
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        await db.updateMomTask(id, fields);
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'id is required' });
        const boardId = await db.getMomTaskBoardId(id);
        if (!boardId) return res.status(404).json({ error: 'Task not found' });
        const boardDenied = await checkBoardAccess(session, boardId);
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        await db.deleteMomTask(id);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'reorder') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { taskId, statusKey, position } = body;
      if (!taskId || !statusKey || position == null) {
        return res.status(400).json({ error: 'taskId, statusKey, and position are required' });
      }
      const boardId = await db.getMomTaskBoardId(taskId);
      if (!boardId) return res.status(404).json({ error: 'Task not found' });
      const boardDenied = await checkBoardAccess(session, boardId);
      if (boardDenied) return res.status(403).json({ error: boardDenied });
      await db.reorderMomTask(taskId, statusKey, Number(position));
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Unknown mom route' });
```

- [ ] **Step 2: Mount the route**

In `api/_lambda/app.js`, find:
```js
mount('all', '/api/nps/public/:token', '../nps/public/[token].js', 'token');
```
Replace with:
```js
mount('all', '/api/nps/public/:token', '../nps/public/[token].js', 'token');
mount('all', '/api/mom/:action', '../mom/[action].js', 'action');
```

- [ ] **Step 3: Wire the tab live**

In `app/HomeClient.js`, find:
```js
var COMING_SOON = {
  mom: 'MOM report is coming soon.'
};
```
Replace with:
```js
var COMING_SOON = {
};
```

Find:
```js
var NEXT_PAGE_ROUTES = {
  onboarding: '/onboarding',
  productkyc: '/productkyc',
  deepdive: '/deepdive',
  orgoverview: '/orgoverview',
  nps: '/nps-admin'
};
```
Replace with:
```js
var NEXT_PAGE_ROUTES = {
  onboarding: '/onboarding',
  productkyc: '/productkyc',
  deepdive: '/deepdive',
  orgoverview: '/orgoverview',
  nps: '/nps-admin',
  mom: '/mom'
};
```

- [ ] **Step 4: Commit**

No automated test (HTTP handler / routing / static wiring, per Global Constraints).

```bash
git add api/mom/[action].js api/_lambda/app.js app/HomeClient.js
git commit -m "feat(mom): add task/reorder API actions, mount route, wire tab live"
```

---

## Task 8: Frontend — board list (`app/mom/`)

**Files:**
- Create: `app/mom/momApi.js`
- Create: `app/mom/page.js`
- Create: `app/mom/MomClient.js`

**Interfaces:**
- Produces: `fetchJson(url, opts)`, `postJson(url, body)`, `putJson(url, body)`, `deleteJson(url, body)` (exported from `momApi.js`, imported by `MomBoard.js` in Task 9). `MomClient` renders `MomBoard` (created in Task 9) once a board is opened — this task can be verified once Task 9 exists; until then `MomBoard` is imported but not yet implemented, so build Task 9 immediately after this one before manually checking either in a browser.

- [ ] **Step 1: Create the shared fetch helpers**

Create `app/mom/momApi.js`:
```js
'use client';

export async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function postJson(url, body) {
  return fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function putJson(url, body) {
  return fetchJson(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function deleteJson(url, body) {
  return fetchJson(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
```

- [ ] **Step 2: Create the page**

Create `app/mom/page.js`:
```js
import MomClient from './MomClient';

export const metadata = {
  title: 'MOM — Project Tracker',
};

export default function Page() {
  return <MomClient />;
}
```

- [ ] **Step 3: Create the board-list client**

Create `app/mom/MomClient.js`:
```js
'use client';

import { useEffect, useState } from 'react';
import { fetchJson, postJson } from './momApi';
import MomBoard from './MomBoard';

function BoardCard({ board, onOpen }) {
  return (
    <button
      onClick={() => onOpen(board.id)}
      className="text-left bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-4 hover:border-purple-600/60 transition-all"
    >
      <div className="text-zinc-100 font-bold">{board.name}</div>
      {board.description && <div className="text-zinc-500 text-[13px] mt-1 line-clamp-2">{board.description}</div>}
      <div className="text-zinc-600 text-[11px] mt-2 uppercase tracking-wide">{board.role}</div>
    </button>
  );
}

function NewBoardForm({ onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { board } = await postJson('/api/mom/boards', { name, description });
      setName('');
      setDescription('');
      onCreated(board);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-start gap-2 bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-3 mb-6">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Board name"
        className="px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-[13px] placeholder-zinc-500 focus:outline-none focus:border-purple-600"
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        className="flex-1 min-w-[160px] px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-[13px] placeholder-zinc-500 focus:outline-none focus:border-purple-600"
      />
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-[13px] font-bold transition-all"
      >
        New board
      </button>
      {error && <div className="text-red-400 text-[12px] w-full">{error}</div>}
    </form>
  );
}

export default function MomClient() {
  const [boards, setBoards] = useState(null);
  const [error, setError] = useState('');
  const [openBoardId, setOpenBoardId] = useState(null);

  const load = () => {
    fetchJson('/api/mom/boards')
      .then((d) => setBoards(d.boards))
      .catch((e) => setError(e.message));
  };

  useEffect(() => { load(); }, []);

  if (openBoardId) {
    return <MomBoard boardId={openBoardId} onBack={() => { setOpenBoardId(null); load(); }} />;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <h1 className="text-xl font-bold mb-4">MOM — Project Tracker</h1>
      <NewBoardForm onCreated={(board) => setOpenBoardId(board.id)} />
      {error && <div className="text-red-400 text-[13px] mb-4">{error}</div>}
      {boards === null ? (
        <div className="text-zinc-500 text-[13px]">Loading boards…</div>
      ) : boards.length === 0 ? (
        <div className="text-zinc-500 text-[13px]">No boards yet — create one above.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {boards.map((b) => <BoardCard key={b.id} board={b} onOpen={setOpenBoardId} />)}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

No automated test (this repo has no frontend test files at all — every existing page under `app/` ships the same way). Manual browser verification is the user's own, per project convention; do not start the dev server from this session.

```bash
git add app/mom/momApi.js app/mom/page.js app/mom/MomClient.js
git commit -m "feat(mom): add board list page"
```

---

## Task 9: Frontend — board detail shell, manage panel, kanban view

**Files:**
- Create: `app/mom/MomBoard.js`

**Interfaces:**
- Consumes: `fetchJson`, `postJson`, `deleteJson` (`app/mom/momApi.js`); `GET/POST /api/mom/board`, `GET/POST /api/mom/tasks`, `POST /api/mom/reorder`, `POST/DELETE /api/mom/members`, `POST/DELETE /api/mom/statuses`, `POST/DELETE /api/mom/columns`.
- Produces: `MomBoard({ boardId, onBack })`, imported by `MomClient.js` (Task 8). `TaskPanel` (a minimal preview here) and the whole kanban-only layout are replaced/extended in Task 10, which adds the table view and the full edit form.

- [ ] **Step 1: Create the file**

Create `app/mom/MomBoard.js`:
```js
'use client';

import { useEffect, useState } from 'react';
import { fetchJson, postJson, deleteJson } from './momApi';

const PRIORITY_COLORS = { low: '#64748b', medium: '#3b82f6', high: '#f59e0b', urgent: '#ef4444' };

function ManagePanel({ statuses, columns, members, myRole, boardId, onChanged, onClose }) {
  const isOwner = myRole === 'owner' || myRole === 'admin';
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState('member');
  const [statusLabel, setStatusLabel] = useState('');
  const [columnName, setColumnName] = useState('');
  const [columnType, setColumnType] = useState('text');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4 mb-4 space-y-5">
      <div className="flex items-center justify-between">
        <div className="text-zinc-100 font-bold text-[14px]">Manage board</div>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-[12px]">Close</button>
      </div>
      {error && <div className="text-red-400 text-[12px]">{error}</div>}

      {isOwner && (
        <div>
          <div className="text-zinc-400 text-[12px] font-bold uppercase mb-2">Members</div>
          <div className="space-y-1 mb-2">
            {members.map((m) => (
              <div key={m.email} className="flex items-center justify-between text-[13px] text-zinc-300">
                <span>{m.email} <span className="text-zinc-500">({m.role})</span></span>
                <button
                  disabled={busy}
                  onClick={() => run(() => deleteJson('/api/mom/members', { boardId, email: m.email }))}
                  className="text-red-400 hover:text-red-300 text-[11px]"
                >Remove</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} placeholder="email"
              className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px] flex-1" />
            <select value={memberRole} onChange={(e) => setMemberRole(e.target.value)}
              className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px]">
              <option value="member">member</option>
              <option value="owner">owner</option>
            </select>
            <button
              disabled={busy || !memberEmail.trim()}
              onClick={() => run(() => postJson('/api/mom/members', { boardId, email: memberEmail.trim().toLowerCase(), role: memberRole }))}
              className="px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white text-[12px] font-bold"
            >Add</button>
          </div>
        </div>
      )}

      {isOwner && (
        <div>
          <div className="text-zinc-400 text-[12px] font-bold uppercase mb-2">Statuses</div>
          <div className="space-y-1 mb-2">
            {statuses.map((s) => (
              <div key={s.statusKey} className="flex items-center justify-between text-[13px] text-zinc-300">
                <span><span style={{ color: s.color }}>&#9679;</span> {s.label}</span>
                <button
                  disabled={busy}
                  onClick={() => run(() => deleteJson('/api/mom/statuses', { boardId, statusKey: s.statusKey }))}
                  className="text-red-400 hover:text-red-300 text-[11px]"
                >Delete</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={statusLabel} onChange={(e) => setStatusLabel(e.target.value)} placeholder="New status label"
              className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px] flex-1" />
            <button
              disabled={busy || !statusLabel.trim()}
              onClick={() => run(async () => { await postJson('/api/mom/statuses', { boardId, label: statusLabel.trim() }); setStatusLabel(''); })}
              className="px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white text-[12px] font-bold"
            >Add</button>
          </div>
        </div>
      )}

      {isOwner && (
        <div>
          <div className="text-zinc-400 text-[12px] font-bold uppercase mb-2">Custom fields</div>
          <div className="space-y-1 mb-2">
            {columns.map((c) => (
              <div key={c.id} className="flex items-center justify-between text-[13px] text-zinc-300">
                <span>{c.name} <span className="text-zinc-500">({c.type})</span></span>
                <button
                  disabled={busy}
                  onClick={() => run(() => deleteJson('/api/mom/columns', { id: c.id }))}
                  className="text-red-400 hover:text-red-300 text-[11px]"
                >Delete</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={columnName} onChange={(e) => setColumnName(e.target.value)} placeholder="Field name"
              className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px] flex-1" />
            <select value={columnType} onChange={(e) => setColumnType(e.target.value)}
              className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px]">
              <option value="text">text</option>
              <option value="number">number</option>
              <option value="date">date</option>
              <option value="checkbox">checkbox</option>
              <option value="person">person</option>
              <option value="select">select</option>
            </select>
            <button
              disabled={busy || !columnName.trim()}
              onClick={() => run(async () => { await postJson('/api/mom/columns', { boardId, name: columnName.trim(), type: columnType }); setColumnName(''); })}
              className="px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white text-[12px] font-bold"
            >Add</button>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, onDragStart, onOpen }) {
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, task.id)}
      onClick={() => onOpen(task)}
      className="bg-zinc-800/80 border border-zinc-700 rounded-lg p-2.5 mb-2 cursor-pointer hover:border-purple-600/60"
    >
      <div className="text-zinc-100 text-[13px] font-medium">{task.title}</div>
      <div className="flex items-center gap-2 mt-1.5 text-[11px]">
        <span style={{ color: PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.medium }}>{task.priority}</span>
        {task.assigneeEmail && <span className="text-zinc-500">{task.assigneeEmail}</span>}
        {task.dueDate && <span className="text-zinc-500">{task.dueDate.slice(0, 10)}</span>}
      </div>
    </div>
  );
}

function KanbanView({ statuses, tasks, onDropTask, onOpenTask }) {
  const byStatus = (key) => tasks.filter((t) => t.statusKey === key);
  const handleDragStart = (e, taskId) => e.dataTransfer.setData('text/plain', String(taskId));
  const handleDrop = (e, statusKey, index) => {
    e.preventDefault();
    const taskId = Number(e.dataTransfer.getData('text/plain'));
    if (taskId) onDropTask(taskId, statusKey, index);
  };

  return (
    <div className="flex gap-3 overflow-x-auto">
      {statuses.map((s) => {
        const columnTasks = byStatus(s.statusKey);
        return (
          <div
            key={s.statusKey}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleDrop(e, s.statusKey, columnTasks.length)}
            className="flex-shrink-0 w-64 bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-2"
          >
            <div className="flex items-center gap-2 text-zinc-300 text-[12px] font-bold uppercase px-1 pb-2">
              <span style={{ color: s.color }}>&#9679;</span> {s.label} <span className="text-zinc-600">{columnTasks.length}</span>
            </div>
            {columnTasks.map((t, i) => (
              <div key={t.id} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.stopPropagation(); handleDrop(e, s.statusKey, i); }}>
                <TaskCard task={t} onDragStart={handleDragStart} onOpen={onOpenTask} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function QuickAddTask({ boardId, statuses, onAdded }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await postJson('/api/mom/tasks', { boardId, title: title.trim(), statusKey: statuses[0] && statuses[0].statusKey });
      setTitle('');
      onAdded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex gap-2 mb-4">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Quick add a task…"
        className="px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-[13px] flex-1 max-w-sm placeholder-zinc-500 focus:outline-none focus:border-purple-600"
      />
      <button
        type="submit"
        disabled={busy || !title.trim()}
        className="px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-[13px] font-bold"
      >Add task</button>
    </form>
  );
}

function TaskPanel({ task, onClose }) {
  if (!task) return null;
  return (
    <div className="fixed inset-0 bg-black/50 flex justify-end z-50" onClick={onClose}>
      <div className="w-full max-w-sm h-full bg-zinc-900 border-l border-zinc-800 p-4" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-[12px] mb-3">Close</button>
        <div className="text-zinc-100 font-bold text-[15px]">{task.title}</div>
      </div>
    </div>
  );
}

export default function MomBoard({ boardId, onBack }) {
  const [detail, setDetail] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState('');
  const [managing, setManaging] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);

  const load = () => {
    Promise.all([
      fetchJson(`/api/mom/board?id=${boardId}`),
      fetchJson(`/api/mom/tasks?boardId=${boardId}`),
    ])
      .then(([boardData, taskData]) => {
        setDetail(boardData);
        setTasks(taskData.tasks);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => { load(); }, [boardId]);

  const moveTask = async (taskId, statusKey, position) => {
    setTasks((prev) => {
      const moved = prev.find((t) => t.id === taskId);
      if (!moved) return prev;
      const outside = prev.filter((t) => t.id !== taskId && t.statusKey !== statusKey);
      const sameColumn = prev.filter((t) => t.id !== taskId && t.statusKey === statusKey);
      sameColumn.splice(position, 0, { ...moved, statusKey });
      return [...outside, ...sameColumn];
    });
    try {
      await postJson('/api/mom/reorder', { taskId, statusKey, position });
    } catch (e) {
      setError(e.message);
      load();
    }
  };

  if (error) return <div className="min-h-screen bg-zinc-950 text-red-400 p-6">{error}</div>;
  if (!detail) return <div className="min-h-screen bg-zinc-950 text-zinc-500 p-6">Loading board…</div>;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <button onClick={onBack} className="text-zinc-500 hover:text-zinc-300 text-[12px] mb-1">&larr; All boards</button>
          <h1 className="text-xl font-bold">{detail.board.name}</h1>
          {detail.board.description && <p className="text-zinc-500 text-[13px]">{detail.board.description}</p>}
        </div>
        <button
          onClick={() => setManaging((v) => !v)}
          className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-[12px] font-bold"
        >Manage</button>
      </div>

      {managing && (
        <ManagePanel
          statuses={detail.statuses} columns={detail.columns} members={detail.members}
          myRole={detail.myRole} boardId={boardId} onChanged={load} onClose={() => setManaging(false)}
        />
      )}

      <QuickAddTask boardId={boardId} statuses={detail.statuses} onAdded={load} />

      <KanbanView statuses={detail.statuses} tasks={tasks} onDropTask={moveTask} onOpenTask={setSelectedTask} />

      <TaskPanel task={selectedTask} onClose={() => setSelectedTask(null)} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

No automated test (this repo has no frontend test files). Manual verification (create board → add member → add custom field → add status → quick-add task → drag between columns → click a card) is the user's own; do not start the dev server from this session.

```bash
git add app/mom/MomBoard.js
git commit -m "feat(mom): add board detail shell, manage panel, and kanban view"
```

---

## Task 10: Frontend — table view and full task detail panel

**Files:**
- Modify: `app/mom/MomBoard.js`

**Interfaces:**
- Consumes: `putJson` (`app/mom/momApi.js`, add to the existing import).
- Produces: replaces Task 9's minimal `TaskPanel` with a fully editable one; adds `TableView` and a kanban/table toggle. `MomBoard`'s external interface (`{ boardId, onBack }`) is unchanged.

- [ ] **Step 1: Import `putJson`**

Find:
```js
import { fetchJson, postJson, deleteJson } from './momApi';
```
Replace with:
```js
import { fetchJson, postJson, putJson, deleteJson } from './momApi';
```

- [ ] **Step 2: Replace the minimal `TaskPanel` with the full edit form, and add `TableView`**

Find:
```js
function TaskPanel({ task, onClose }) {
  if (!task) return null;
  return (
    <div className="fixed inset-0 bg-black/50 flex justify-end z-50" onClick={onClose}>
      <div className="w-full max-w-sm h-full bg-zinc-900 border-l border-zinc-800 p-4" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-[12px] mb-3">Close</button>
        <div className="text-zinc-100 font-bold text-[15px]">{task.title}</div>
      </div>
    </div>
  );
}
```
Replace with:
```js
function CustomFieldInput({ column, value, onChange }) {
  if (column.type === 'checkbox') {
    return <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} />;
  }
  if (column.type === 'select') {
    const opts = column.options || [];
    return (
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px]">
        <option value="">—</option>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.value}</option>)}
      </select>
    );
  }
  const type = column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : column.type === 'person' ? 'email' : 'text';
  return (
    <input type={type} value={value || ''} onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px]" />
  );
}

function TaskPanel({ task, columns, onClose, onSaved, onDeleted }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!task) { setForm(null); return; }
    setForm({
      title: task.title, description: task.description || '', priority: task.priority || 'medium',
      assigneeEmail: task.assigneeEmail || '', dueDate: task.dueDate ? task.dueDate.slice(0, 10) : '',
      customValues: { ...task.customValues },
    });
  }, [task]);

  if (!task || !form) return null;

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await putJson('/api/mom/tasks', { id: task.id, ...form });
      onSaved();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteJson('/api/mom/tasks', { id: task.id });
      onDeleted();
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex justify-end z-50" onClick={onClose}>
      <div className="w-full max-w-sm h-full bg-zinc-900 border-l border-zinc-800 p-4 overflow-y-auto space-y-3" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-[12px]">Close</button>
        {error && <div className="text-red-400 text-[12px]">{error}</div>}
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
          className="w-full px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[14px] font-bold" />
        <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Description" rows={3}
          className="w-full px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px]" />
        <div>
          <label className="text-zinc-500 text-[11px] uppercase">Priority</label>
          <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}
            className="w-full px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px]">
            {['low', 'medium', 'high', 'urgent'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label className="text-zinc-500 text-[11px] uppercase">Assignee</label>
          <input value={form.assigneeEmail} onChange={(e) => setForm({ ...form, assigneeEmail: e.target.value })}
            className="w-full px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px]" />
        </div>
        <div>
          <label className="text-zinc-500 text-[11px] uppercase">Due date</label>
          <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
            className="w-full px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px]" />
        </div>
        {columns.map((c) => (
          <div key={c.id}>
            <label className="text-zinc-500 text-[11px] uppercase">{c.name}</label>
            <CustomFieldInput column={c} value={form.customValues[c.id]}
              onChange={(v) => setForm({ ...form, customValues: { ...form.customValues, [c.id]: v } })} />
          </div>
        ))}
        <div className="flex gap-2 pt-2">
          <button onClick={save} disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-[12px] font-bold">Save</button>
          <button onClick={remove} disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-red-900 border border-zinc-700 text-red-400 text-[12px] font-bold">Delete</button>
        </div>
      </div>
    </div>
  );
}

function TableView({ statuses, columns, tasks, onOpenTask }) {
  const statusLabel = (key) => (statuses.find((s) => s.statusKey === key) || {}).label || key;
  return (
    <div className="overflow-x-auto bg-zinc-900/60 border border-zinc-800/80 rounded-xl">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-zinc-800/80 text-zinc-500">
            <th className="py-2 px-3 text-left font-medium">Title</th>
            <th className="py-2 px-3 text-left font-medium">Status</th>
            <th className="py-2 px-3 text-left font-medium">Priority</th>
            <th className="py-2 px-3 text-left font-medium">Assignee</th>
            <th className="py-2 px-3 text-left font-medium">Due</th>
            {columns.map((c) => <th key={c.id} className="py-2 px-3 text-left font-medium">{c.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} onClick={() => onOpenTask(t)} className="border-b border-zinc-800/50 hover:bg-zinc-800/40 cursor-pointer">
              <td className="py-2 px-3 text-zinc-100">{t.title}</td>
              <td className="py-2 px-3 text-zinc-400">{statusLabel(t.statusKey)}</td>
              <td className="py-2 px-3" style={{ color: PRIORITY_COLORS[t.priority] || PRIORITY_COLORS.medium }}>{t.priority}</td>
              <td className="py-2 px-3 text-zinc-400">{t.assigneeEmail || '—'}</td>
              <td className="py-2 px-3 text-zinc-400">{t.dueDate ? t.dueDate.slice(0, 10) : '—'}</td>
              {columns.map((c) => <td key={c.id} className="py-2 px-3 text-zinc-400">{(t.customValues || {})[c.id] || '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Add the view toggle and wire the new components into `MomBoard`**

Find:
```js
  const [managing, setManaging] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);
```
Replace with:
```js
  const [managing, setManaging] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);
  const [view, setView] = useState('kanban');
```

Find:
```js
      <QuickAddTask boardId={boardId} statuses={detail.statuses} onAdded={load} />

      <KanbanView statuses={detail.statuses} tasks={tasks} onDropTask={moveTask} onOpenTask={setSelectedTask} />

      <TaskPanel task={selectedTask} onClose={() => setSelectedTask(null)} />
```
Replace with:
```js
      <QuickAddTask boardId={boardId} statuses={detail.statuses} onAdded={load} />

      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setView('kanban')}
          className={`px-3 py-1 rounded-lg text-[12px] font-bold ${view === 'kanban' ? 'bg-purple-700 text-white' : 'bg-zinc-800 text-zinc-400'}`}
        >Board</button>
        <button
          onClick={() => setView('table')}
          className={`px-3 py-1 rounded-lg text-[12px] font-bold ${view === 'table' ? 'bg-purple-700 text-white' : 'bg-zinc-800 text-zinc-400'}`}
        >Table</button>
      </div>

      {view === 'kanban' ? (
        <KanbanView statuses={detail.statuses} tasks={tasks} onDropTask={moveTask} onOpenTask={setSelectedTask} />
      ) : (
        <TableView statuses={detail.statuses} columns={detail.columns} tasks={tasks} onOpenTask={setSelectedTask} />
      )}

      <TaskPanel
        task={selectedTask} columns={detail.columns} onClose={() => setSelectedTask(null)}
        onSaved={load} onDeleted={load}
      />
```

- [ ] **Step 4: Commit**

No automated test (this repo has no frontend test files). Manual verification (switch to table view, click a row, edit every field including a custom field, save, delete a task) is the user's own; do not start the dev server from this session.

```bash
git add app/mom/MomBoard.js
git commit -m "feat(mom): add table view and full task detail panel"
```
