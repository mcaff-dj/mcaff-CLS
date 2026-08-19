# MOM Tab → Project Tracker, Phase 1 (boards, tasks, custom fields, kanban+table)

## Problem

The `mom` card (`api/_lib/db.js` `CARD_KEYS`/`CARD_LABELS`, label "MOM") exists as a permission grant but has no workspace behind it — `app/HomeClient.js`'s `COMING_SOON.mom` shows a static "MOM report is coming soon." placeholder instead of an iframe/page. There is no MOM report file in `api/_reports/` and no page under `app/`.

This spec turns the MOM tab into an Asana/Monday.com-style project tracker: multiple boards, each with its own members, tasks, and custom fields, viewable as a kanban board or a table. Full scope decided with the user: boards are per-team/project (not one shared list), tasks carry standard fields plus board-defined custom fields, and both kanban and table views are needed. Comments, subtasks, and attachments are explicitly out of scope for this phase — each gets its own design once this ships (see "Deferred" at the end).

## Data model (new tables, `PEP_CLS`, added to `bootstrapSchema()` in `api/_lib/db.js`)

Follows this file's existing convention — `CREATE TABLE IF NOT EXISTS`, idempotent, no migration history needed (fresh tables).

```sql
CREATE TABLE IF NOT EXISTS mom_boards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  created_by VARCHAR(320) NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)

CREATE TABLE IF NOT EXISTS mom_board_members (
  board_id INT NOT NULL,
  email VARCHAR(320) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'member', -- 'owner' | 'member'
  added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (board_id, email),
  FOREIGN KEY (board_id) REFERENCES mom_boards(id) ON DELETE CASCADE
)

CREATE TABLE IF NOT EXISTS mom_statuses (
  board_id INT NOT NULL,
  status_key VARCHAR(64) NOT NULL,
  label VARCHAR(64) NOT NULL,
  color VARCHAR(16) NOT NULL DEFAULT '#94a3b8',
  position INT NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, status_key),
  FOREIGN KEY (board_id) REFERENCES mom_boards(id) ON DELETE CASCADE
)

CREATE TABLE IF NOT EXISTS mom_columns (
  id INT AUTO_INCREMENT PRIMARY KEY,
  board_id INT NOT NULL,
  name VARCHAR(128) NOT NULL,
  type VARCHAR(16) NOT NULL, -- 'text' | 'number' | 'select' | 'person' | 'date' | 'checkbox'
  options JSON, -- for 'select': [{ value, color }, ...]; null for other types
  position INT NOT NULL DEFAULT 0,
  FOREIGN KEY (board_id) REFERENCES mom_boards(id) ON DELETE CASCADE
)

CREATE TABLE IF NOT EXISTS mom_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  board_id INT NOT NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  status_key VARCHAR(64) NOT NULL DEFAULT 'todo',
  priority VARCHAR(16) NOT NULL DEFAULT 'medium', -- 'low' | 'medium' | 'high' | 'urgent'
  assignee_email VARCHAR(320),
  due_date DATE,
  position INT NOT NULL DEFAULT 0, -- order within its status column
  created_by VARCHAR(320) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (board_id) REFERENCES mom_boards(id) ON DELETE CASCADE
)

CREATE TABLE IF NOT EXISTS mom_task_field_values (
  task_id INT NOT NULL,
  column_id INT NOT NULL,
  value TEXT,
  PRIMARY KEY (task_id, column_id),
  FOREIGN KEY (task_id) REFERENCES mom_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (column_id) REFERENCES mom_columns(id) ON DELETE CASCADE
)
```

`mom_statuses` is seeded per board at creation time with three rows (`todo`/"To Do", `in_progress`/"In Progress", `done`/"Done") and can be renamed/reordered/added-to per board — this is what makes the kanban columns board-specific rather than a fixed global enum. `mom_tasks.status_key` is a plain string column (not a foreign key) so a status can be deleted without an `ON DELETE` decision; deleting a status that still has tasks re-points those tasks to the board's first remaining status (see API section).

Custom field values are EAV (`mom_task_field_values`) rather than a wide table, since the column set is per-board and open-ended — the alternative (`ALTER TABLE` per custom field) doesn't fit "user adds a column from the UI."

## Access control

Two layers, both server-side:

1. **Card gate** — `session.perms` must include `mom` (existing `CARD_KEYS` entry, granted the same way as every other card).
2. **Board membership** — every board-scoped action additionally requires the caller's email to be a row in `mom_board_members` for that `board_id`, OR `session.isAdmin` (the existing company-wide admin flag, same bypass `refund-export`'s PII gate uses). The `boards` list action returns only boards the caller is a member of (admins see all). Creating a board auto-adds the creator as `role='owner'`; only an `owner` (or `session.isAdmin`) can add/remove members, edit columns, or edit statuses — any member can create/edit/move tasks.

## API — `api/mom/[action].js`

One dynamic-action handler, same shape as `api/escalation/[action].js`, mounted:

```js
mount('all', '/api/mom/:action', '../mom/[action].js', 'action');
```

Actions (`req.query.action`):

| Action | Method | Body / Query | Behavior |
|---|---|---|---|
| `boards` | GET | — | List boards caller is a member of (id, name, description, my role) |
| `boards` | POST | `{ name, description }` | Create board, seed default statuses, add caller as owner |
| `board` | GET | `?id=` | Full board detail: statuses, columns, members (owner-only sees members) |
| `board` | PUT | `{ id, name, description }` | Owner-only; rename/redescribe |
| `board` | DELETE | `{ id }` | Owner-only; sets `archived = TRUE` (soft delete, never a hard `DELETE`) |
| `members` | POST | `{ boardId, email, role }` | Owner-only; upsert membership |
| `members` | DELETE | `{ boardId, email }` | Owner-only; cannot remove the last owner |
| `columns` | POST | `{ boardId, name, type, options }` | Owner-only; append custom field |
| `columns` | PUT | `{ id, name, options, position }` | Owner-only; rename/reorder/edit options (type is immutable after creation — changing type would orphan existing values) |
| `columns` | DELETE | `{ id }` | Owner-only; cascades `mom_task_field_values` |
| `statuses` | POST | `{ boardId, label, color }` | Owner-only; append status column |
| `statuses` | PUT | `{ boardId, statusKey, label, color, position }` | Owner-only; rename/recolor/reorder |
| `statuses` | DELETE | `{ boardId, statusKey }` | Owner-only; refuses if it's the board's last status; re-points any tasks on it to the board's remaining first status (by `position`) before deleting |
| `tasks` | GET | `?boardId=` | All tasks for the board, each with its custom field values flattened in |
| `tasks` | POST | `{ boardId, title, ... }` | Member; create task, `position` = end of its status column |
| `tasks` | PUT | `{ id, title?, description?, priority?, assigneeEmail?, dueDate?, customValues? }` | Member; partial update — only supplied fields change |
| `tasks` | DELETE | `{ id }` | Member |
| `reorder` | POST | `{ taskId, statusKey, position }` | Member; the drag-drop endpoint — kept separate from `tasks` PUT so a drag only ever sends 3 fields, not the whole task, given how often it fires |

Every write validates `boardId`/`id` resolves to a real, non-archived board before touching rows — a stale client can't resurrect an archived board by posting to it.

### DB helpers (`api/_lib/db.js`)

New functions alongside the existing RTO/NDR/escalation helpers, matching that file's convention: `getMomBoardsForUser`, `createMomBoard`, `getMomBoardDetail`, `updateMomBoard`, `archiveMomBoard`, `upsertMomBoardMember`, `removeMomBoardMember`, `isMomBoardMember`, `createMomColumn`, `updateMomColumn`, `deleteMomColumn`, `createMomStatus`, `updateMomStatus`, `deleteMomStatus` (handles the task re-pointing), `getMomTasks`, `createMomTask`, `updateMomTask`, `deleteMomTask`, `reorderMomTask`.

## Frontend — `app/mom/`

Same shape as `app/rto-crm`: `page.js` (metadata, renders client) + `MomClient.js`, plus a small `MomUi.js` for board-list/board-detail-only pieces (status pill, priority badge, custom-field-type input renderer) — not shared with `_calling/ui.js`, which is calling-desk-specific.

- **Board list** (default view on `/mom`): grid/list of boards the caller belongs to, "New board" button (owner-only concept doesn't apply here — anyone with `mom` access can create a board and becomes its owner).
- **Board detail**: header (name, description, member avatars, "Manage" menu for owners → members/columns/statuses editors), then a Kanban/Table toggle:
  - **Kanban**: one column per `mom_statuses` row (in `position` order), task cards, native HTML5 drag-and-drop (`draggable`, `onDragStart`/`onDrop`) calling the `reorder` action — no drag-and-drop library, this app has none installed and the interaction is one axis (which column + index).
  - **Table**: one row per task, one column per standard field + one per `mom_columns` custom field, inline-editable cells (click to edit, blur/enter to save via `tasks` PUT), sortable by clicking a header.
  - Both views share the same task-detail side panel (click a card/row) for editing title/description/priority/assignee/due date/custom fields in one place.

## Wiring the tab live

`app/HomeClient.js`:
- Remove `mom: 'MOM report is coming soon.'` from `COMING_SOON`.
- Add `mom: '/mom'` to `NEXT_PAGE_ROUTES`.

No change to `api/_lib/db.js`'s `CARD_KEYS`/`CARD_LABELS` — `mom` already exists there.

## Error handling summary

| Case | Response |
|---|---|
| Not signed in | 401 |
| No `mom` card | 403 |
| Not a member of the target board (and not admin) | 403 |
| Non-owner attempts members/columns/statuses/board write | 403 |
| Unknown/archived `boardId` or task `id` | 404 |
| Removing the last owner, or deleting the last status | 400 |
| DB error | 500 (logged server-side) |

## Testing

Per project convention, nothing runs against the live DB from this session. What ships:
- One assert-based test for the status-delete re-pointing logic (pure function: given a board's statuses + a deleted key, which key do orphaned tasks move to) — the one branchy piece of logic in this phase.
- Manual verification (board create → member add → task create/move/edit → column add/use) is the user's own, per existing convention.

## Deferred (separate specs, after Phase 1 ships)

- **Phase 2** — comments (`mom_comments`: task_id, email, body, created_at) and subtasks (`mom_subtasks`: task_id, title, done, position), both surfaced in the task detail side panel.
- **Phase 3** — attachments on tasks, using the S3 client already in `package.json` (`@aws-sdk/client-s3`), same pattern as any existing upload flow in this repo.
- Notifications were considered and explicitly dropped — not wanted for this feature.
