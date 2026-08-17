# Move agent_presence / agent_presence_log from Postgres to MySQL

Status: approved (chat design), pending spec review.

## Context

`agent_presence` (live per-agent status) and `agent_presence_log` (append-only status
transition history) currently live on Postgres/Supabase, bootstrapped by `db.js`'s
`bootstrapPgSchema()`. This mirrors the precedent set by `lead_assignments` →
`PEP_CLS.CLS_RTO_calling` (see `migrate_cls_rto_calling_schema.py` /
`migrate_lead_assignments_to_cls_rto_calling.py`): move a frequently-written operational
table off Supabase onto the existing MySQL RDS instance this app already uses for
everything else.

`agent_presence_log` already has a partial MySQL copy: `scripts/sync_agent_presence_log_to_mysql.py`
archives it one-way (Postgres → MySQL, high-water-mark on `id`) for long-term storage, but
Postgres stays the live copy read by `getAgentPresenceLogSummary`.

**Out of scope:** `calling_business_hours`, `calling_agent_process`,
`calling_process_dispositions`, and `ndr_lead_assignments` stay on Postgres. The Postgres
`agent_presence`/`agent_presence_log` tables themselves are **not** dropped as part of this
work — left in place, retirement is a separate future decision (matches the
`lead_assignments` precedent, where the old Postgres table was also left alone after
cutover).

## Current call sites

**Write:**
- `api/_lib/db.js` `upsertAgentPresence(email, name, status)` — upserts `agent_presence`,
  conditionally inserts into `agent_presence_log` only on an actual status change (not every
  heartbeat).

**Read:**
- `api/_lib/db.js` `getAllAgentPresence()` — full-table read of `agent_presence`, used by the
  roster UI.
- `api/_lib/db.js` `getAgentPresenceLogSummary(dateFrom, dateTo)` — reads `agent_presence_log`
  for the RTO CRM Overview tab's per-agent login/break-time summary. Uses Postgres-only
  `DISTINCT ON (email) ... ORDER BY changed_at DESC` to seed each agent's status as of the
  range start.
- `scripts/assign_leads.py` `fetch_online_agents()` — reads `agent_presence` (`status =
  'Online' AND updated_at >= now() - interval`) and `calling_agent_process`, sharing one
  Postgres cursor (`_pg_cursor`).
- `scripts/assign_ndr_leads.py` `fetch_online_ndr_agents()` — same `agent_presence` query,
  same shared-cursor pattern with `calling_agent_process`.

## Target state

### Schema (MySQL `PEP_CLS`)

```sql
CREATE TABLE IF NOT EXISTS agent_presence (
  email VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255),
  status VARCHAR(50) NOT NULL,
  updated_at DATETIME NOT NULL
);
```

`agent_presence_log` already exists (created by the old archival sync script) with columns
`id INT PRIMARY KEY, email VARCHAR(255), name VARCHAR(255), status VARCHAR(50), changed_at
DATETIME`, index `email_changed_at_idx (email, changed_at)`. Its `id` is a plain INT, copied
verbatim from Postgres's serial — it must become self-assigning before the app writes to it
directly:

```sql
ALTER TABLE agent_presence_log MODIFY id INT AUTO_INCREMENT;
```

This only produces the correct next value if run **after** the final backfill (MySQL auto-sets
the next AUTO_INCREMENT value to `MAX(id) + 1` at ALTER time) — see Sequencing below.

Both new writes use `new Date()` JS values for `updated_at`/`changed_at` (never SQL `NOW()`),
matching the existing naive-but-UTC DATETIME convention already used for
`CLS_RTO_calling.assigned_at`/`disposed_at` (see `recordLeadDisposition` in `db.js`, and
`assign_leads.py`'s note that MySQL DATETIME returns naive but is UTC by convention
throughout this codebase). No new timezone handling is introduced — this reuses what's
already correct in production.

### Write path (`db.js`)

`upsertAgentPresence` switches `pgSql` → MySQL `sql`:

```js
async function upsertAgentPresence(email, name, status) {
  const { rows: prevRows } = await sql`SELECT status FROM agent_presence WHERE email = ${email}`;
  const prevStatus = prevRows[0]?.status;
  const now = new Date();
  await sql`
    INSERT INTO agent_presence (email, name, status, updated_at)
    VALUES (${email}, ${name}, ${status}, ${now})
    ON DUPLICATE KEY UPDATE name = VALUES(name), status = VALUES(status), updated_at = VALUES(updated_at)
  `;
  if (prevStatus !== status) {
    await sql`INSERT INTO agent_presence_log (email, name, status, changed_at) VALUES (${email}, ${name}, ${status}, ${now})`;
  }
}
```

No `ensurePgSchema()`/`ensureSchema()` call needed inside this function once the tables exist
via the app's normal MySQL `ensureSchema()` bootstrap (add the `CREATE TABLE IF NOT EXISTS
agent_presence` statement there, same single-flight-guarded pattern already used for
`CLS_RTO_calling` etc.).

### Read path (`db.js`)

`getAllAgentPresence` — direct port, `pgSql` → `sql`, no logic change.

`getAgentPresenceLogSummary` — the `DISTINCT ON (email) ... ORDER BY changed_at DESC` seed
query becomes:

```sql
SELECT email, status FROM (
  SELECT email, status,
         ROW_NUMBER() OVER (PARTITION BY email ORDER BY changed_at DESC) AS rn
  FROM agent_presence_log
  WHERE changed_at < ?
) t WHERE rn = 1
```

(MySQL 8.0.45 on the RDS instance supports window functions — confirmed live.) The
range-rows query and all downstream IST-bucketing/averaging logic (`istMinutesSinceMidnight`,
active-day counting, etc.) are plain JS over the returned rows and need no changes — only the
two SQL queries at the top of the function change.

### Read path (Python cron scripts)

`assign_leads.py fetch_online_agents()` and `assign_ndr_leads.py
fetch_online_ndr_agents()` currently share one Postgres cursor across the `agent_presence`
and `calling_agent_process` queries. Since `calling_agent_process` stays on Postgres, each
function now opens **two** connections: `mysql_lib.query()` (already imported in
`assign_leads.py`; needs importing in `assign_ndr_leads.py`) for `agent_presence`, unchanged
`psycopg` cursor for `calling_agent_process`. The `STALE_MINUTES` freshness filter
(`updated_at >= now() - interval '%s minutes'`) becomes `updated_at >= %s` with the cutoff
computed in Python (`datetime.utcnow() - timedelta(minutes=STALE_MINUTES)`), since MySQL
doesn't support Postgres's `interval` syntax — consistent with how this codebase already
computes date bounds in Python rather than in SQL elsewhere (`lead_priority.py`,
`dateBounds()`'s JS equivalent in `db.js`).

Both functions already fail safe on a missing Postgres config (`POSTGRES_URL` unset → return
empty, no assignment). The new MySQL read must fail equally safe: if `mysql_lib.get_credential()`
returns `None`, return the same empty-result tuple rather than raising — a missing MySQL
secret must not crash the assignment run any more than a missing Postgres one currently does.

### Backfill script

New one-time script, `scripts/migrate_agent_presence_to_mysql.py`, same shape as
`migrate_lead_assignments_to_cls_rto_calling.py`: dry-run by default (prints row counts),
`--apply` to write, single transaction on the MySQL side.

- `agent_presence`: full copy from Postgres, `INSERT ... ON DUPLICATE KEY UPDATE` (idempotent
  — safe to re-run any number of times before cutover).
- `agent_presence_log`: same high-water-mark logic the old sync script already uses
  (`WHERE id > MAX(id) in MySQL`, `INSERT IGNORE`) — this script effectively absorbs and
  replaces `sync_agent_presence_log_to_mysql.py`, so both tables are backfillable via one
  script.

Because both operations are idempotent, the script is safe to run repeatedly and should be
re-run immediately before the code deploy (see Sequencing) to shrink the gap between "last
backfill" and "app starts writing MySQL directly" to as close to zero as achievable without a
maintenance window.

### Retirement (in scope)

- Delete `scripts/sync_agent_presence_log_to_mysql.py` and its GitHub Actions trigger — once
  `db.js` writes `agent_presence_log` directly, it archives nothing new and its high-water
  mark never advances again.
- Postgres `agent_presence`/`agent_presence_log` tables and `bootstrapPgSchema()`'s
  `CREATE TABLE` statements for them: **left in place**, not dropped, per scope decision.
  (`bootstrapPgSchema()` keeps creating them harmlessly on a cold Postgres container; this is
  intentionally not cleaned up now.)

## Sequencing (must happen in this order)

1. Add `agent_presence` to MySQL `ensureSchema()`; ship (dead code path — nothing reads/writes
   it yet).
2. Run backfill script with `--apply`. Re-run it (idempotent) as many times as convenient.
3. Immediately before deploying step 4: run the backfill script one final time to minimize the
   gap.
4. `ALTER TABLE agent_presence_log MODIFY id INT AUTO_INCREMENT` — must run after the final
   backfill so the next auto-assigned id is correct, and before step 5 starts inserting rows
   without an explicit `id`.
5. Deploy the `db.js` + Python script changes (write and read paths cut over to MySQL) in one
   release. Lambda deploys atomically per invocation — there is no mixed old/new code path
   mid-request, so no dual-write period is needed.
6. Verify (manually, by the user — not automated here): roster shows correct live status,
   Overview tab per-agent summary numbers match pre-cutover Postgres-derived numbers for a
   known date range, both cron scripts still find the expected set of online agents.
7. Delete the old archival sync script + its workflow trigger.

Any failure after step 5 can be rolled back by reverting the Lambda to the previous deployed
version — Postgres tables are untouched, so a rollback loses nothing.

## Edge cases considered

- **Concurrent cold-start bootstrap:** MySQL `ensureSchema()` already collapses concurrent
  first-callers onto one bootstrap run (same pattern as `ensurePgSchema`) — the new
  `agent_presence` `CREATE TABLE IF NOT EXISTS` is safe to add there without a new guard.
- **`id` sequencing gap:** if step 4 (`ALTER ... AUTO_INCREMENT`) ran before step 3's final
  backfill, a later backfill run could try to insert a historical row with an `id` at or below
  a value MySQL already auto-assigned to a live row — the ordering above prevents this.
- **Missing MySQL credentials at runtime:** both Python readers must degrade to "no online
  agents" (matching current missing-`POSTGRES_URL` behavior) rather than raise, so a
  misconfigured secret fails an assignment run safely instead of crashing it.
- **Timezone:** no new convention introduced; reuses the existing naive-but-UTC MySQL
  DATETIME pattern already proven correct for `CLS_RTO_calling`.
- **Heartbeat volume:** `agent_presence` upserts happen every ~2 minutes per online agent
  plus on every explicit status change; this is the same write volume MySQL already absorbs
  fine for other tables in this app — no new capacity concern.

## Testing

No live DB test or deploy performed by the assistant — the user verifies against the real
database and app themselves, per this project's standing convention.
