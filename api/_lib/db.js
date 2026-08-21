// MySQL access + schema bootstrap, against the app's own schema (PEP_CLS) on the
// existing mcaff-dwh RDS instance - separate from the mcaff_dwh schema the report
// scripts read (see scripts/mysql_lib.py). Connection details come from AWS Secrets
// Manager (secret name in DB_SECRET_NAME, default "mcaff-cls/db") - not from a plain
// DB_PASSWORD env var, so the real password never sits in the Lambda's own
// configuration (which anyone able to view the function, not just invoke it, can read).
const mysql = require('mysql2/promise');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const secretsClient = new SecretsManagerClient({});
let pool = null;

// RTO CRM operational state (agent_presence and a handful of admin-editable config tables)
// intentionally stays on its own Postgres (Supabase) database, separate from the MySQL
// PEP_CLS schema above - scripts/assign_leads.py already talks to this same Postgres
// directly via psycopg; only this file's schema bootstrap and the handful of functions
// below need a Postgres connection of their own. lead_assignments itself moved OFF this
// Postgres DB onto MySQL PEP_CLS.CLS_RTO_calling (see migrate_cls_rto_calling_schema.py /
// migrate_lead_assignments_to_cls_rto_calling.py) - it is not one of the tables bootstrapped
// below.
const { Pool: PgPool } = require('pg');
let pgPool = null;

// Supabase's pooler serves the SAME project on two ports, and which one the URL names decides
// whether this app can scale at all:
//   :5432 session mode     - a backend is pinned to a client for that client's whole life, so
//                            the project's pool_size (15) is a cap on CONCURRENT CLIENTS. The
//                            16th is refused outright: "(EMAXCONNSESSION) max clients reached
//                            in session mode".
//   :6543 transaction mode - a backend is held only for the duration of a statement/
//                            transaction, so those same 15 backends multiplex across far more
//                            clients than 15.
// Lambda has no container cap that corresponds to pool_size - it answers load by adding
// containers - so session mode's per-client pinning is the actual source of EMAXCONNSESSION,
// and no `max` value can fix that by itself. Transaction mode is what serverless wants.
//
// Rewritten HERE rather than by editing POSTGRES_URL in Secrets Manager so it can't regress:
// the secret is shared with the cron scripts and re-entered by hand, and a URL that silently
// reverts to :5432 brings the outage straight back with no trace in the repo.
//
// Only ever touches Supabase's own pooler hostname - a direct Postgres host has nothing
// listening on 6543, so rewriting one would take the app down instead of fixing it, and a URL
// already naming an explicit non-5432 port is left exactly as written. Port surgery is done by
// regex on the host segment specifically to avoid a URL parse/serialize round trip, which
// would re-encode a password containing reserved characters and could change what it means.
const POOLER_SESSION_PORT = /(@[^/@?]*\.pooler\.supabase\.com)(:5432)?(?=[/?]|$)/i;
function toTransactionModePooler(conn) {
  return conn.replace(POOLER_SESSION_PORT, '$1:6543');
}

function getPgPool() {
  if (pgPool) return pgPool;
  const raw = process.env.POSTGRES_URL;
  if (!raw) throw new Error('Missing POSTGRES_URL env var');
  const conn = toTransactionModePooler(raw);
  const transactionMode = conn !== raw || /:6543(?=[/?]|$)/.test(conn);
  if (conn !== raw) console.error('POSTGRES_URL named the Supabase pooler in session mode (5432); connecting in transaction mode (6543) instead');

  // `pg`'s `max` is PER POOL INSTANCE and this pool is a per-container singleton, so the real
  // connection footprint is max x (live containers). In transaction mode the pooler multiplexes
  // and a few connections per container is cheap, which buys back the intra-request parallelism
  // getCallingOverviewData's Promise.all wants. If the rewrite above did NOT apply - a legacy or
  // non-Supabase host we must not guess about - we are still on a hard 15-CLIENT ceiling, so
  // hold each container to a single connection and let ~15 of them fit rather than ~5.
  // idleTimeoutMillis hands connections back quickly once traffic quiets instead of holding them.
  pgPool = new PgPool({
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
    max: transactionMode ? 3 : 1,
    idleTimeoutMillis: 10000,
  });
  return pgPool;
}

// The pooler admits a hard-capped number of client connections for the WHOLE project
// (pool_size: 15) and refuses the next one outright. Lambda concurrency has no matching cap -
// it just adds containers - so even in transaction mode a burst can still find the door shut.
//
// Safe to retry precisely because the refusal happens during CONNECT, before any SQL is
// sent - the statement provably never reached Postgres, so a retry cannot double-apply a
// write. That is why this is gated on that one message and nothing else: a genuine query
// error (constraint violation, syntax, timeout mid-statement) must still propagate
// untouched, since retrying those could re-run work that already partly happened.
const PG_CONNECT_RETRIES = 4;
function isPoolExhausted(e) {
  return /EMAXCONNSESSION|max clients reached/i.test((e && e.message) || '');
}
async function withPgConnectRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= PG_CONNECT_RETRIES || !isPoolExhausted(e)) throw e;
      // Exponential (100/200/400/800ms) plus jitter - a burst of containers all refused at the
      // same instant would otherwise retry in lockstep and just refuse each other again.
      const delay = 100 * 2 ** attempt + Math.floor(Math.random() * 100);
      console.error(`Postgres pool exhausted; retry ${attempt + 1}/${PG_CONNECT_RETRIES} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Same sql`...` tagged-template calling convention every call site below already
// uses (and the same trick the MySQL sql() shim above plays) - just against a plain
// `pg` Pool instead of a provider-specific driver, so this works against any
// standard Postgres endpoint (Supabase, RDS, etc.), not tied to one vendor's proxy
// protocol.
async function pgSql(strings, ...values) {
  let text = '';
  strings.forEach((s, i) => {
    text += s;
    if (i < values.length) text += `$${i + 1}`;
  });
  const { rows } = await withPgConnectRetry(() => getPgPool().query(text, values));
  return { rows };
}

// Runs `work` against ONE dedicated connection wrapped in BEGIN/COMMIT (ROLLBACK on
// error) - unlike pgSql above, which checks out a fresh pooled connection per call, so
// a session-scoped guarantee (a multi-statement transaction, an advisory lock held
// across statements) needs this instead. work receives the raw `pg` client - use
// client.query(text, params) with plain $1/$2 placeholders, not the pgSql tagged
// template (which would grab a DIFFERENT connection and defeat the point).
async function withPgTransaction(work) {
  // Only the checkout retries - never `work` itself, which may already have written by the
  // time it throws.
  const client = await withPgConnectRetry(() => getPgPool().connect());
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Pass the error to release() so node-postgres discards this connection instead of
    // returning a possibly-poisoned one (mid-transaction failure, connection reset mid-
    // query, etc.) to the pool for the next caller to inherit.
    client.release(err);
    throw err;
  }
}

// Short-lived read cache for the handful of queries that pull WHOLE tables back over the wire.
// This exists for Supabase EGRESS, not latency - a few agents working a normal day can move
// gigabytes out of Postgres for data that changes far more slowly than it is read.
//
// Caches the PROMISE, not the resolved value, so N concurrent requests that arrive together
// (the common case - one page load fires orders + assignments at once) collapse onto one query
// instead of racing to fill the same slot. A rejected read evicts itself so a transient failure
// isn't served for the rest of the TTL.
//
// ponytail: per-container, so a write in one warm Lambda cannot invalidate another's copy -
// staleness is bounded by CACHE_TTL_MS, not by the invalidation calls below (those only make
// the writer's OWN next read correct immediately, which is what the agent who just clicked
// sees). If cross-container freshness ever matters, move this to Redis or a LISTEN/NOTIFY
// channel rather than shortening the TTL to nothing.
const CACHE_TTL_MS = 300000;
const readCache = new Map();

function cachedRead(key, fn) {
  const hit = readCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = fn().catch((e) => {
    // Only evict if this entry is still the live one - a later read may already have replaced it.
    if (readCache.get(key) && readCache.get(key).promise === promise) readCache.delete(key);
    throw e;
  });
  readCache.set(key, { at: Date.now(), promise });
  return promise;
}

// Prefix-scoped so one desk's writes don't throw away another's cached reads.
function invalidateCache(prefix) {
  for (const key of readCache.keys()) {
    if (key.startsWith(prefix)) readCache.delete(key);
  }
}

// Fetched once per warm Lambda instance, then reused - same "do it once, cache it"
// idea as ensureSchema()'s schemaReady flag below.
async function getPool() {
  if (pool) return pool;
  const secretName = process.env.DB_SECRET_NAME || 'mcaff-cls/db';
  const { SecretString } = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
  const creds = JSON.parse(SecretString);
  pool = mysql.createPool({
    host: creds.host,
    user: creds.user,
    password: creds.password,
    database: creds.database || 'PEP_CLS',
    port: Number(creds.port) || 3306,
    ssl: { rejectUnauthorized: false }, // RDS requires TLS; harden to the RDS CA bundle later if needed
    connectionLimit: 5,
    namedPlaceholders: false,
  });
  return pool;
}

// Postgres's `sql` tagged-template call sites (admin/*.js) are kept working as-is by
// giving MySQL the same calling convention: sql`... ${value} ...` -> a parameterized
// query, resolved to { rows, insertId, affectedRows }. `rows` is only ever populated
// for SELECTs - mysql2 returns a ResultSetHeader (not an array) for INSERT/UPDATE/DELETE,
// which is where insertId/affectedRows come from instead of Postgres's RETURNING.
async function sql(strings, ...values) {
  let text = '';
  strings.forEach((s, i) => {
    text += s;
    if (i < values.length) text += '?';
  });
  const p = await getPool();
  const [result] = await p.execute(text, values);
  const rows = Array.isArray(result) ? result : [];
  return { rows, insertId: result.insertId, affectedRows: result.affectedRows };
}

let schemaReady = false;
let schemaPromise = null;

// Same in-flight deduplication as ensurePgSchema below, for the same reason - see its comment.
// MySQL is not the database that ran out of connections, but the amplification is identical
// (api/auth/[action].js fans out to three functions that each land here), and one shared
// bootstrap run per container is what this always meant to be.
async function ensureSchema() {
  if (schemaReady) return;
  if (!schemaPromise) schemaPromise = bootstrapSchema().finally(() => { schemaPromise = null; });
  return schemaPromise;
}

// Idempotent - safe to call on every cold start. Only runs the DDL once per warm instance.
// This is a fresh schema (PEP_CLS), so unlike the Postgres version, there's no historical
// ALTER/rename migrations to carry forward - just the final desired shape.
async function bootstrapSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(320) UNIQUE NOT NULL,
      name VARCHAR(255),
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS permissions (
      user_id INT NOT NULL,
      card_key VARCHAR(64) NOT NULL,
      granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, card_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      email VARCHAR(320) NOT NULL,
      card_key VARCHAR(64),
      action VARCHAR(32) NOT NULL DEFAULT 'view',
      detail TEXT,
      accessed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ip VARCHAR(64),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `;
  // Sub-permission within an already-granted card (e.g. "just the CSAT tab under
  // Hyphen"), UI-level only - see api/_lib/tabs.js. No rows for a (user, card) pair
  // means "no restriction, full access to every tab".
  await sql`
    CREATE TABLE IF NOT EXISTS report_tab_permissions (
      user_id INT NOT NULL,
      card_key VARCHAR(64) NOT NULL,
      tab_key VARCHAR(64) NOT NULL,
      granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, card_key, tab_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `;
  // The npsdeepdive card was renamed to deepdive (gained a CSAT/Agent tab split) -
  // carry forward any rows granted under the old key so no one silently loses
  // access. Safe to run on every cold start: a no-op once the old key is gone.
  await sql`UPDATE permissions SET card_key = 'deepdive' WHERE card_key = 'npsdeepdive'`;
  await sql`UPDATE report_tab_permissions SET card_key = 'deepdive' WHERE card_key = 'npsdeepdive'`;
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

let pgSchemaReady = false;
let pgSchemaPromise = null;

// Collapses concurrent first-callers onto ONE bootstrap run. `pgSchemaReady` is only set after
// the LAST statement below, so it cannot deduplicate callers that are already in flight: on a
// cold container every function in a Promise.all (getCallingOverviewData fans out to four,
// each of which awaits this) saw false and each re-ran the whole ~45-statement DDL list. That
// multiplied both the statement count and - the part that actually broke - the number of
// connections one container demanded at once, so a handful of containers could exhaust a
// pool_size the connection settings alone were sized to fit comfortably. It also made every
// concurrent run race every other one through the duplicate-object window the catch below
// exists to absorb.
//
// Cleared once settled, so a bootstrap that failed for a real reason is retried by the next
// request instead of leaving the container permanently stuck awaiting a rejected promise. On
// success `pgSchemaReady` has already been set, so the fast path above short-circuits and this
// promise is never rebuilt.
async function ensurePgSchema() {
  if (pgSchemaReady) return;
  if (!pgSchemaPromise) pgSchemaPromise = bootstrapPgSchema().finally(() => { pgSchemaPromise = null; });
  return pgSchemaPromise;
}

// RTO CRM operational tables - separate Postgres database (see the pgSql setup
// above), separate idempotent-once-per-warm-instance flag from the MySQL schema.
async function bootstrapPgSchema() {
  try {
  // Agent online/offline state (replaces the removed Supabase agent_status table) -
  // one row per agent, upserted on every explicit status change and periodic
  // heartbeat. scripts/assign_leads.py reads this directly (via its own psycopg
  // connection) to decide who's eligible for new leads.
  await pgSql`
    CREATE TABLE IF NOT EXISTS agent_presence (
      email TEXT PRIMARY KEY,
      name TEXT,
      status TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  // Per-process, per-weekday calling hours, editable by an admin from the CRM's own admin
  // panel. Lives here rather than in api/_lib/callingProcesses.json because it has to be
  // changeable at runtime - that file now only supplies the DEFAULTS used to seed a process
  // that has never been edited. scripts/assign_leads.py reads this table directly (its own
  // psycopg connection, same as agent_presence) to decide whether it may hand out leads.
  //
  // open_time/close_time are 'HH:MM' local wall-clock in the process's timezone, close
  // exclusive. Either being NULL/'' means CLOSED that day - which is how a blank Sunday in the
  // editor is stored, rather than deleting the row and losing the fact that it was set.
  await pgSql`
    CREATE TABLE IF NOT EXISTS calling_business_hours (
      process_key TEXT NOT NULL,
      day TEXT NOT NULL,
      open_time TEXT,
      close_time TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      PRIMARY KEY (process_key, day)
    )
  `;
  // Per-process availability and capacity for one agent. The processes are independent, so an
  // agent can be Online for RTO and Offline for NDR with a different quota in each - which a
  // single row per agent (agent_presence, above) cannot express.
  //
  // This is operational state ONLY. Whether an agent belongs to a process at all is decided by
  // their invitation (report_tab_permissions, card 'calling', tab '<process>'), so a row here
  // for an uninvited agent grants nothing. It also replaces the browser-held
  // 'rto_agent_roster' as the authority for status/quota: that lives in localStorage, which the
  // agent can edit, so scripts/assign_leads.py could never have trusted it.
  await pgSql`
    CREATE TABLE IF NOT EXISTS calling_agent_process (
      email TEXT NOT NULL,
      process_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Offline',
      max_quota INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      PRIMARY KEY (email, process_key)
    )
  `;
  // One row per RTO CSV upload. rows_pending holds the validated, deduped rows still awaiting
  // the background worker (scripts/process_rto_csv_upload_job.py) - cleared to NULL once the
  // job reaches 'done' or 'failed', since nothing needs them after that. errors is a capped
  // sample ({line, reason}[], max 50) - see api/_lib/rtoCsvImport.js's buildRowPlan for where
  // these originate. See docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md for the
  // full job lifecycle.
  await pgSql`
    CREATE TABLE IF NOT EXISTS rto_csv_upload_jobs (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      total_rows INTEGER NOT NULL,
      prepaid_count INTEGER NOT NULL,
      checked_count INTEGER NOT NULL DEFAULT 0,
      already_refunded_count INTEGER NOT NULL DEFAULT 0,
      already_punched_count INTEGER NOT NULL DEFAULT 0,
      appended_count INTEGER NOT NULL DEFAULT 0,
      duplicate_in_sheet_count INTEGER NOT NULL DEFAULT 0,
      duplicate_in_file_count INTEGER NOT NULL DEFAULT 0,
      missing_awb_count INTEGER NOT NULL DEFAULT 0,
      rows_pending JSONB,
      errors JSONB,
      error_message TEXT
    )
  `;
  // Admin OF ONE PROCESS: may manage that process's roster and calling hours, and sees that
  // process's full team data (leads, tickets, per-agent metrics) the same way a company-wide
  // admin would - RtoCrmClient.js exempts isProcessAdmin from every "an Agent only sees their
  // own leads" restriction, same as it already exempted them from the Admin-tab redirect.
  // Nothing outside this one process, and no access to other cards/reports/the /admin panel.
  // Deliberately not users.is_admin, which is company-wide - it would also hand over every
  // other report plus /admin, where someone can re-grant anyone's access and delete users.
  // "Run the RTO desk" and "administer the whole site" are different jobs, and only this
  // table can express the narrow one, since it is already keyed per (agent, process).
  //
  // Grants no data access on its own: the agent still needs the 'calling' card and that
  // process's invitation row to see the process at all.
  await pgSql`ALTER TABLE calling_agent_process ADD COLUMN IF NOT EXISTS is_process_admin BOOLEAN NOT NULL DEFAULT false`;
  // Soft prepaid-mix target for this agent's assignment round-robin (0-100, NULL = no target,
  // i.e. unrestricted like every agent before this existed). Steers, never blocks outright -
  // see build_assignment_queue's agent_prepaid_target parameter.
  await pgSql`ALTER TABLE calling_agent_process ADD COLUMN IF NOT EXISTS prepaid_pct INTEGER`;
  // Comma-separated RTO-reason substrings (case-insensitive, same substring-match convention
  // as leadAssignmentRules.json's own reason lists) this agent specializes in - a matching
  // lead gets first refusal to them before the general round-robin, same as
  // build_assignment_queue's agent_specializations parameter. NULL/empty = no specialization.
  await pgSql`ALTER TABLE calling_agent_process ADD COLUMN IF NOT EXISTS priority_rto_reasons TEXT`;
  // Hard filter on Connected=No REASSIGNMENTS only (never a fresh/never-touched lead): '' =
  // no restriction (reassigned leads of either payment type may land on this agent, same as
  // every agent before this existed), 'Prepaid'/'COD' = this agent only ever receives a
  // reassignment of that one payment type - unlike prepaid_pct above, this never relaxes on a
  // later pass, so a reassignment whose type no online agent accepts is left unassigned rather
  // than forced onto someone. See build_assignment_queue's agent_reassign_payment_mode
  // parameter.
  await pgSql`ALTER TABLE calling_agent_process ADD COLUMN IF NOT EXISTS reassign_payment_mode TEXT`;
  // Hard filter on how many prior delivery attempts (cp_ndr_attempts) a lead has had - NDR
  // Calling's own equivalent of reassign_payment_mode above, same "'' = no restriction" real-
  // value contract, but applied to EVERY lead (not just reassignments): comma-separated subset
  // of '1', '2', '3', 'More than 3'. See scripts/assign_ndr_leads.py's agent_attempt_filter -
  // a lead whose bucket no online agent's filter covers is left unassigned rather than forced
  // onto someone.
  await pgSql`ALTER TABLE calling_agent_process ADD COLUMN IF NOT EXISTS attempt_count_filter TEXT`;
  // Hard filter on a lead's Latest NDR Reason (NDR Calling only) - same "'' = no restriction"
  // contract as attempt_count_filter above, but free-text substrings instead of a fixed bucket
  // list, since courier NDR-reason strings aren't a small enumerable set. See
  // scripts/assign_ndr_leads.py's agent_reason_filter - a lead whose reason no online agent's
  // filter matches is left unassigned rather than forced onto someone.
  await pgSql`ALTER TABLE calling_agent_process ADD COLUMN IF NOT EXISTS ndr_reason_filter TEXT`;
  // Hard filter on a lead's Payment Mode (NDR Calling only, sheet column L) - same "'' = no
  // restriction" contract as attempt_count_filter/ndr_reason_filter above, applied to EVERY
  // lead (unlike RTO's reassign_payment_mode, which only ever gates reassignments). Exact,
  // case-insensitive match against 'Prepaid' or 'COD' - a fixed, controlled value set, unlike
  // the free-text ndr_reason_filter. See scripts/assign_ndr_leads.py's agent_payment_mode_filter.
  await pgSql`ALTER TABLE calling_agent_process ADD COLUMN IF NOT EXISTS ndr_payment_mode_filter TEXT`;
  // Hard filter on a lead's Brand - derived from Order ID (sheet column A), not a sheet column
  // of its own: an order ID starting with "HYP" is Hyphen, everything else is mCaffeine. Same
  // "'' = no restriction" contract as the filters above. See scripts/assign_ndr_leads.py's
  // brand_of/agent_brand_filter.
  await pgSql`ALTER TABLE calling_agent_process ADD COLUMN IF NOT EXISTS ndr_brand_filter TEXT`;
  // A process's own admin-defined disposition list - e.g. NDR Calling's Admin Panel, where
  // (unlike RTO) there is no hardcoded disposition set in RtoCrmClient.js to fall back to, so
  // an admin has to be able to build one from scratch. Deliberately per-process (process_key,
  // not a global list) and deliberately NOT touching RTO's own connectedOutcomes/
  // unreachableOutcomes arrays - those stay hardcoded exactly as they are; this table only
  // backs processes that have no disposition list of their own yet.
  await pgSql`
    CREATE TABLE IF NOT EXISTS calling_process_dispositions (
      id SERIAL PRIMARY KEY,
      process_key TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by TEXT
    )
  `;
  await pgSql`CREATE INDEX IF NOT EXISTS calling_process_dispositions_process_key_idx ON calling_process_dispositions (process_key, sort_order)`;
  // One level of nesting - a disposition option (e.g. "Wrong Address") can have its own child
  // reasons, same "N child ›" pattern as a normal ticket-field Category option. NULL = a
  // top-level option; sort_order is scoped to siblings sharing the same parent_id (and
  // separately to every top-level option, which all share parent_id IS NULL), not global -
  // reordering one option's children never touches another option's order or the top level's.
  // ON DELETE CASCADE: deleting a parent takes its children with it, since an orphaned child
  // (pointing at a parent_id that no longer exists) has nowhere left to render.
  await pgSql`ALTER TABLE calling_process_dispositions ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES calling_process_dispositions(id) ON DELETE CASCADE`;
  await pgSql`CREATE INDEX IF NOT EXISTS calling_process_dispositions_parent_idx ON calling_process_dispositions (parent_id, sort_order)`;
  // What an agent sees when they open THIS row's children: 'single' (buttons, may drill deeper
  // into whichever child they pick - the only mode that existed before this column, hence the
  // default) or 'multi' (checkboxes, one or more) or 'text' (free-typed, no picklist at all).
  // multi/text are always a LEAF - the agent-side picker never drills past one (see
  // DeliveryEscalationClient.js's dispLevels), so a node with children rows AND
  // children_input_type='text' simply has those children rows ignored, not rendered.
  // Delivery-Escalation-only today (see ProcessDispositionsCard's allowInputTypeControl prop) -
  // the column itself is shared across every process's rows since it lives on this one table,
  // but NDR/RTO's own admin UI never shows a control to set it, so their rows can only ever
  // default to 'single' and their existing single-choice behavior is unaffected.
  await pgSql`ALTER TABLE calling_process_dispositions ADD COLUMN IF NOT EXISTS children_input_type TEXT NOT NULL DEFAULT 'single'`;
  // Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so this throws 42710 (duplicate_object) on
  // EVERY run after the very first - permanently, unlike the transient race the function-level
  // catch below exists for. Caught HERE, right at the statement, because that outer catch
  // swallows 42710 and then SKIPS EVERY REMAINING STATEMENT while still setting
  // pgSchemaReady = true. That silently truncated this whole bootstrap from 2026-08-18 (when
  // this constraint landed) onward: the order_punch_* tables added further down on 2026-08-21
  // were never created in production at all, and the Order Punch tab failed with
  // `relation "order_punch_settings" does not exist` on a fully-deployed build.
  //
  // Any future non-idempotent DDL in this function needs its own guard exactly like this one -
  // enforced offline by api/_lib/db.pgSchema.test.js so this cannot silently regress again.
  try {
    await pgSql`ALTER TABLE calling_process_dispositions ADD CONSTRAINT calling_process_dispositions_children_input_type_check CHECK (children_input_type IN ('single', 'multi', 'text'))`;
  } catch (e) {
    if (e.code !== '42710') throw e;
  }
  // Append-only history of every status transition an agent has ever had (Online /
  // Busy / Offline), so agent_presence above can stay a single row per agent while this
  // one answers "when did each change happen" - e.g. for a future audit trail or
  // break-duration report. Written by upsertAgentPresence only when the status actually
  // changes, not on every heartbeat, so it doesn't fill up with repeated identical rows.
  await pgSql`
    CREATE TABLE IF NOT EXISTS agent_presence_log (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      status TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await pgSql`CREATE INDEX IF NOT EXISTS agent_presence_log_email_idx ON agent_presence_log (email, changed_at DESC)`;
  // NDR Calling's own assignment/disposition history - the same role MySQL's CLS_RTO_calling
  // plays for RTO (see migrate_cls_rto_calling_schema.py), but deliberately a SEPARATE table
  // (not a shared/generic one) and still on this Postgres DB: NDR has no
  // reassignment/connected/refund workflow yet, so this only carries the shape actually used
  // today, and never had RTO's Supabase-storage-quota pressure that motivated moving RTO's
  // table off Postgres. Parallel write alongside the Google Sheet (scripts/assign_ndr_leads.py's
  // Q:R, the Call modal's S:U in app/rto-crm/RtoCrmClient.js) - the sheet stays what the UI reads
  // from; this is the durable/queryable history side, same relationship RTO's own sheet
  // Column Q + CLS_RTO_calling already have. reassigned_away_at exists for the same
  // future-proofing reason RTO's table has it, but nothing sets it yet - NDR has no retry
  // loop to reassign a lead away from anyone.
  await pgSql`
    CREATE TABLE IF NOT EXISTS ndr_lead_assignments (
      id BIGSERIAL PRIMARY KEY,
      awb_number TEXT NOT NULL,
      email TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reassigned_away_at TIMESTAMPTZ,
      disposed_at TIMESTAMPTZ,
      disposition TEXT,
      agent_remarks TEXT
    )
  `;
  // Order Punch - background repunch pipeline, ported from the "Repunch Pipeline" Google Apps
  // Script. See docs/superpowers/specs/2026-08-21-order-punch-design.md. id is BIGSERIAL to
  // match rto_csv_upload_jobs' own id convention (not UUID).
  await pgSql`
    CREATE TABLE IF NOT EXISTS order_punch_jobs (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      total_rows INTEGER NOT NULL,
      processed_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      stop_requested BOOLEAN NOT NULL DEFAULT false,
      error_message TEXT
    )
  `;
  // One row per order to repunch. status/so_code/target_channel/error_message are written by
  // the Python worker (its own psycopg connection) as each row is processed - Node only ever
  // INSERTs these at job creation (see createOrderPunchJob below).
  await pgSql`
    CREATE TABLE IF NOT EXISTS order_punch_job_rows (
      job_id BIGINT NOT NULL REFERENCES order_punch_jobs(id),
      row_index INTEGER NOT NULL,
      display_order_code TEXT NOT NULL,
      reason TEXT,
      facility_code TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      so_code TEXT,
      target_channel TEXT,
      error_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (job_id, row_index)
    )
  `;
  // Every worker invocation's first query is "pending rows for this job, in row_index order" -
  // this partial index keeps that cheap regardless of job size (no cap - see the design spec).
  await pgSql`
    CREATE INDEX IF NOT EXISTS order_punch_job_rows_pending_idx
    ON order_punch_job_rows (job_id, row_index) WHERE status = 'pending'
  `;
  // Admin-editable settings, seeded below with the Apps Script's own hardcoded constants so
  // behavior is identical on day one. The Python worker reads this table directly (its own
  // psycopg connection) at the start of each invocation.
  await pgSql`
    CREATE TABLE IF NOT EXISTS order_punch_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT NOT NULL
    )
  `;
  // Seed defaults once - ON CONFLICT DO NOTHING means an admin's later edit is never
  // overwritten by a subsequent cold start re-running this bootstrap.
  await pgSql`
    INSERT INTO order_punch_settings (key, value, updated_by) VALUES
      ('facility_codes', '["HYP_SRKOL","HYP_SRBGLR","mCaff_Mumbai2","mCaff_Gurgaon3","HYP_AHMD","HYP_SRLOK2","HYP_SRGWHT","Omnivio_Noida1","HYP_DLNAG"]'::jsonb, 'system'),
      ('mcaffeine_channels', '["SHOPIFY","FIEN_SHOPIFY","HYPD","COMPENSATION","MCaf_Shopify.in","MCAFF_TEST"]'::jsonb, 'system'),
      ('hyphen_channels', '["HYP_SHOPIFY","HYPD_HYPHEN","HYP_COMPENSATION","HYP_SHOPIFY_IN"]'::jsonb, 'system'),
      ('target_mcaffeine', '"MCAFFEINE_D2C"'::jsonb, 'system'),
      ('target_hyphen', '"HYPHEN_D2C"'::jsonb, 'system'),
      ('cooldown_days', '3'::jsonb, 'system'),
      ('max_suffix', '2'::jsonb, 'system')
    ON CONFLICT (key) DO NOTHING
  `;
  // At most one live cycle per awb - same partial-unique-index pattern as RTO's own
  // live-cycle uniqueness (now a generated-column emulation on MySQL, since Postgres has a
  // real partial index and this table stays on Postgres), so claimNdrLead's ON CONFLICT
  // below has a real arbiter to target.
  await pgSql`CREATE UNIQUE INDEX IF NOT EXISTS ndr_lead_assignments_awb_current_key ON ndr_lead_assignments (awb_number) WHERE reassigned_away_at IS NULL`;
  } catch (e) {
    // Postgres codes for "already exists" (duplicate_column/duplicate_table/duplicate_object)
    // - a benign race, not a real failure: every statement above is its own ADD COLUMN IF NOT
    // EXISTS/CREATE ... IF NOT EXISTS, but two concurrent cold Lambda starts can still both
    // pass that check before either commits (a known Postgres race, most likely right after a
    // deploy when a burst of containers all run this for the first time at once). The desired
    // end state is already reached either way. Previously a hit here left pgSchemaReady false,
    // so that same warm container re-ran this entire statement list - and could 500 again - on
    // every subsequent request until it happened to win the race. Anything else (a real
    // connectivity/permissions failure) still propagates - masking that would let callers query
    // tables that were never actually created.
    if (!['42701', '42P07', '42710'].includes(e.code)) throw e;
    console.error('ensurePgSchema: benign already-exists race, continuing:', e.code, e.message);
  }
  pgSchemaReady = true;
}

const CARD_KEYS = ['mcaffeine', 'hyphen', 'productkyc', 'mom', 'calling', 'onboarding', 'deepdive', 'orgoverview', 'nps'];
const CARD_LABELS = {
  mcaffeine: 'mCaffeine', hyphen: 'Hyphen', productkyc: 'Product Calling KYC',
  mom: 'MOM', calling: 'Calling Team', onboarding: 'Onboarding Test', deepdive: 'Deep Dive',
  orgoverview: 'Org Overview', nps: 'NPS Survey Admin',
};

async function getUserByEmail(email) {
  await ensureSchema();
  const { rows } = await sql`SELECT id, email, name, is_admin FROM users WHERE email = ${email}`;
  return rows[0] || null;
}

// Used by session.js on every request to re-verify a session's user still exists (and
// re-derive their current perms) - a signed cookie alone can't reflect a
// deletion/permission change made after it was issued, so this closes that gap by
// checking the current row on each call instead of trusting what was baked into the
// cookie at login time.
async function getUserById(userId) {
  await ensureSchema();
  const { rows } = await sql`SELECT id, email, name, is_admin FROM users WHERE id = ${userId}`;
  return rows[0] || null;
}

// Deletes the user row outright (not just their permissions) - permissions and
// report_tab_permissions cascade-delete via their FK; audit_log rows are kept
// (user_id set to NULL via ON DELETE SET NULL) so past access history survives.
async function deleteUser(userId) {
  await ensureSchema();
  const { rows } = await sql`SELECT email FROM users WHERE id = ${userId}`;
  if (!rows[0]) return null;
  await sql`DELETE FROM users WHERE id = ${userId}`;
  return rows[0];
}

async function getUserPermissions(userId) {
  await ensureSchema();
  const { rows } = await sql`SELECT card_key FROM permissions WHERE user_id = ${userId}`;
  return rows.map((r) => r.card_key);
}

// Returns { cardKey: [tabKey, ...] } - only for card keys that have an actual
// restriction; a card with no entry here means "no restriction, every tab".
async function getUserTabPermissions(userId) {
  await ensureSchema();
  const { rows } = await sql`SELECT card_key, tab_key FROM report_tab_permissions WHERE user_id = ${userId}`;
  const out = {};
  for (const r of rows) {
    (out[r.card_key] = out[r.card_key] || []).push(r.tab_key);
  }
  return out;
}

// Replaces the full set of allowed tabs for (userId, cardKey) with exactly
// tabKeys - an empty array removes the restriction entirely (full access).
async function setTabPermissions(userId, cardKey, tabKeys) {
  await ensureSchema();
  await sql`DELETE FROM report_tab_permissions WHERE user_id = ${userId} AND card_key = ${cardKey}`;
  for (const tabKey of tabKeys) {
    await sql`INSERT IGNORE INTO report_tab_permissions (user_id, card_key, tab_key) VALUES (${userId}, ${cardKey}, ${tabKey})`;
  }
}

// Auto-provisions the very first admin(s) from ADMIN_EMAILS on their first successful
// Google login, since there's no self-serve signup - someone has to be admin #1.
async function bootstrapAdminIfNeeded(email, name) {
  await ensureSchema();
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!adminEmails.includes(email.toLowerCase())) return null;

  const existing = await getUserByEmail(email);
  if (existing) {
    if (!existing.is_admin) {
      await sql`UPDATE users SET is_admin = TRUE WHERE id = ${existing.id}`;
    }
    for (const key of CARD_KEYS) {
      await sql`INSERT IGNORE INTO permissions (user_id, card_key) VALUES (${existing.id}, ${key})`;
    }
    return { ...existing, is_admin: true };
  }
  const { insertId } = await sql`INSERT INTO users (email, name, is_admin) VALUES (${email}, ${name}, TRUE)`;
  const user = { id: insertId, email, name, is_admin: true };
  for (const key of CARD_KEYS) {
    await sql`INSERT IGNORE INTO permissions (user_id, card_key) VALUES (${user.id}, ${key})`;
  }
  return user;
}

// action: 'view' | 'login' | 'csv_export' | 'raw_download'. detail is free text (e.g. the
// tab/table that was exported) - null where there's nothing more specific to record.
// ip defaults to null, not undefined: mysql2 rejects an undefined bind parameter outright
// ("Bind parameters must not contain undefined") rather than treating it as SQL NULL, so any
// caller that omits ip - three call sites in api/admin/[action].js did, all added today - made
// this throw AFTER whatever real write already happened in the same handler, which reported
// the whole request as failed even though the actual change had already committed. Every
// pre-existing call site in the codebase already passes ip explicitly; this default is a
// backstop against the next one that doesn't, not a fix for those.
async function logEvent(userId, email, cardKey, action, detail, ip = null) {
  await ensureSchema();
  await sql`INSERT INTO audit_log (user_id, email, card_key, action, detail, ip) VALUES (${userId}, ${email}, ${cardKey}, ${action}, ${detail}, ${ip})`;
}

async function logAccess(userId, email, cardKey, ip) {
  return logEvent(userId, email, cardKey, 'view', null, ip);
}

// status: 'Online' | 'Busy' | 'OnCall' | 'Offline' (see CALLING_STATUSES above for why
// 'Busy' and 'OnCall' are two different values). email/name always come from the caller's own
// session, never from client-supplied data, so an agent can only ever set their own
// presence - not spoof anyone else's (the gap that made the old Supabase anon-key
// design insecure).
async function upsertAgentPresence(email, name, status) {
  await ensureSchema();
  const { rows: prevRows } = await sql`SELECT status FROM agent_presence WHERE email = ${email}`;
  const prevStatus = prevRows[0]?.status;
  const now = new Date();
  await sql`
    INSERT INTO agent_presence (email, name, status, updated_at)
    VALUES (${email}, ${name}, ${status}, ${now})
    ON DUPLICATE KEY UPDATE name = VALUES(name), status = VALUES(status), updated_at = VALUES(updated_at)
  `;
  // Only log an actual transition (including an agent's very first report), not every
  // periodic heartbeat re-sending the same status - see agent_presence_log's comment.
  if (prevStatus !== status) {
    // Swallow rather than propagate: the agent_presence upsert above already succeeded, so
    // a problem with this history-only insert (e.g. schema drift) should degrade to "history
    // has a gap," not fail the live status write and 500 every status-change request.
    try {
      await sql`INSERT INTO agent_presence_log (email, name, status, changed_at) VALUES (${email}, ${name}, ${status}, ${now})`;
    } catch (e) {
      console.error('agent_presence_log insert failed (presence itself is recorded):', e.message);
    }
  }

  // TEMPORARY (2026-08-17): also write Postgres agent_presence, which assign_ndr_leads.py
  // was reverted to read from - the live mcaff-cls-assign-ndr-leads Lambda is missing the
  // MYSQL_* env vars this migration's MySQL read path needs (see
  // docs/superpowers/plans/2026-08-17-agent-presence-to-mysql.md's cutover checklist step
  // 5), and NDR assignment cannot wait for that AWS-side fix. Postgres's own write path
  // stopped when this file cut over to MySQL, so without this it would serve a snapshot
  // frozen at cutover time forever - not "no data", but WRONG data. Remove this block (and
  // revert assign_ndr_leads.py back to MySQL) once the Lambda's env vars are fixed - RTO's
  // own read path never used Postgres for this and needs no such revert.
  try {
    await ensurePgSchema();
    const { rows: prevPgRows } = await pgSql`SELECT status FROM agent_presence WHERE email = ${email}`;
    const prevPgStatus = prevPgRows[0]?.status;
    await pgSql`
      INSERT INTO agent_presence (email, name, status, updated_at)
      VALUES (${email}, ${name}, ${status}, ${now})
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
    `;
    if (prevPgStatus !== status) {
      await pgSql`INSERT INTO agent_presence_log (email, name, status, changed_at) VALUES (${email}, ${name}, ${status}, ${now})`;
    }
  } catch (e) {
    console.error('TEMPORARY Postgres agent_presence dual-write failed (MySQL write above already succeeded):', e.message);
  }
}

// Returns every agent's last-reported status, keyed by lowercase email - lets the
// roster table (rto-crm.html) show each agent's real Postgres-backed presence
// instead of the mock/local status it falls back to before anyone's ever reported in.
async function getAllAgentPresence() {
  await ensureSchema();
  const { rows } = await sql`SELECT email, name, status, updated_at FROM agent_presence`;
  const out = {};
  for (const r of rows) out[r.email.toLowerCase()] = { status: r.status, updatedAt: r.updated_at };
  return out;
}

// Per-agent {loggedInMinutes, breakMinutes} derived from agent_presence_log, for the RTO-CRM
// Overview tab's per-agent summary table (see RtoCrmClient.js) - agent_presence itself
// (getAllAgentPresence, above) only ever holds the CURRENT status, not when a session started
// or how long its breaks added up to.
//
// dateFrom/dateTo are the same 'YYYY-MM-DD' strings (or omitted) every other date-ranged
// function in this file takes - resolved via the shared dateBounds() helper (below), so this
// follows the Overview tab's own date-scope filter (Today/Yesterday/7 Days/Custom/All Time)
// exactly the way getCallingOverviewStats etc. already do. `to` defaults to `now` when
// omitted (an open-ended/ongoing range, e.g. Today or All Time); `from` being null means no
// lower bound (All Time) - there's no "before the range" to seed a synthetic snapshot from in
// that case, since the range already starts at the beginning of the log.
//
// Both results are AVERAGES PER ACTIVE DAY when the range spans more than one calendar day -
// not a single-day snapshot repeated, and not a raw sum across the whole range either. "Active
// day" means an IST calendar day with at least one REAL (non-synthetic) presence_log entry
// anywhere in it - a day the agent never touched at all (a day off, or before they ever
// existed in the log) doesn't count toward the denominator, so it can't drag the average down
// for having simply not happened. For a single-day range (Today, Yesterday, a one-day Custom
// range) this reduces to exactly the plain single-day numbers, since there's at most one active
// day to average over.
//
// loggedInMinutes is the average, across every active day that has a real 'Online' entry, of
// that day's FIRST such entry expressed as minutes-since-IST-midnight (istMinutesSinceMidnight)
// - e.g. logging in at 9:00, 10:00 and 11:00 IST on three different days averages to 10:00.
// This is deliberately NOT an average of raw timestamps: two different calendar days' instants
// can't be meaningfully averaged as epoch numbers (the result would land on neither day, at an
// arbitrary point that isn't even a real "time of day"), so each day's login is reduced to its
// time-of-day first, then those are averaged. null if no active day has a real Online entry at
// all - the log has no event to point to, so this reads null rather than guessing.
//
// breakMinutes is (total break time across the WHOLE range, summed exactly as before - every
// interval whose starting status is 'Busy' AND started with a real transition within the
// range) divided by the number of active days - "how many break minutes per day they actually
// worked", not per calendar day in the range (which would understate it whenever the range
// includes a day off). The single-day case is unaffected: dividing by exactly one active day
// changes nothing.
//
// Both figures still walk one per-agent timeline seeded with the single most recent transition
// strictly BEFORE the range starts (so a break/status already running when the range begins is
// picked up from the start of the range, not invisible just because it didn't start within it -
// but this seed entry is NEVER itself counted as an active day, a login, or a break interval,
// for the same overnight-carryover reason documented at the break-sum loop below), then every
// transition logged within the range. An interval still open at the end of the query window is
// closed against the range's own end - `now` for an open-ended range, or the range's explicit
// end for a fully-past one (e.g. Yesterday, or a Custom range that ended before today) - never
// against `now` for a range that's already over, or a still-open break logged last week would
// silently absorb everything up to this instant.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
function istMinutesSinceMidnight(date) {
  return Math.floor((date.getTime() + IST_OFFSET_MS) / 60000) % (24 * 60);
}
function istDayKey(date) {
  return Math.floor((date.getTime() + IST_OFFSET_MS) / 86400000);
}
async function getAgentPresenceLogSummary(dateFrom, dateTo) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const now = new Date();
  // `to` for a range like "Today" is end-of-day (dateBounds' 23:59:59.999) - a point still in
  // the FUTURE relative to `now` while today is still in progress. Capping at `now` is what
  // makes an open-ended/ongoing range close a still-open interval against the actual current
  // instant rather than a timestamp that hasn't happened yet (which would silently credit
  // hours that haven't elapsed). A fully-past range (Yesterday, an earlier Custom range) has
  // `to` already before `now`, so this is a no-op there - `to` wins as intended.
  const rangeEnd = to && to.getTime() < now.getTime() ? to : now;

  // No seed needed when the range is unbounded at the start (All Time) - there's no "before
  // the range" left to carry a status in FROM.
  let priorRows = [];
  if (from) {
    ({ rows: priorRows } = await sql`
      SELECT email, status FROM (
        SELECT email, status,
               ROW_NUMBER() OVER (PARTITION BY email ORDER BY changed_at DESC) AS rn
        FROM agent_presence_log
        WHERE changed_at < ${from}
      ) t WHERE rn = 1
    `);
  }
  const { rows: rangeRows } = await sql`
    SELECT email, status, changed_at
    FROM agent_presence_log
    WHERE (${from} IS NULL OR changed_at >= ${from}) AND changed_at <= ${rangeEnd}
    ORDER BY email ASC, changed_at ASC
  `;

  // `synthetic: true` marks the carried-forward pre-range snapshot - used to know what an
  // agent's status WAS at the start of the range (needed as the starting point for the
  // timeline walk below), but never itself counted as a break interval (see the `i === 0`
  // skip below) and never mistaken for a real "logged in within the range" event (its status
  // is just whatever was true AT the boundary, e.g. carried-over Online, not a fresh sign-in).
  const timelines = new Map(); // email -> [{status, at: Date, synthetic?: bool}]
  if (from) {
    for (const r of priorRows) timelines.set(r.email.toLowerCase(), [{ status: r.status, at: from, synthetic: true }]);
  }
  for (const r of rangeRows) {
    const email = r.email.toLowerCase();
    if (!timelines.has(email)) timelines.set(email, []);
    timelines.get(email).push({ status: r.status, at: r.changed_at });
  }

  const out = {};
  for (const [email, timeline] of timelines) {
    const realEntries = timeline.filter((e) => !e.synthetic);
    // "Active day" = an IST calendar day with at least one REAL entry - the denominator for
    // both averages below. The synthetic seed is never a real entry, so a range that opens
    // mid-status but sees no actual transition until later still counts its active days
    // correctly from the first real entry onward, not from the seed's (possibly much earlier)
    // boundary timestamp.
    const activeDayKeys = new Set(realEntries.map((e) => istDayKey(e.at)));
    const numActiveDays = activeDayKeys.size;

    // loggedInMinutes: average, across days that have a real 'Online' entry, of that day's
    // FIRST such entry's time-of-day (see istMinutesSinceMidnight) - not every active day
    // necessarily has one (a day where the agent was only ever seen 'Busy'/'Offline' in-range
    // doesn't contribute a login time, though it still counts toward numActiveDays above).
    const firstLoginMinutesByDay = new Map(); // dayKey -> earliest minutes-since-midnight that day
    for (const e of realEntries) {
      if (e.status !== 'Online') continue;
      const dayKey = istDayKey(e.at);
      const mins = istMinutesSinceMidnight(e.at);
      if (!firstLoginMinutesByDay.has(dayKey) || mins < firstLoginMinutesByDay.get(dayKey)) {
        firstLoginMinutesByDay.set(dayKey, mins);
      }
    }
    const loginMinutesList = [...firstLoginMinutesByDay.values()];
    const loggedInMinutes = loginMinutesList.length
      ? Math.round(loginMinutesList.reduce((s, m) => s + m, 0) / loginMinutesList.length)
      : null;

    let breakMs = 0;
    let busyMs = 0;
    for (let i = 0; i < timeline.length; i++) {
      const status = timeline[i].status;
      if (status !== 'Busy' && status !== 'OnCall') continue;
      // The synthetic pre-range snapshot only says what an agent's LAST reported status was,
      // possibly long before the range started - not that they were continuously, actively on
      // break the whole time since. agent_presence_log only records a real transition (see
      // upsertAgentPresence's comment - a repeated heartbeat is never logged), so a 'Busy'
      // status sitting unchanged since before the range is far more often someone who simply
      // closed their laptop than someone on a break spanning the whole gap. Counting it
      // produced exactly this bug (fixed here for good): an agent whose last known status
      // before the range happened to be Busy got the ENTIRE gap added to the range's break
      // time, well before they'd even logged in. Only an interval that STARTS with a real
      // transition logged WITHIN the range counts - the carried-over status is used solely to
      // seed the timeline (so a later transition away from it still resolves correctly),
      // never as a break/busy interval of its own. Same rule applies to 'OnCall' (the "Busy"
      // status the UI shows today - see CALLING_STATUSES' comment for why it isn't also
      // called 'Busy' internally), just accumulated separately from break time.
      if (i === 0 && timeline[i].synthetic) continue;
      const end = i + 1 < timeline.length ? timeline[i + 1].at : rangeEnd;
      const durationMs = Math.max(0, end.getTime() - timeline[i].at.getTime());
      if (status === 'Busy') breakMs += durationMs; else busyMs += durationMs;
    }
    out[email] = {
      loggedInMinutes,
      breakMinutes: numActiveDays > 0 ? Math.round((breakMs / 60000) / numActiveDays) : 0,
      busyMinutes: numActiveDays > 0 ? Math.round((busyMs / 60000) / numActiveDays) : 0,
    };
  }
  return out;
}

// Returns { orderId: assignedAtIso } for assignments newer than sinceHours - the
// reset button only needs "was this assigned recently", so callers keep the payload
// small by asking for a window just past their own grace period, not the whole table.
async function getRecentLeadAssignments(sinceHours) {
  await ensureSchema();
  const since = new Date(Date.now() - sinceHours * 3600 * 1000);
  const { rows } = await sql`
    SELECT order_id, assigned_at FROM CLS_RTO_calling
    WHERE reassigned_away_at IS NULL AND assigned_at >= ${since}
  `;
  const out = {};
  for (const r of rows) out[r.order_id] = r.assigned_at;
  return out;
}

// Shared with scripts/lead_priority.py's prefix_rule_partner and the RTO CRM - these used to
// be a hand-maintained copy of that script's own list. Single source is now
// ./leadAssignmentRules.json (which lives under api/_lib/ precisely so deploy.yml's
// `cp -r api/.` puts it in the Lambda bundle; see that file's own notes).
const { awbPrefixRules: AWB_PREFIX_RULES } = require('./leadAssignmentRules.json');
function resolvePartnerFromAwb(awbCode) {
  const awb = (awbCode || '').trim();
  if (!awb) return null;
  const match = AWB_PREFIX_RULES.find(([prefix]) => awb.startsWith(prefix));
  return match ? match[1] : null;
}

// Upserts the disposal side of a lead's lifecycle onto its LIVE cycle - the row whose
// reassigned_away_at IS NULL. Note it updates whichever row is live for this order_id, not
// specifically the calling agent's - a disposal arriving from an agent the lead has ALREADY
// been reassigned away from writes onto the new agent's cycle. That is pre-existing behavior
// and is left alone deliberately: conditioning the update on the stored email matching the
// caller's would let any drift between the sheet's Column Q and the session email - case,
// whitespace, an alias address - silently discard legitimate disposals, far worse than the
// narrow case it guards. Reaching it needs a stale tab: once reassigned, the sheet no longer
// lists the lead under the old agent.
//
// If assign_leads.py never recorded this order_id (assigned before this table tracked
// cycles, or assigned manually straight in the sheet), the plain-INSERT path below creates
// the row now with the disposing agent's own email as assigned_at's best-available
// attribution, rather than dropping the disposal details on the floor.
//
// awbCode/delivery_partner use COALESCE on the UPDATE fallback rather than overwriting, so a
// disposal call without an AWB (e.g. an older cached client) never clobbers what
// assign_leads.py already stamped for this order_id. rto_reason/delivery_partner can end up
// NULL from the original assignment (sheet's RTO Reason cell was still blank then, or the
// AWB's prefix wasn't in AWB_PREFIX_RULES yet) - the client always has the sheet's current
// values by the time an agent disposes (RtoCrmClient.js's dispTkt.rtoReason/awbCode), so this
// is a second chance to fill them in, but only the gaps: rto_reason prefers whatever's
// already stored since it shouldn't legitimately change once set, while delivery_partner
// keeps its "recompute every time" behavior since resolvePartnerFromAwb is deterministic
// from the AWB alone.
//
// MySQL's INSERT ... ON DUPLICATE KEY UPDATE cannot target one specific unique key the way
// Postgres's `ON CONFLICT (order_id) WHERE ...` could - it fires on ANY unique key collision
// on CLS_RTO_calling, which has two (live_order_id_key AND live_awb_code_key - see
// scripts/migrate_cls_rto_calling_schema.py). An upsert here could land on an AWB collision -
// two different leads' rows sharing one live AWB, a genuine data error - and silently splice
// this disposition onto the OTHER lead's row instead of raising. So the insert is plain, and
// a collision is inspected: on live_order_id_key (this order_id already has a live row - the
// normal case, since assign_leads.py creates it first) it falls back to an UPDATE, same net
// effect as the old upsert; any other key is left to raise, exactly as Postgres's partial
// index would have.
//
// A live_order_id_key collision splits further on whether that live row is ALREADY disposed.
// The CRM's "All Leads" tab lets an agent search up and reopen any already-disposed lead (see
// RtoCrmClient.js's openDisp - it has no guard against a disposed ticket), and submitting a
// new disposition there used to UPDATE that same row in place: silently overwriting the
// original disposition/timestamps and never touching agent_email, so the row would show
// today's outcome but the agent who actually just worked it goes unrecorded (or worse, the
// row's assigned_at stays whenever it was FIRST assigned, days earlier - inflating FRT/handle-
// time metrics that read assigned_at/disposed_at as one continuous gap, e.g. the 40+ hour
// gaps traced on 2026-08-20 for leads re-touched days after their real first assignment).
// Not disposed yet is still the normal one-cycle case and keeps the plain UPDATE. Already
// disposed is treated exactly like a reassignment (record_lead_assignments' own retire-then-
// insert, same two-step transaction so a lead is never left with zero live rows): the old row
// is retired via reassigned_away_at, untouched otherwise, and a FRESH row captures this
// re-dispose with its own assigned_at/disposed_at = now and the actual disposing agent.
async function recordLeadDisposition(orderId, email, awbCode, details) {
  await ensureSchema();
  const { disposition, agentRemarks, connected, attempt, refundAmount, newOrderId, rtoReason, paymentMode } = details || {};
  const deliveryPartner = resolvePartnerFromAwb(awbCode);
  const now = new Date();
  try {
    await sql`
      INSERT INTO CLS_RTO_calling (order_id, agent_email, assigned_at, disposed_at, disposition, agent_remarks, connected, attempt, refund_amount, awb_code, new_order_id, rto_reason, payment_mode, delivery_partner)
      VALUES (${orderId}, ${email}, ${now}, ${now}, ${disposition || null}, ${agentRemarks || null}, ${connected || null}, ${attempt || null}, ${refundAmount || null}, ${awbCode || null}, ${newOrderId || null}, ${rtoReason || null}, ${paymentMode || null}, ${deliveryPartner})
    `;
  } catch (e) {
    if (!/live_order_id_key/.test((e && e.message) || '')) throw e;
    const { rows: liveRows } = await sql`
      SELECT disposed_at FROM CLS_RTO_calling WHERE order_id = ${orderId} AND reassigned_away_at IS NULL
    `;
    const alreadyDisposed = liveRows.length > 0 && liveRows[0].disposed_at != null;
    if (alreadyDisposed) {
      const p = await getPool();
      const conn = await p.getConnection();
      try {
        await conn.beginTransaction();
        // Matches on order_id alone (not disposed_at, which could itself have moved between
        // the SELECT above and here) - same benign-race tolerance as claimRtoLead: whichever
        // re-dispose lands first retires the row, and this UPDATE affecting 0 rows a moment
        // later on a genuine race just means the OTHER submission already did it.
        await conn.execute(
          'UPDATE CLS_RTO_calling SET reassigned_away_at = ? WHERE order_id = ? AND reassigned_away_at IS NULL',
          [now, orderId],
        );
        await conn.execute(
          `INSERT INTO CLS_RTO_calling
             (order_id, agent_email, assigned_at, disposed_at, disposition, agent_remarks, connected, attempt, refund_amount, awb_code, new_order_id, rto_reason, payment_mode, delivery_partner)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [orderId, email, now, now, disposition || null, agentRemarks || null, connected || null, attempt || null,
           refundAmount || null, awbCode || null, newOrderId || null, rtoReason || null, paymentMode || null, deliveryPartner],
        );
        await conn.commit();
      } catch (txErr) {
        await conn.rollback();
        throw txErr;
      } finally {
        conn.release();
      }
    } else {
      await sql`
        UPDATE CLS_RTO_calling SET
          disposed_at = ${now},
          disposition = ${disposition || null},
          agent_remarks = ${agentRemarks || null},
          connected = ${connected || null},
          attempt = ${attempt || null},
          refund_amount = ${refundAmount || null},
          awb_code = COALESCE(${awbCode || null}, awb_code),
          new_order_id = COALESCE(${newOrderId || null}, new_order_id),
          rto_reason = COALESCE(rto_reason, ${rtoReason || null}),
          payment_mode = COALESCE(payment_mode, ${paymentMode || null}),
          delivery_partner = COALESCE(${deliveryPartner}, delivery_partner)
        WHERE order_id = ${orderId} AND reassigned_away_at IS NULL
      `;
    }
  }
  invalidateCache('calling:leadDates');
}

// Records the ASSIGNMENT half of a manual RTO claim - the RTO twin of claimNdrLead below, and
// the same row scripts/assign_leads.py's record_lead_assignments writes when the robot assigns.
//
// Until this existed, an agent's own "Claim" button wrote Column Q and nothing else, so a
// self-claimed lead had no live row at all. recordLeadDisposition above then INSERTed one only
// when the lead was finally disposed - stamping assigned_at = disposed_at = that moment, i.e.
// recording the lead as assigned the very second it was worked. Called by api/rto/claim.js.
//
// Same collision handling as record_lead_assignments: a live_order_id_key hit means this lead
// already has a live cycle (someone else claimed it first, or a double-click), which is a
// benign no-op rather than an error - the caller has already confirmed Column Q was free, so
// losing that race just means the other claim won. Any OTHER unique key (live_awb_code_key -
// two leads sharing one live AWB, a genuine data error) is left to raise, exactly as the cron
// leaves it.
async function claimRtoLead(orderId, email, awbCode, rtoReason, paymentMode) {
  await ensureSchema();
  const deliveryPartner = resolvePartnerFromAwb(awbCode);
  try {
    await sql`
      INSERT INTO CLS_RTO_calling (order_id, agent_email, assigned_at, awb_code, rto_reason, payment_mode, delivery_partner)
      VALUES (${orderId}, ${email}, ${new Date()}, ${awbCode || null}, ${rtoReason || null}, ${paymentMode || null}, ${deliveryPartner})
    `;
  } catch (e) {
    if (!/live_order_id_key/.test((e && e.message) || '')) throw e;
    return { recorded: false };
  }
  invalidateCache('calling:leadDates');
  return { recorded: true };
}

// This agent's admin-set RTO quota, or null when they have no calling_agent_process row or an
// explicit NULL - "unset", which the caller resolves to the process default via
// leadQuota.resolveAgentQuota. Never coerce a missing value to 0 here: that would read as "may
// hold no leads at all" rather than "no override set".
//
// Only the quota lives here. The matching LOAD is deliberately NOT counted from
// CLS_RTO_calling - see api/rto/claim.js's getLoadByAgent for the measurement showing why that
// table cannot answer it yet.
async function getRtoAgentQuota(email) {
  try {
    await ensurePgSchema();
    const { rows } = await pgSql`
      SELECT max_quota FROM calling_agent_process
      WHERE process_key = 'rto' AND LOWER(email) = LOWER(${email})
    `;
    return rows.length && rows[0].max_quota != null ? rows[0].max_quota : null;
  } catch (e) {
    // Same fail-open contract scripts/assign_leads.py uses for this table: an unreachable
    // calling_agent_process means "no per-process override", so the caller falls back to the
    // process default - a config lookup must never block a legitimate claim.
    console.error('getRtoAgentQuota: calling_agent_process unavailable, using default quota:', e.message);
    return null;
  }
}

// Deliberately its OWN function rather than widening getRtoAgentQuota's return shape to add
// `status`: that function has one existing caller (api/rto/claim.js) for a manual, explicit
// claim, where being Busy/OnCall has never blocked the action - an agent about to go on a call
// may still want to grab one on purpose. This one exists only for api/rto/next-lead.js's
// AUTOMATIC top-up, which is exactly what going Busy/OnCall is supposed to pause. Sharing one
// function would couple two call sites whose eligibility rules are meant to differ, so a future
// change to either could silently change the other's behaviour.
//
// A missing row means Offline, NOT "no restriction" - matches the existing
// "no row -> Offline, null quota means unset -> default" convention already used throughout
// this codebase for calling_agent_process (see effectiveAgentRoster's own comment in
// RtoCrmClient.js). The one case that DOES mean "no restriction" - the whole PROCESS having no
// per-process rows at all, so scripts/assign_leads.py falls back to global presence only - is a
// system-wide state, not a per-agent one; RTO has had per-process rows configured for a long
// time, so that fallback does not apply here and replicating it would be dead code.
async function getRtoAgentAvailability(email) {
  try {
    await ensurePgSchema();
    const { rows } = await pgSql`
      SELECT status FROM calling_agent_process
      WHERE process_key = 'rto' AND LOWER(email) = LOWER(${email})
    `;
    return rows.length ? rows[0].status : 'Offline';
  } catch (e) {
    // Unlike quota, this must NOT fail open to "assume eligible" - that would silently ignore
    // an agent's own Busy/OnCall choice, the exact bug this function exists to prevent. The
    // caller (next-lead.js) treats null as "cannot verify -> do not assign", the same
    // conservative direction scripts/assign_leads.py takes when its own online-agents query
    // errors (fails to an EMPTY eligible set, not to "everyone is eligible").
    console.error('getRtoAgentAvailability: calling_agent_process unavailable:', e.message);
    return null;
  }
}

// { id } for a freshly-created RTO CSV upload job. status starts 'queued' - the worker Lambda
// (mcaff-cls-csv-upload-worker) hasn't necessarily started yet by the time this returns, since
// it's invoked fire-and-forget right after this insert (see api/rto/upload-start.js).
async function createRtoCsvUploadJob({ createdBy, totalRows, prepaidCount, rowsPending }) {
  await ensurePgSchema();
  const { rows } = await pgSql`
    INSERT INTO rto_csv_upload_jobs (created_by, total_rows, prepaid_count, rows_pending)
    VALUES (${createdBy}, ${totalRows}, ${prepaidCount}, ${JSON.stringify(rowsPending)})
    RETURNING id
  `;
  return rows[0].id;
}

// The full job row, or null if `id` doesn't exist - api/rto/upload-status.js's whole job.
async function getRtoCsvUploadJob(id) {
  await ensurePgSchema();
  const { rows } = await pgSql`SELECT * FROM rto_csv_upload_jobs WHERE id = ${id}`;
  return rows[0] || null;
}

// Partial update - `fields` keys must be a subset of the table's own columns. Used by the
// Python worker's own Postgres connection too (via a plain UPDATE, not this function directly -
// Node and Python each use their native DB client) but this is the ONLY way the Node side
// (api/rto/upload-start.js, for the non-prepaid immediate-append counts) writes to this table,
// so both sides stay consistent about which columns exist.
async function updateRtoCsvUploadJob(id, fields) {
  await ensurePgSchema();
  const allowed = new Set([
    'status', 'checked_count', 'already_refunded_count', 'already_punched_count',
    'appended_count', 'duplicate_in_sheet_count', 'duplicate_in_file_count',
    'missing_awb_count', 'rows_pending', 'errors', 'error_message',
  ]);
  const keys = Object.keys(fields).filter((k) => allowed.has(k));
  if (!keys.length) return;
  // pgSql is a tagged template (see its own definition earlier in this file), so the SET
  // clause has to be built with real interpolation, not a loop of separate awaited queries -
  // one UPDATE per call, whatever fields are given.
  for (const key of keys) {
    const value = key === 'rows_pending' || key === 'errors'
      ? JSON.stringify(fields[key])
      : fields[key];
    if (key === 'status') await pgSql`UPDATE rto_csv_upload_jobs SET status = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'checked_count') await pgSql`UPDATE rto_csv_upload_jobs SET checked_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'already_refunded_count') await pgSql`UPDATE rto_csv_upload_jobs SET already_refunded_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'already_punched_count') await pgSql`UPDATE rto_csv_upload_jobs SET already_punched_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'appended_count') await pgSql`UPDATE rto_csv_upload_jobs SET appended_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'duplicate_in_sheet_count') await pgSql`UPDATE rto_csv_upload_jobs SET duplicate_in_sheet_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'duplicate_in_file_count') await pgSql`UPDATE rto_csv_upload_jobs SET duplicate_in_file_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'missing_awb_count') await pgSql`UPDATE rto_csv_upload_jobs SET missing_awb_count = ${value}, updated_at = now() WHERE id = ${id}`;
    else if (key === 'rows_pending') await pgSql`UPDATE rto_csv_upload_jobs SET rows_pending = ${value}::jsonb, updated_at = now() WHERE id = ${id}`;
    else if (key === 'errors') await pgSql`UPDATE rto_csv_upload_jobs SET errors = ${value}::jsonb, updated_at = now() WHERE id = ${id}`;
    else if (key === 'error_message') await pgSql`UPDATE rto_csv_upload_jobs SET error_message = ${value}, updated_at = now() WHERE id = ${id}`;
  }
}

// { id } for a freshly-created Order Punch job - job row + every submitted row inserted in ONE
// transaction, so a crash between the two inserts can never leave a job with zero rows (which
// the worker would otherwise treat as instantly "done"). rows is [{doc, reason,
// facility_code}], already validated by the caller (see api/_lib/orderPunchRows.js) -
// row_index is assigned here as submission order.
async function createOrderPunchJob({ createdBy, rows }) {
  await ensurePgSchema();
  return withPgTransaction(async (client) => {
    const { rows: jobRows } = await client.query(
      'INSERT INTO order_punch_jobs (created_by, total_rows) VALUES ($1, $2) RETURNING id',
      [createdBy, rows.length],
    );
    const jobId = jobRows[0].id;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await client.query(
        `INSERT INTO order_punch_job_rows (job_id, row_index, display_order_code, reason, facility_code)
         VALUES ($1, $2, $3, $4, $5)`,
        [jobId, i, r.doc, r.reason || null, r.facility_code || null],
      );
    }
    return jobId;
  });
}

// The full job row, including the Python worker's own progress counters, or null if `id`
// doesn't exist.
async function getOrderPunchJob(id) {
  await ensurePgSchema();
  const { rows } = await pgSql`SELECT * FROM order_punch_jobs WHERE id = ${id}`;
  return rows[0] || null;
}

// Marks a job dead on arrival, for the one case Node can detect by itself: the worker Lambda
// invoke was never accepted, so no worker will ever pick this job up. Without this the row sits
// at 'queued' forever and the polling UI can only show a job that looks healthy but is not (the
// 2026-08-21 incident - see triggerLambda's own comment). Every other failure mode is the
// worker's own to record, since only it knows how far it got.
async function failOrderPunchJob(id, message) {
  await ensurePgSchema();
  await pgSql`
    UPDATE order_punch_jobs SET status = 'failed', error_message = ${message}, updated_at = now()
    WHERE id = ${id}
  `;
}

// Sets the flag the Python worker checks between rows/chunks - see api/order-punch/stop.js.
async function setOrderPunchJobStopRequested(id) {
  await ensurePgSchema();
  await pgSql`UPDATE order_punch_jobs SET stop_requested = true, updated_at = now() WHERE id = ${id}`;
}

// Every row for a job, in submission order - api/order-punch/results.js's CSV source.
async function getOrderPunchJobRowsForExport(id) {
  await ensurePgSchema();
  const { rows } = await pgSql`
    SELECT display_order_code, reason, facility_code, status, so_code, target_channel, error_message
    FROM order_punch_job_rows WHERE job_id = ${id} ORDER BY row_index
  `;
  return rows;
}

// Same constants the Apps Script hardcoded, used as a fallback merge in case a key is somehow
// missing from the table (the schema bootstrap above seeds these as real rows on first boot,
// so this is belt-and-suspenders, not the only source of truth).
const ORDER_PUNCH_SETTINGS_DEFAULTS = {
  facility_codes: ['HYP_SRKOL', 'HYP_SRBGLR', 'mCaff_Mumbai2', 'mCaff_Gurgaon3', 'HYP_AHMD',
    'HYP_SRLOK2', 'HYP_SRGWHT', 'Omnivio_Noida1', 'HYP_DLNAG'],
  mcaffeine_channels: ['SHOPIFY', 'FIEN_SHOPIFY', 'HYPD', 'COMPENSATION', 'MCaf_Shopify.in', 'MCAFF_TEST'],
  hyphen_channels: ['HYP_SHOPIFY', 'HYPD_HYPHEN', 'HYP_COMPENSATION', 'HYP_SHOPIFY_IN'],
  target_mcaffeine: 'MCAFFEINE_D2C',
  target_hyphen: 'HYPHEN_D2C',
  cooldown_days: 3,
  max_suffix: 2,
};

// { [key]: value } - api/order-punch/settings.js's GET, and the admin settings panel's source.
async function getOrderPunchSettings() {
  await ensurePgSchema();
  const { rows } = await pgSql`SELECT key, value FROM order_punch_settings`;
  const settings = { ...ORDER_PUNCH_SETTINGS_DEFAULTS };
  rows.forEach((r) => { settings[r.key] = r.value; });
  return settings;
}

async function upsertOrderPunchSetting(key, value, updatedBy) {
  await ensurePgSchema();
  const json = JSON.stringify(value);
  await pgSql`
    INSERT INTO order_punch_settings (key, value, updated_by) VALUES (${key}, ${json}::jsonb, ${updatedBy})
    ON CONFLICT (key) DO UPDATE SET value = ${json}::jsonb, updated_at = now(), updated_by = ${updatedBy}
  `;
}

// {status, updatedAt} for one agent's global (cross-process) presence row, or null if they have
// never reported in. Used by api/rto/next-lead.js alongside getRtoAgentAvailability above - both
// halves scripts/assign_leads.py's own fetch_online_agents requires (per-process Online AND a
// heartbeat-fresh global presence), and this endpoint is the one automatic-assignment path that
// was missing that check entirely.
async function getAgentPresenceRow(email) {
  await ensureSchema();
  const { rows } = await sql`SELECT status, updated_at FROM agent_presence WHERE email = ${email}`;
  return rows.length ? { status: rows[0].status, updatedAt: rows[0].updated_at } : null;
}

// NDR's own equivalent of the assignment half of record_lead_assignments (scripts/
// assign_leads.py) - a fresh live cycle for this awb. ON CONFLICT targets the partial unique
// index (ndr_lead_assignments_awb_current_key), so a re-claim of an already-live row (a race,
// or the UI's own auto-claim firing twice) is a safe no-op rather than an error - the sheet's
// own Q/R write already decided who holds the lead; this just mirrors that into Postgres.
async function claimNdrLead(awbNumber, email) {
  await ensurePgSchema();
  await pgSql`
    INSERT INTO ndr_lead_assignments (awb_number, email)
    VALUES (${awbNumber}, ${email})
    ON CONFLICT (awb_number) WHERE reassigned_away_at IS NULL DO NOTHING
  `;
  invalidateCache('calling:ndrLeadDates');
}

// NDR's own equivalent of the disposal half of recordLeadDisposition above - updates the
// SAME live row claimNdrLead created, never inserts one: a disposition is only ever recorded
// for a lead that's already been claimed (see the Call modal's claim-then-dispose sequence),
// so there's nothing to upsert here unlike RTO's version (which also has to handle a
// self-claimed lead with no prior assignment row).
async function disposeNdrLead(awbNumber, disposition, agentRemarks) {
  await ensurePgSchema();
  await pgSql`
    UPDATE ndr_lead_assignments
    SET disposed_at = now(), disposition = ${disposition || null}, agent_remarks = ${agentRemarks || null}
    WHERE awb_number = ${awbNumber} AND reassigned_away_at IS NULL
  `;
  invalidateCache('calling:ndrLeadDates');
}

// Delivery-Escalation's own durable record on MySQL (see
// scripts/create_delivery_escalation_table.py) - the same role CLS_RTO_calling plays for RTO,
// but written only once a ticket reaches a TERMINAL outcome (Delivered or RTO - see
// DeliveryEscalationClient.js's TERMINAL_OUTCOMES), not on every dispose: a non-terminal
// outcome like Escalated stays sheet-only, still live in the Fresh tab, until it's later
// re-disposed as one of the two terminal ones. No claim-time write either - this process has
// no round-robin robot and no per-cycle/reassignment shape, so there's nothing to record until
// the ticket is actually done. One row per (brand, awb_code); upserts rather than requiring a
// prior row to exist, since a ticket can go straight from unclaimed to a terminal dispose in
// one action (claim-on-open, then Resolve).
async function disposeDeliveryEscalationTicket(ticket, email, outcome, agentRemarks) {
  const { brand, orderId, awbCode, deliveryPartner, queryClass, queryCategory, whName, statusAsPerAwb, tat } = ticket;
  const now = new Date();
  await sql`
    INSERT INTO Delivery_escalation
      (brand, order_id, awb_code, delivery_partner, query_class, query_category, wh_name,
       status_as_per_awb, tat, agent_email, assigned_at, outcome, agent_remarks, disposed_at)
    VALUES (
      ${brand}, ${orderId}, ${awbCode || null}, ${deliveryPartner || null}, ${queryClass || null},
      ${queryCategory || null}, ${whName || null}, ${statusAsPerAwb || null}, ${tat || null},
      ${email || null}, ${now}, ${outcome || null}, ${agentRemarks || null}, ${now}
    )
    ON DUPLICATE KEY UPDATE
      order_id = VALUES(order_id),
      delivery_partner = VALUES(delivery_partner),
      query_class = VALUES(query_class),
      query_category = VALUES(query_category),
      wh_name = VALUES(wh_name),
      status_as_per_awb = VALUES(status_as_per_awb),
      tat = VALUES(tat),
      agent_email = IF(agent_email IS NULL OR agent_email = '', VALUES(agent_email), agent_email),
      assigned_at = IF(agent_email IS NULL OR agent_email = '', VALUES(assigned_at), assigned_at),
      outcome = VALUES(outcome),
      agent_remarks = VALUES(agent_remarks),
      disposed_at = VALUES(disposed_at)
  `;
}

// ---------------------------------------------------------------------------------------
// Delivery-Escalation reads (Fresh + Resolved tabs, api/delivery-escalation/record.js)
//
// Everything below pages, filters and scopes SERVER-side. The previous shape - fetch every
// row, filter and paginate in the browser - broke on Lambda's 6MB synchronous response cap:
// 24000 rows measured 7.64MB and died as an opaque 500 with API Gateway's own generic body,
// no app-level error to debug from. Paging means the response is now one screen of rows
// (<=200) regardless of how large this table grows, so that ceiling can't be reached again.
//
// Visibility is NOT per-agent here, unlike every other calling process: Delivery-Escalation is
// one shared desk with no assignment robot, so agents self-claim from the same unassigned pool.
// An earlier version pinned a non-admin to `agent_email = <their email>`, which made every
// unclaimed ticket invisible to exactly the people meant to claim it - a freshly-invited agent
// saw an empty page and zeroed tiles, with no way to ever claim a first ticket. Anyone holding
// the report_tab_permissions row for this process sees the whole desk; agent_email is who
// claimed/resolved a row, not who may read it. Paging (below) is what keeps the response inside
// Lambda's 6MB cap - that part never depended on the scoping.
const DELIVERY_ESCALATION_MAX_PER_PAGE = 200;
// Cap on a CSV export (one response, so still bound by the same 6MB ceiling - at ~300 bytes
// a row this is ~1.5MB).
const DELIVERY_ESCALATION_MAX_EXPORT = 5000;

// A ticket is Forced RTO whenever its TAT bucket (tat, the sheet-fed string - see
// DE_SELECT_COLUMNS/DE_TAT_BUCKET_SQL below for the OTHER, computed tat_bucket, a different
// field) reads "Forced to be marked as RTO" - the logistics pipeline's own flag for an RTO it
// forced rather than one worked normally. Split into its own tab/view so those don't sit mixed
// into Fresh's ordinary RTO rows.
// Two independent signals, unioned: the logistics/courier pipeline's own flag (tat, mirrored in
// from the sheet - see scripts/backfill_delivery_escalation_from_sheet.py) OR an agent disposing
// the ticket as RTO through the app (outcome). They usually agree (12,388 of 12,389 agent-RTO
// dispositions already carry tat='Forced to be marked as RTO', backfilled from the same sheet
// snapshot), but an agent's dispose is immediate while tat is only as fresh as the last backfill
// run - the OR means a just-disposed RTO lands here right away instead of waiting for the next
// logistics snapshot to catch up.
//
// `outcome IS NOT NULL AND` guards the two outcome comparisons deliberately: most rows have
// outcome NULL (never disposed), and `NULL = 'RTO'` evaluates to NULL, not FALSE, in SQL's
// three-valued logic - every consumer of this constant wraps it in NOT(...) (see DE_FRESH_WHERE
// below), and NOT(NULL) is ALSO NULL, which a WHERE clause treats as non-matching. Without the
// guard, that NULL poisoned the whole NOT() for every blank-outcome row and wrongly excluded
// all of Fresh's ordinary (never-disposed) tickets, not just the RTO ones this was meant to
// catch - caught live: stats.fresh dropped from ~3645 to 2 before this guard was added.
const DE_FORCED_RTO_WHERE = `(tat = 'Forced to be marked as RTO' OR (outcome IS NOT NULL AND (outcome = 'RTO' OR outcome LIKE 'RTO > %')))`;

// A ticket is Fresh while its outcome is blank (never disposed), RTO (an RTO'd order can still
// be re-shipped and later delivered, so it isn't terminal), or Escalated (still waiting on the
// delivery partner) - EXCLUDING Forced RTO, which moved to its own view (DE_FORCED_RTO_WHERE)
// instead of sitting inside Fresh's ordinary RTO rows. Resolved is Delivered ONLY. Matched on
// the top-level outcome label, so a nested "Delivered > <sub-reason>" still counts.
const DE_FRESH_WHERE = `((outcome IS NULL OR outcome = ''
   OR outcome = 'RTO' OR outcome LIKE 'RTO > %'
   OR outcome = 'Escalated' OR outcome LIKE 'Escalated > %')
   AND NOT (${DE_FORCED_RTO_WHERE}))`;
const DE_RESOLVED_WHERE = `(outcome = 'Delivered' OR outcome LIKE 'Delivered > %')`;
const DE_VIEW_WHERE = { fresh: DE_FRESH_WHERE, resolved: DE_RESOLVED_WHERE, forced_rto: DE_FORCED_RTO_WHERE };

// Days-to-deliver (disposed_at, when the agent actually marked it Delivered, minus added_date)
// bucketed into the same 6 names the sheet's own column P formula uses for ITS metric - that
// one is "logistics-fed Delivered Date minus Query Date", this one is the agent's own dispose
// date against added_date, so it's a distinct figure, not a duplicate. 'unresolved' covers
// "can't compute" (added_date missing on some pre-backfill rows) as well as "not yet delivered".
const DE_TAT_BUCKET_SQL = `CASE
    WHEN disposed_at IS NULL OR added_date IS NULL THEN 'unresolved'
    WHEN DATEDIFF(disposed_at, added_date) <= 2 THEN 'Within 48 hrs'
    WHEN DATEDIFF(disposed_at, added_date) <= 4 THEN 'Within 2-4 days'
    WHEN DATEDIFF(disposed_at, added_date) <= 8 THEN '4-8 days'
    WHEN DATEDIFF(disposed_at, added_date) <= 10 THEN '8-10 days'
    ELSE 'Greater than 10 days'
  END`;

// For the Overview's day-wise table (getDeliveryEscalationDaywiseStats). 'unresolved' is
// exactly the Fresh tab's own population (DE_FRESH_WHERE: outcome blank/RTO/Escalated, minus
// Forced RTO, which is its own bucket below) - a ticket sitting in Fresh sits in 'unresolved'
// here too, whole and un-split, rather than being sliced into the age buckets by how long it's
// been open. Everything that reaches the DATEDIFF buckets below is therefore Delivered (the
// only outcome left once Forced RTO and Fresh are both accounted for), so those buckets now
// measure actual resolution time (disposed_at minus added_date) - the same figure
// DE_TAT_BUCKET_SQL already reports per-row for Resolved, just grouped by day here. The
// disposed_at/added_date IS NULL branch is a defensive catch-all for a Delivered row somehow
// missing one of those dates (2 rows total right now, see getDeliveryEscalationDaywiseStats'
// own missingDateCount) - it can't be dated, so it can't be aged either.
const DE_DAYWISE_BUCKET_SQL = `CASE
    WHEN ${DE_FORCED_RTO_WHERE} THEN 'Forced to be marked as RTO'
    WHEN ${DE_FRESH_WHERE} THEN 'unresolved'
    WHEN disposed_at IS NULL OR added_date IS NULL THEN 'unresolved'
    WHEN DATEDIFF(disposed_at, added_date) <= 2 THEN 'Within 48 hrs'
    WHEN DATEDIFF(disposed_at, added_date) <= 4 THEN 'Within 2-4 days'
    WHEN DATEDIFF(disposed_at, added_date) <= 8 THEN '4-8 days'
    WHEN DATEDIFF(disposed_at, added_date) <= 10 THEN '8-10 days'
    ELSE 'Greater than 10 days'
  END`;
// Fixed column set for that table, in ascending-severity display order (not alphabetical) -
// known in advance so a date with a bucket at zero still renders a 0 cell instead of the
// column vanishing for that row.
const DE_DAYWISE_BUCKETS = [
  'Within 48 hrs', 'Within 2-4 days', '4-8 days', '8-10 days', 'Greater than 10 days',
  'Forced to be marked as RTO', 'unresolved',
];

// agent_remarks is unbounded TEXT; the UI truncates its display anyway, so it's cut here too -
// otherwise one pathological remark could bloat a page response on its own.
// child_disposition is a generated column derived from outcome (see
// scripts/alter_delivery_escalation_add_child_disposition.py) - the sub-level of the
// disposition tree, split out so it can be read/grouped without substringing outcome.
const DE_SELECT_COLUMNS = `id, brand, order_id, awb_code, delivery_partner, query_class,
    query_category, wh_name, status_as_per_awb, tat, ticket_number, agent_email, outcome,
    child_disposition, LEFT(agent_remarks, 300) AS agent_remarks, disposed_at, added_date,
    contact_count, first_added_date,
    ${DE_TAT_BUCKET_SQL} AS tat_bucket`;

// Every user-supplied value here becomes a bound parameter - none is ever concatenated into
// the SQL text. `agent` is the optional Agent-filter dropdown, a user's own choice of view -
// there is no forced per-agent scope (see the header comment above).
function deFilterSql({ search, brand, agent } = {}) {
  const clauses = [];
  const params = [];
  if (brand) { clauses.push('brand = ?'); params.push(brand); }
  if (agent) { clauses.push('LOWER(agent_email) = ?'); params.push(String(agent).toLowerCase()); }
  if (search) {
    // Escape LIKE's own wildcards so a literal % or _ in an AWB/order id searches as itself
    // rather than as a pattern.
    const q = `%${String(search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    clauses.push('(awb_code LIKE ? OR order_id LIKE ? OR ticket_number LIKE ?)');
    params.push(q, q, q);
  }
  return { clauses, params };
}

function deWhere(view, opts) {
  const base = DE_VIEW_WHERE[view];
  if (!base) throw new Error(`Unknown Delivery-Escalation view: ${view}`);
  const { clauses, params } = deFilterSql(opts);
  return { where: [base, ...clauses].join(' AND '), params };
}

// page/perPage are the ONLY values inlined into SQL text rather than bound - mysql2's execute()
// rejects `LIMIT ?` outright ("Incorrect arguments to mysqld_stmt_execute", verified against
// this server, MySQL 8.0.45). Both are coerced to integers and clamped here, so nothing
// caller-supplied can survive into the statement.
function dePaging(opts = {}) {
  const perPage = Math.min(Math.max(parseInt(opts.perPage, 10) || 50, 1), DELIVERY_ESCALATION_MAX_PER_PAGE);
  const page = Math.max(parseInt(opts.page, 10) || 1, 1);
  return { page, perPage, offset: (page - 1) * perPage };
}

// Resolved reads newest-disposed first; Fresh has no meaningful disposed_at yet, so it reads
// newest-row first. id breaks ties so paging can't repeat or skip a row between pages.
function deOrderBy(view) {
  return view === 'resolved' ? 'disposed_at DESC, id DESC' : 'id DESC';
}

// One page of a tab, plus the total matching that same filter - the client needs the total to
// render page counts, and it must reflect the filters, not the whole table.
async function getDeliveryEscalationPage(view, opts = {}) {
  const { where, params } = deWhere(view, opts);
  const { page, perPage, offset } = dePaging(opts);
  const pool = await getPool();
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM Delivery_escalation WHERE ${where}`, params);
  const [rows] = await pool.execute(
    `SELECT ${DE_SELECT_COLUMNS} FROM Delivery_escalation WHERE ${where}
     ORDER BY ${deOrderBy(view)} LIMIT ${perPage} OFFSET ${offset}`, params);
  return { rows, total: Number(countRows[0]?.total) || 0, page, perPage };
}

// Overview's tiles. Counted in SQL rather than by measuring an already-fetched list, so they
// describe the whole table (35k+ rows) instead of whatever subset happened to be loaded.
// SUM(<condition>) counts matching rows; mysql2 hands those back as strings/Decimals, hence
// the Number() coercion.
// Counted by DISTINCT awb_code, not row count - the same AWB can legitimately have more than
// one row (both brands, or a re-shipped order; ~4.7k AWBs currently do), and counting rows would
// double-count those. COUNT(DISTINCT ...) already ignores NULL/blank awb_code on its own, so a
// ticket with no AWB at all (144 rows currently) doesn't land in any bucket, including total -
// this reports "how many distinct parcels", not "how many rows".
async function getDeliveryEscalationStats(opts = {}) {
  const { clauses, params } = deFilterSql(opts);
  const where = clauses.length ? clauses.join(' AND ') : '1 = 1';
  const pool = await getPool();
  const [rows] = await pool.execute(
    `SELECT COUNT(DISTINCT awb_code) AS total,
            COUNT(DISTINCT CASE WHEN agent_email IS NOT NULL AND agent_email != '' THEN awb_code END) AS assigned,
            COUNT(DISTINCT CASE WHEN ${DE_RESOLVED_WHERE} THEN awb_code END) AS resolved,
            COUNT(DISTINCT CASE WHEN ${DE_FRESH_WHERE} THEN awb_code END) AS fresh,
            COUNT(DISTINCT CASE WHEN ${DE_FORCED_RTO_WHERE} THEN awb_code END) AS forcedRto
     FROM Delivery_escalation WHERE ${where}`, params);
  const r = rows[0] || {};
  return {
    total: Number(r.total) || 0,
    assigned: Number(r.assigned) || 0,
    resolved: Number(r.resolved) || 0,
    fresh: Number(r.fresh) || 0,
    forcedRto: Number(r.forcedRto) || 0,
  };
}

// Populates the admin-only Agent filter. Distinct over a 35k-row table is cheap enough not to
// need its own index yet.
// "How often did a customer come back, on complaints that are STILL open" - bucketed by how
// many tickets share an AWB. Counted per DISTINCT AWB (one parcel = one customer here), not per
// ticket, so a customer who came 5 times is one entry in the 5-9 bucket rather than five.
//
// "Still not resolved" = the AWB still has at least one ticket sitting in the Fresh tab, i.e.
// the same DE_FRESH_WHERE that tab lists by. Judged across the customer's whole history rather
// than per ticket, so one customer is one entry however many tickets they raised - but unlike a
// "never delivered" test, a customer whose parcel was delivered yet still has an Escalated
// ticket open does count, because there is genuinely still something open for them.
//
// Grouped off the aggregate rather than the stored contact_count so the two can never disagree
// mid-window (contact_count is refreshed by the cron sync; this is exact as of right now).
//
// Uses pool.execute with an interpolated DE_FRESH_WHERE rather than the sql`` tag: that tag
// turns every ${} into a bound parameter, which would send the predicate as a string literal
// instead of SQL. Reusing the constant is the point - "unresolved" here is exactly what the
// Fresh tab lists, so the two can never drift apart if that definition changes.
async function getDeliveryEscalationRepeatStats() {
  const pool = await getPool();
  const [rows] = await pool.execute(`
    SELECT CASE WHEN times = 1 THEN '1 time'
                WHEN times BETWEEN 2 AND 4 THEN '2-4 times'
                WHEN times BETWEEN 5 AND 9 THEN '5-9 times'
                ELSE '10+ times' END AS bucket,
           COUNT(*) AS customers,
           MIN(times) AS sort_key
    FROM (
      SELECT awb_code,
             COUNT(*) AS times,
             MAX(${DE_FRESH_WHERE}) AS has_open
      FROM Delivery_escalation
      WHERE awb_code IS NOT NULL AND awb_code <> ''
      GROUP BY awb_code
    ) per_awb
    WHERE has_open = 1
    GROUP BY bucket
    ORDER BY sort_key
  `);
  return rows.map((r) => ({ bucket: r.bucket, customers: Number(r.customers) || 0 }));
}

// Overview's day-wise TAT table: one row per Query date (added_date), one column per
// DE_DAYWISE_BUCKET_SQL bucket, each date's own total, and that bucket's % of THAT DATE's total
// (computed here, not in the browser, so the client only ever renders ready-made numbers).
// Spans all views (Fresh/Resolved/Forced RTO together) - unlike deWhere/getDeliveryEscalationPage
// this isn't scoped to one, since Forced RTO needs a column in the SAME table as Fresh/Resolved
// rows. brand/agent are the same optional filters the rest of the page already exposes; there is
// no scopeEmail (see this file's header note on Delivery-Escalation having no per-agent scope).
//
// 'unresolved' in this table means "no added_date at all" (DE_DAYWISE_BUCKET_SQL's only branch
// for it, since an open ticket buckets by age-as-of-today instead) - and a row with no added_date
// has no Query date to sit under, so it can never appear as one of the per-date `rows` below.
// It used to be dropped outright: the main query's own WHERE excluded it (needed to GROUP BY a
// real date), and nothing else ever counted it, so grandTotal.unresolved was always exactly 0 -
// not because there were none, but because the ones that existed were silently uncounted. A
// second query (grouped by nothing, since these rows share no date to group by) folds them into
// the grand total only; they still contribute no per-date row, because there is no date to put
// one under.
async function getDeliveryEscalationDaywiseStats(opts = {}) {
  const { brand, agent } = opts;
  const extraClauses = [];
  const params = [];
  if (brand) { extraClauses.push('brand = ?'); params.push(brand); }
  if (agent) { extraClauses.push('LOWER(agent_email) = ?'); params.push(String(agent).toLowerCase()); }
  const extra = extraClauses.length ? ` AND ${extraClauses.join(' AND ')}` : '';
  const pool = await getPool();
  const [rows] = await pool.execute(`
    SELECT DATE_FORMAT(added_date, '%Y-%m-%d') AS d, ${DE_DAYWISE_BUCKET_SQL} AS bucket, COUNT(*) AS c
    FROM Delivery_escalation
    WHERE added_date IS NOT NULL${extra}
    GROUP BY d, bucket
    ORDER BY d
  `, params);
  const [[{ noDateCount }]] = await pool.execute(
    `SELECT COUNT(*) AS noDateCount FROM Delivery_escalation WHERE added_date IS NULL${extra}`, params);

  const byDate = new Map();
  const grandTotal = {};
  DE_DAYWISE_BUCKETS.forEach((b) => { grandTotal[b] = 0; });
  let grandTotalAll = 0;
  for (const r of rows) {
    const c = Number(r.c) || 0;
    if (!byDate.has(r.d)) {
      const counts = {};
      DE_DAYWISE_BUCKETS.forEach((b) => { counts[b] = 0; });
      byDate.set(r.d, { date: r.d, counts, total: 0 });
    }
    const entry = byDate.get(r.d);
    entry.counts[r.bucket] += c;
    entry.total += c;
    grandTotal[r.bucket] += c;
    grandTotalAll += c;
  }
  const missingDateCount = Number(noDateCount) || 0;
  grandTotal.unresolved += missingDateCount;
  grandTotalAll += missingDateCount;
  const rowsOut = [...byDate.values()].map((entry) => ({
    date: entry.date,
    total: entry.total,
    counts: entry.counts,
    pct: Object.fromEntries(DE_DAYWISE_BUCKETS.map((b) => [
      b, entry.total ? Math.round((entry.counts[b] / entry.total) * 100) : 0,
    ])),
  }));
  return { buckets: DE_DAYWISE_BUCKETS, rows: rowsOut, grandTotal, grandTotalAll, missingDateCount };
}

async function getDeliveryEscalationAgents() {
  const { rows } = await sql`
    SELECT DISTINCT agent_email FROM Delivery_escalation
    WHERE agent_email IS NOT NULL AND agent_email != ''
    ORDER BY agent_email
  `;
  return rows.map((r) => r.agent_email);
}

// One CHUNK of a CSV export - current filter/scope, ordered, LIMIT/OFFSET by opts.page (1-based).
// DELIVERY_ESCALATION_MAX_EXPORT is a per-request chunk size, not a total cap: it exists only
// to keep any one response inside Lambda's 6MB ceiling. The client (see downloadCsv in
// DeliveryEscalationClient.js) walks page 1, 2, 3... requesting the next chunk until one comes
// back shorter than the chunk size, so the export itself has no row-count ceiling. Same
// LIMIT/OFFSET-must-be-inlined-not-bound reasoning as dePaging above.
async function getDeliveryEscalationExport(view, opts = {}) {
  const { where, params } = deWhere(view, opts);
  const page = Math.max(parseInt(opts.page, 10) || 1, 1);
  const offset = (page - 1) * DELIVERY_ESCALATION_MAX_EXPORT;
  const pool = await getPool();
  const [rows] = await pool.execute(
    `SELECT ${DE_SELECT_COLUMNS} FROM Delivery_escalation WHERE ${where}
     ORDER BY ${deOrderBy(view)} LIMIT ${DELIVERY_ESCALATION_MAX_EXPORT} OFFSET ${offset}`, params);
  return rows;
}

// Claims a Fresh ticket for an agent, MySQL-only - same "first claim wins" shape as the sheet
// flow's own claim-on-open, just against this row's id instead of a sheet cell. The WHERE guard
// makes this safe to call unconditionally (no-ops, 0 rows affected, if someone already claimed
// it) - callers don't need to check assignment first.
async function claimDeliveryEscalationTicketById(id, email) {
  await sql`
    UPDATE Delivery_escalation
    SET agent_email = ${email}, assigned_at = now()
    WHERE id = ${id} AND (agent_email IS NULL OR agent_email = '')
  `;
}

// Disposes a Fresh ticket directly against its own row - no sheet write at all, same model as
// CLS_RTO_calling's own claim/dispose. Claims on the agent's own behalf first if nobody has
// (claim-on-resolve), same as the old sheet flow's claimNow in saveAction.
//
// Also cascades the SAME outcome/remarks to every other row sharing this ticket's awb_code AND
// brand that's still Fresh-eligible (DE_FRESH_WHERE, which already excludes Forced RTO). This
// is the repeat-contact case getDeliveryEscalationRepeatStats/contact_count already surfaces:
// the same parcel can arrive as several separate tickets - a fresh ticket_number per day it
// stays flagged (see sync_delivery_tickets_to_sheet.py) - so resolving the newest one used to
// leave every older duplicate sitting in Fresh looking unresolved even though the parcel itself
// was already handled. Scoped to the SAME brand read off this row (unlike
// bulkDisposeDeliveryEscalationByAwb below, which only has an AWB string typed into a CSV, with
// no row to read a brand off).
async function disposeDeliveryEscalationTicketById(id, email, outcome, agentRemarks) {
  const pool = await getPool();
  await pool.execute(`
    UPDATE Delivery_escalation
    SET outcome = ?, agent_remarks = ?, disposed_at = NOW(),
        agent_email = CASE WHEN agent_email IS NULL OR agent_email = '' THEN ? ELSE agent_email END,
        assigned_at = CASE WHEN assigned_at IS NULL THEN NOW() ELSE assigned_at END
    WHERE id = ?
  `, [outcome || null, agentRemarks || null, email, id]);

  await pool.execute(`
    UPDATE Delivery_escalation d
    JOIN (SELECT awb_code, brand FROM Delivery_escalation WHERE id = ?) t
      ON d.awb_code = t.awb_code AND d.brand = t.brand
    SET d.outcome = ?, d.agent_remarks = ?, d.disposed_at = NOW(),
        d.agent_email = CASE WHEN d.agent_email IS NULL OR d.agent_email = '' THEN ? ELSE d.agent_email END,
        d.assigned_at = CASE WHEN d.assigned_at IS NULL THEN NOW() ELSE d.assigned_at END
    WHERE d.id <> ? AND t.awb_code IS NOT NULL AND t.awb_code <> '' AND (${DE_FRESH_WHERE})
  `, [id, outcome || null, agentRemarks || null, email, id]);
}

// Bulk outcome upload for the Fresh AND Forced RTO tabs (see api/delivery-escalation/record.js's
// 'bulkDispose' action) - one UPDATE per (awb, outcome) pair, matching every row with that
// awb_code THAT'S STILL IN THE UPLOADING TAB'S OWN VIEW (DE_VIEW_WHERE[view]): an AWB can
// legitimately repeat (same AWB reused across brands, a re-shipped order, or the same parcel
// sitting in both Fresh and Forced RTO as separate ticket rows - see the repeat-contact case
// disposeDeliveryEscalationTicketById's own cascade handles for the single-dispose path), and
// there's no brand column in the upload to disambiguate, so every match within that view gets
// the same outcome. Scoping by view - not just "is this outcome still open" - is what stops a
// Fresh upload from silently resolving an unrelated Forced RTO row for the same AWB, and vice
// versa. Returns how many rows each pair actually changed, so the caller can report AWBs that
// matched nothing (typo, wrong AWB) or matched zero because every row for that AWB in this view
// was already resolved.
//
// agent_email is ALWAYS set to whoever ran the upload, even if some other agent had already
// claimed the row - unlike the single claim/dispose path (claimDeliveryEscalationTicketById/
// disposeDeliveryEscalationTicketById), which only fills a blank agent_email and never
// overwrites an existing claim. A bulk upload's outcome IS the disposal, uploaded by the person
// who ran it, not a claim being made on someone else's behalf.
// Runs BULK_CHUNK_SIZE row-updates at once per chunk rather than one at a time - a fully
// sequential loop over a few thousand rows was already brushing API Gateway's hard ~29s
// integration ceiling (see MAX_BULK_ROWS's own comment in record.js), and that ceiling can't be
// raised from either the Lambda's or this pool's config, no matter how the row loop is written.
// Firing several queries at once instead lets mysql2's own pool (connectionLimit 5, see getPool)
// actually run up to 5 of them concurrently instead of 4 connections sitting idle while one row
// updates at a time - asking for more concurrency than the pool has is free, since excess
// requests just queue for the next free connection rather than erroring.
const BULK_CHUNK_SIZE = 8;

async function bulkDisposeDeliveryEscalationByAwb(rows, email, view) {
  if (view !== 'fresh' && view !== 'forced_rto') {
    throw new Error(`Unknown Delivery-Escalation bulk-upload view: ${view}`);
  }
  const where = DE_VIEW_WHERE[view];
  const pool = await getPool();
  const results = [];
  for (let i = 0; i < rows.length; i += BULK_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + BULK_CHUNK_SIZE);
    const chunkResults = await Promise.all(chunk.map(async ({ awb, outcome, remarks }) => {
      const [result] = await pool.execute(`
        UPDATE Delivery_escalation
        SET outcome = ?, agent_remarks = ?, disposed_at = NOW(),
            agent_email = ?,
            assigned_at = CASE WHEN assigned_at IS NULL THEN NOW() ELSE assigned_at END
        WHERE awb_code = ? AND (${where})
      `, [outcome, remarks || null, email, awb]);
      return { awb, outcome, matched: result.affectedRows || 0 };
    }));
    results.push(...chunkResults);
  }
  return results;
}

// dateFrom/dateTo are inclusive "YYYY-MM-DD" strings (or null for unbounded), interpreted
// as IST calendar days (+05:30, matching the hour-of-day bucketing above and the rest of
// this app's IST convention) rather than UTC days - otherwise "Today"/"Yesterday" would be
// off by up to 5.5 hours around the day boundary. Each metric below applies these bounds
// to its OWN natural timestamp (assigned_at for assigned/pending, disposed_at for
// everything disposal-related), not a single shared WHERE, since one calendar range means
// something different depending on which side of a lead's lifecycle you're counting.
function dateBounds(dateFrom, dateTo) {
  return {
    from: dateFrom ? new Date(`${dateFrom}T00:00:00.000+05:30`) : null,
    to: dateTo ? new Date(`${dateTo}T23:59:59.999+05:30`) : null,
  };
}

// Cross-agent lead/disposition KPIs for the Calling Team's "Overview" sub-tab
// (app/calling-overview/) - aggregated straight from MySQL CLS_RTO_calling, the same table
// rto-crm.html's own submitDisp() already writes to (via recordLeadDisposition above), so
// this needs no new data pipeline. "Connect rate" mirrors rto-crm's own definition: disposed leads where
// connected = 'Yes', over all disposed leads (blank/other values excluded from the
// denominator the same way rto-crm's own KPI row treats them).
//
// Reads the BASE table, with `reassigned_away_at IS NULL` added to the two metrics that
// count LEADS rather than CALLS - because the two grains genuinely differ now that a
// reassigned lead keeps a row per agent who tried it:
//   - assigned / pending answer "how many leads", so they must count each lead once, i.e.
//     its live cycle only. Without the predicate a lead reassigned three times would read
//     as three assigned leads.
//   - disposed / connected / unreachable / refunded answer "how many CALLS were made and
//     how did they go", so every cycle counts: the first agent really did dial and fail to
//     connect, and that attempt stays in the denominator of connect rate where it belongs.
//     This also keeps these numbers matching what they reported before this table was
//     re-grained, when a reassignment overwrote the row and left its old disposition behind.
async function getCallingOverviewStats(dateFrom, dateTo) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  // MySQL has no FILTER clause (Postgres) - SUM(CASE WHEN ... THEN 1 ELSE 0 END) is its
  // aggregate-with-a-condition equivalent. `${from} IS NULL OR ...` needs no ::timestamptz
  // cast here (unlike the Postgres version): a bound `?` parameter's type is never ambiguous
  // to MySQL the way an untyped NULL literal could be to Postgres.
  const { rows } = await sql`
    SELECT
      SUM(CASE WHEN reassigned_away_at IS NULL AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to}) THEN 1 ELSE 0 END) AS total_assigned,
      SUM(CASE WHEN disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN 1 ELSE 0 END) AS total_disposed,
      SUM(CASE WHEN reassigned_away_at IS NULL AND disposed_at IS NULL AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to}) THEN 1 ELSE 0 END) AS total_pending,
      SUM(CASE WHEN connected = 'Yes' AND disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN 1 ELSE 0 END) AS total_connected,
      SUM(CASE WHEN connected = 'No' AND disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN 1 ELSE 0 END) AS total_unreachable,
      SUM(CASE WHEN (disposition = 'Refund Requested' OR refund_amount IS NOT NULL) AND disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN 1 ELSE 0 END) AS total_refunded,
      COALESCE(SUM(CASE WHEN disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN refund_amount ELSE 0 END), 0) AS total_refund_amount,
      SUM(CASE WHEN disposed_at IS NOT NULL
            AND (disposition IN ('Customer Agreed to Accept', 'Product Issue / Exchange') OR new_order_id IS NOT NULL)
            AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
          THEN 1 ELSE 0 END) AS total_converted
    FROM CLS_RTO_calling
  `;
  const r = rows[0] || {};
  // mysql2 returns SUM()'s result as a decimal STRING, not a JS number (unlike Postgres's
  // ::int/::float casts, which the driver already hands back as numbers) - Number(...) here
  // is that same cast, done on the JS side instead of in SQL.
  const num = (v) => Number(v) || 0;
  const totalDisposed = num(r.total_disposed);
  const totalConnected = num(r.total_connected);
  const totalConnectAttempts = totalConnected + num(r.total_unreachable);
  return {
    totalAssigned: num(r.total_assigned),
    totalDisposed,
    totalPending: num(r.total_pending),
    connectRate: totalConnectAttempts > 0 ? Math.round((totalConnected / totalConnectAttempts) * 100) : 0,
    totalRefunded: num(r.total_refunded),
    totalRefundAmount: num(r.total_refund_amount),
    totalConverted: num(r.total_converted),
  };
}

// Hour-of-day (IST) activity pattern for the Overview tab's chart - every lead bucketed
// by the hour its own natural timestamp falls in (assigned_at for "assigned"; disposed_at
// for the other four, since dialling/connecting/reordering/refunding all happen at
// disposal time), summed across all history rather than a specific day. "Reordered"
// mirrors RtoCrmClient.js's own reordersConverted definition exactly (disposition value
// OR a replacement order ID), now that new_order_id is captured in Postgres too.
//
// Same grain split as getCallingOverviewStats: "assigned" counts leads, so it reads the
// live-cycle view; the four disposal series count calls, so they read the base table and
// every attempt on a reassigned lead lands in the hour it was actually dialled.
async function getCallingHourlyStats(dateFrom, dateTo) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  // CONVERT_TZ with explicit +00:00/+05:30 OFFSETS (not the named 'Asia/Kolkata' zone Postgres
  // used) - MySQL only needs its zoneinfo tables loaded (mysql.time_zone_name, not guaranteed
  // populated on RDS) for NAMED zones; a fixed numeric offset works unconditionally. Every
  // stored timestamp is naive-but-UTC (see fetch_current_assignment_times in assign_leads.py),
  // so +00:00 -> +05:30 is exactly the IST shift the Postgres version's AT TIME ZONE gave.
  const [assignedRows, disposedRows] = await Promise.all([
    sql`
      SELECT HOUR(CONVERT_TZ(assigned_at, '+00:00', '+05:30')) AS hour, COUNT(*) AS n
      FROM CLS_RTO_calling
      WHERE reassigned_away_at IS NULL
        AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to})
      GROUP BY 1
    `,
    sql`
      SELECT
        HOUR(CONVERT_TZ(disposed_at, '+00:00', '+05:30')) AS hour,
        COUNT(*) AS dialled,
        SUM(CASE WHEN connected = 'Yes' THEN 1 ELSE 0 END) AS connected,
        SUM(CASE WHEN disposition IN ('Customer Agreed to Accept', 'Product Issue / Exchange') OR new_order_id IS NOT NULL THEN 1 ELSE 0 END) AS reordered,
        SUM(CASE WHEN disposition = 'Refund Requested' OR refund_amount IS NOT NULL THEN 1 ELSE 0 END) AS refunded
      FROM CLS_RTO_calling
      WHERE disposed_at IS NOT NULL
        AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
      GROUP BY 1
    `,
  ]);

  const byHour = Array.from({ length: 24 }, (_, hour) => ({
    hour, assigned: 0, dialled: 0, connected: 0, reordered: 0, refunded: 0,
  }));
  for (const r of assignedRows.rows) byHour[r.hour].assigned = Number(r.n) || 0;
  for (const r of disposedRows.rows) {
    byHour[r.hour].dialled = Number(r.dialled) || 0;
    byHour[r.hour].connected = Number(r.connected) || 0;
    byHour[r.hour].reordered = Number(r.reordered) || 0;
    byHour[r.hour].refunded = Number(r.refunded) || 0;
  }
  return byHour;
}

// ── Calling business hours ────────────────────────────────────────────────────────────
// Stored per (process, weekday) so a single day can differ from the rest - Friday closing
// early, Sunday closed entirely - which a single start/end pair per process couldn't express.
const BUSINESS_HOUR_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// 'HH:MM' (00:00-23:59) or '' / null for "closed". Rejects anything else rather than storing
// a value assign_leads.py would later fail to parse - a malformed close time that silently
// meant "closed" would stop lead assignment without anyone being told why.
function normalizeTimeOfDay(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new Error(`Invalid time "${s}" - expected HH:MM (24-hour), or blank for closed`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

// { [processKey]: { mon: {open, close}, ... } } for whatever has been saved. A process with no
// saved rows is simply absent - callers fall back to callingProcesses.json's defaults, so
// hours behave as documented until an admin actually changes them.
async function getCallingBusinessHours() {
  await ensurePgSchema();
  const { rows } = await pgSql`
    SELECT process_key, day, open_time, close_time FROM calling_business_hours
  `;
  const out = {};
  for (const r of rows) {
    (out[r.process_key] = out[r.process_key] || {})[r.day] = {
      open: r.open_time || '',
      close: r.close_time || '',
    };
  }
  return out;
}

// Replaces one process's whole week in a single transaction-less upsert per day. Days absent
// from `week` are left untouched rather than deleted, so a partial payload can't silently
// close days the admin never looked at.
async function setCallingBusinessHours(processKey, week, updatedBy) {
  await ensurePgSchema();
  if (!processKey) throw new Error('processKey is required');
  for (const day of Object.keys(week || {})) {
    if (!BUSINESS_HOUR_DAYS.includes(day)) {
      throw new Error(`Unknown day "${day}" - expected one of ${BUSINESS_HOUR_DAYS.join(', ')}`);
    }
    const open = normalizeTimeOfDay(week[day] && week[day].open);
    const close = normalizeTimeOfDay(week[day] && week[day].close);
    // One time without the other is ambiguous ("open at 10:00 until when?"), so both are
    // required together or the day counts as closed.
    if ((open && !close) || (close && !open)) {
      throw new Error(`${day}: set both an open and a close time, or leave both blank for closed`);
    }
    if (open && close && open >= close) {
      // String compare is safe on zero-padded HH:MM. Overnight windows aren't supported -
      // assign_leads.py treats the window as a single same-day range.
      throw new Error(`${day}: close time ${close} must be after open time ${open}`);
    }
    await pgSql`
      INSERT INTO calling_business_hours (process_key, day, open_time, close_time, updated_at, updated_by)
      VALUES (${processKey}, ${day}, ${open}, ${close}, now(), ${updatedBy || null})
      ON CONFLICT (process_key, day) DO UPDATE
        SET open_time = EXCLUDED.open_time,
            close_time = EXCLUDED.close_time,
            updated_at = now(),
            updated_by = EXCLUDED.updated_by
    `;
  }
  return getCallingBusinessHours();
}

// ── Per-process calling roster ─────────────────────────────────────────────────────────
// 'Busy' (UI label "On Break") predates this file's own naming conventions - kept as-is
// rather than renamed, since it's already load-bearing history in agent_presence_log and
// getAgentPresenceLogSummary's break-time math below. The new "Busy" status the UI actually
// shows today (an agent currently on a call, not on a break) is a DIFFERENT status, so it
// gets its own distinct value, 'OnCall', to avoid colliding with the existing one.
const CALLING_STATUSES = ['Online', 'Busy', 'OnCall', 'Offline'];

// Everyone invited to a process, with their per-process status and quota.
//
// Membership comes from the invitation rows (MySQL: users + report_tab_permissions), and the
// operational state from calling_agent_process (Postgres) - two different databases, so this
// joins them in JS rather than in SQL. Admins are included: they hold no per-process rows by
// convention (see getUserTabPermissions), so they'd otherwise vanish from every roster.
//
// An agent with no row yet is reported as Offline with a null quota, meaning "fall back to the
// process default" rather than "zero capacity" - a missing row must never read as a quota of 0,
// which would quietly make them ineligible for any lead.
async function getCallingProcessAgents(processKey) {
  await ensureSchema();
  await ensurePgSchema();
  // Membership has to follow the same convention the rest of the app uses: holding the
  // 'calling' card with NO tab rows means unrestricted - every process - so those people
  // belong in every process's roster. An earlier version required an explicit tab row, which
  // listed only the handful of people who happened to have one and silently omitted everybody
  // with blanket access (including a process admin, who then couldn't see their own roster).
  //
  // So: in if you hold the card and either have no calling tab rows at all, or have one for
  // THIS process. Global admins are always in, since they hold no tab rows by convention.
  // Neither query depends on the other's result - they're only combined in JS below (byEmail)
  // - so fire both at once instead of waiting on MySQL before even starting the Postgres query.
  const [{ rows: members }, { rows: state }] = await Promise.all([
    sql`
      SELECT u.id, u.email, u.name, u.is_admin
      FROM users u
      LEFT JOIN permissions p
        ON p.user_id = u.id AND p.card_key = 'calling'
      WHERE u.is_admin = 1
         OR (p.card_key IS NOT NULL AND (
              EXISTS (SELECT 1 FROM report_tab_permissions r
                       WHERE r.user_id = u.id AND r.card_key = 'calling' AND r.tab_key = ${processKey})
              OR NOT EXISTS (SELECT 1 FROM report_tab_permissions r2
                       WHERE r2.user_id = u.id AND r2.card_key = 'calling')
            ))
      GROUP BY u.id, u.email, u.name, u.is_admin
      ORDER BY u.is_admin DESC, u.name ASC
    `,
    pgSql`
      SELECT email, status, max_quota, is_process_admin, prepaid_pct, priority_rto_reasons,
             reassign_payment_mode, attempt_count_filter, ndr_reason_filter, ndr_payment_mode_filter,
             ndr_brand_filter, updated_at, updated_by
      FROM calling_agent_process WHERE process_key = ${processKey}
    `,
  ]);
  const byEmail = {};
  for (const s of state) byEmail[String(s.email).toLowerCase()] = s;
  return members.map((m) => {
    const s = byEmail[String(m.email).toLowerCase()];
    return {
      email: m.email,
      name: m.name || String(m.email).split('@')[0],
      isAdmin: !!m.is_admin,
      status: (s && s.status) || 'Offline',
      maxQuota: s && s.max_quota != null ? s.max_quota : null,
      isProcessAdmin: !!(s && s.is_process_admin),
      prepaidPct: s && s.prepaid_pct != null ? s.prepaid_pct : null,
      priorityRtoReasons: (s && s.priority_rto_reasons) || '',
      reassignPaymentMode: (s && s.reassign_payment_mode) || '',
      attemptCountFilter: (s && s.attempt_count_filter) || '',
      ndrReasonFilter: (s && s.ndr_reason_filter) || '',
      ndrPaymentModeFilter: (s && s.ndr_payment_mode_filter) || '',
      ndrBrandFilter: (s && s.ndr_brand_filter) || '',
      updatedAt: (s && s.updated_at) || null,
      updatedBy: (s && s.updated_by) || null,
    };
  });
}

// Upserts one agent's status and/or quota for one process. Either field may be omitted, so an
// agent flipping their own status can't accidentally reset a quota an admin set.
async function setCallingProcessAgent(processKey, email, { status, maxQuota, isProcessAdmin, prepaidPct, priorityRtoReasons, reassignPaymentMode, attemptCountFilter, ndrReasonFilter, ndrPaymentModeFilter, ndrBrandFilter } = {}, updatedBy) {
  await ensurePgSchema();
  const key = String(email || '').trim().toLowerCase();
  if (!processKey || !key) throw new Error('processKey and email are required');
  if (status !== undefined && status !== null && !CALLING_STATUSES.includes(status)) {
    throw new Error(`status must be one of: ${CALLING_STATUSES.join(', ')}`);
  }
  let quota = null;
  if (maxQuota !== undefined && maxQuota !== null && maxQuota !== '') {
    quota = parseInt(maxQuota, 10);
    if (!Number.isFinite(quota) || quota < 0) throw new Error('maxQuota must be a non-negative whole number');
  }
  // Same "unset means leave it alone" contract as maxQuota above - a missing prepaidPct here
  // (an agent flipping status, or the JS Team Total row simply not being touched) must not
  // reset a target an admin already set.
  let prepaidTarget = null;
  if (prepaidPct !== undefined && prepaidPct !== null && prepaidPct !== '') {
    prepaidTarget = parseInt(prepaidPct, 10);
    if (!Number.isFinite(prepaidTarget) || prepaidTarget < 0 || prepaidTarget > 100) {
      throw new Error('prepaidPct must be a whole number between 0 and 100');
    }
  }
  // COALESCE(EXCLUDED.x, table.x) so an omitted field keeps its stored value instead of being
  // overwritten with null.
  // isProcessAdmin is a real tri-state here: undefined means "leave it alone", true/false mean
  // set it. A plain COALESCE would make `false` indistinguishable from "not supplied" and so
  // make revoking impossible.
  const adminFlag = (isProcessAdmin === undefined || isProcessAdmin === null) ? null : !!isProcessAdmin;
  // priorityRtoReasons is text, not numeric, so '' (explicitly clearing every specialization)
  // is a real, distinct-from-NULL value that COALESCE will apply rather than skip - only an
  // omitted field (undefined, mapped to NULL here) leaves the stored value untouched.
  const reasonsText = priorityRtoReasons === undefined ? null : String(priorityRtoReasons || '').trim();
  // Same "'' is a real, distinct-from-NULL value" contract as priorityRtoReasons above (unlike
  // prepaidPct/maxQuota, where '' from the client means null i.e. "leave alone") - the "No
  // restriction" option must actively clear a previously-set filter, not just be indistinguishable
  // from the field being omitted entirely.
  if (reassignPaymentMode !== undefined && reassignPaymentMode !== '' &&
      reassignPaymentMode !== 'Prepaid' && reassignPaymentMode !== 'COD') {
    throw new Error("reassignPaymentMode must be '', 'Prepaid', or 'COD'");
  }
  const reassignModeText = reassignPaymentMode === undefined ? null : String(reassignPaymentMode || '').trim();
  // Same "'' is a real, distinct-from-NULL value" contract as reasonsText/reassignModeText -
  // clearing every attempt-count restriction must actively write '' (unrestricted), not just
  // be indistinguishable from the field being omitted entirely.
  const attemptFilterText = attemptCountFilter === undefined ? null : String(attemptCountFilter || '').trim();
  // Same "'' is a real, distinct-from-NULL value" contract as attemptFilterText above.
  const ndrReasonFilterText = ndrReasonFilter === undefined ? null : String(ndrReasonFilter || '').trim();
  // Fixed, controlled value set (unlike ndrReasonFilter's free text) - same validation shape as
  // reassignPaymentMode above, but this one gates every NDR lead, not just reassignments.
  if (ndrPaymentModeFilter !== undefined && ndrPaymentModeFilter !== '' &&
      ndrPaymentModeFilter !== 'Prepaid' && ndrPaymentModeFilter !== 'COD') {
    throw new Error("ndrPaymentModeFilter must be '', 'Prepaid', or 'COD'");
  }
  const ndrPaymentModeFilterText = ndrPaymentModeFilter === undefined ? null : String(ndrPaymentModeFilter || '').trim();
  // Same fixed-value-set validation as ndrPaymentModeFilter above.
  if (ndrBrandFilter !== undefined && ndrBrandFilter !== '' &&
      ndrBrandFilter !== 'Hyphen' && ndrBrandFilter !== 'mCaffeine') {
    throw new Error("ndrBrandFilter must be '', 'Hyphen', or 'mCaffeine'");
  }
  const ndrBrandFilterText = ndrBrandFilter === undefined ? null : String(ndrBrandFilter || '').trim();
  await pgSql`
    INSERT INTO calling_agent_process (email, process_key, status, max_quota, is_process_admin, prepaid_pct, priority_rto_reasons, reassign_payment_mode, attempt_count_filter, ndr_reason_filter, ndr_payment_mode_filter, ndr_brand_filter, updated_at, updated_by)
    VALUES (${key}, ${processKey}, ${status || 'Offline'}, ${quota}, ${adminFlag === null ? false : adminFlag}, ${prepaidTarget}, ${reasonsText || ''}, ${reassignModeText || ''}, ${attemptFilterText || ''}, ${ndrReasonFilterText || ''}, ${ndrPaymentModeFilterText || ''}, ${ndrBrandFilterText || ''}, now(), ${updatedBy || null})
    ON CONFLICT (email, process_key) DO UPDATE
      SET status = COALESCE(${status || null}, calling_agent_process.status),
          max_quota = COALESCE(${quota}, calling_agent_process.max_quota),
          is_process_admin = COALESCE(${adminFlag}, calling_agent_process.is_process_admin),
          prepaid_pct = COALESCE(${prepaidTarget}, calling_agent_process.prepaid_pct),
          priority_rto_reasons = COALESCE(${reasonsText}, calling_agent_process.priority_rto_reasons),
          reassign_payment_mode = COALESCE(${reassignModeText}, calling_agent_process.reassign_payment_mode),
          attempt_count_filter = COALESCE(${attemptFilterText}, calling_agent_process.attempt_count_filter),
          ndr_reason_filter = COALESCE(${ndrReasonFilterText}, calling_agent_process.ndr_reason_filter),
          ndr_payment_mode_filter = COALESCE(${ndrPaymentModeFilterText}, calling_agent_process.ndr_payment_mode_filter),
          ndr_brand_filter = COALESCE(${ndrBrandFilterText}, calling_agent_process.ndr_brand_filter),
          updated_at = now(),
          updated_by = ${updatedBy || null}
  `;
  return getCallingProcessAgents(processKey);
}

// Does this person administer this ONE process? Used to let a process admin through the
// admin routes for their own process only - it is not company-wide admin (users.is_admin) and
// must never be treated as such.
async function isCallingProcessAdmin(email, processKey) {
  await ensurePgSchema();
  if (!email || !processKey) return false;
  const { rows } = await pgSql`
    SELECT 1 FROM calling_agent_process
    WHERE lower(email) = ${String(email).toLowerCase()}
      AND process_key = ${processKey}
      AND is_process_admin = true
    LIMIT 1
  `;
  return rows.length > 0;
}

// Every process this person administers, for narrowing what a process admin is shown.
async function getAdministeredProcesses(email) {
  await ensurePgSchema();
  if (!email) return [];
  const { rows } = await pgSql`
    SELECT process_key FROM calling_agent_process
    WHERE lower(email) = ${String(email).toLowerCase()} AND is_process_admin = true
  `;
  return rows.map((r) => r.process_key);
}

// ── Per-process admin-defined disposition list (see calling_process_dispositions above) ────
// Arbitrary nesting depth - any option, at any depth, can have its own child sub-options.
// parent_id is self-referencing with no depth check, and getProcessDispositions' two-pass
// build already links children regardless of how deep they are.
const DISPOSITION_LABEL_MAX = 120;

async function getProcessDispositions(processKey) {
  await ensurePgSchema();
  if (!processKey) return [];
  const { rows } = await pgSql`
    SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
    WHERE process_key = ${processKey}
    ORDER BY sort_order ASC, id ASC
  `;
  const byId = {};
  rows.forEach((r) => {
    byId[r.id] = {
      id: r.id, label: r.label, description: r.description || '', sortOrder: r.sort_order,
      childrenInputType: r.children_input_type || 'single', children: [],
    };
  });
  const roots = [];
  // Two passes rather than one: a child row can appear before its parent in this result set
  // (sort_order is scoped per-parent, not global, so there's no ordering guarantee between
  // levels) - building byId for every row first means it doesn't matter which order they're
  // linked in.
  rows.forEach((r) => {
    if (r.parent_id && byId[r.parent_id]) byId[r.parent_id].children.push(byId[r.id]);
    else if (!r.parent_id) roots.push(byId[r.id]);
    // A row whose parent_id points at nothing in byId can't happen - ON DELETE CASCADE means
    // a parent can't be removed while this child row still exists.
  });
  return roots;
}

// New entries land at the end of their OWN scope (current max sort_order among siblings
// sharing the same parentId, +1) - adding a child never reshuffles other top-level options,
// and adding a top-level option never touches anyone's children.
async function addProcessDisposition(processKey, label, description, createdBy, parentId) {
  await ensurePgSchema();
  if (!processKey) throw new Error('processKey is required');
  const trimmed = String(label || '').trim();
  if (!trimmed) throw new Error('A disposition label is required');
  if (trimmed.length > DISPOSITION_LABEL_MAX) throw new Error(`Label must be ${DISPOSITION_LABEL_MAX} characters or fewer`);
  const parent = parentId || null;
  if (parent) {
    const { rows: parentRows } = await pgSql`
      SELECT id FROM calling_process_dispositions WHERE id = ${parent} AND process_key = ${processKey}
    `;
    if (!parentRows.length) throw new Error('Parent option not found for this process');
  }
  const maxRows = parent
    ? (await pgSql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM calling_process_dispositions WHERE process_key = ${processKey} AND parent_id = ${parent}`).rows
    : (await pgSql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM calling_process_dispositions WHERE process_key = ${processKey} AND parent_id IS NULL`).rows;
  await pgSql`
    INSERT INTO calling_process_dispositions (process_key, parent_id, label, description, sort_order, created_by)
    VALUES (${processKey}, ${parent}, ${trimmed}, ${String(description || '').trim() || null}, ${maxRows[0].next}, ${createdBy || null})
  `;
  return getProcessDispositions(processKey);
}

// label/description are independently optional - omitting one (undefined) leaves it
// untouched, same "unset means leave it alone" contract setCallingProcessAgent already uses
// for its own optional fields. An explicitly blank description ('') really does clear it;
// label can never be blanked out this way since a disposition must always have a name.
// Works the same regardless of whether id is a top-level option or a child - nesting depth
// never changes once an option is created.
async function updateProcessDisposition(processKey, id, { label, description, childrenInputType } = {}) {
  await ensurePgSchema();
  if (!processKey || !id) throw new Error('processKey and id are required');
  const labelText = label === undefined ? null : String(label).trim();
  if (label !== undefined && !labelText) throw new Error('A disposition label is required');
  if (labelText && labelText.length > DISPOSITION_LABEL_MAX) throw new Error(`Label must be ${DISPOSITION_LABEL_MAX} characters or fewer`);
  const descText = description === undefined ? null : String(description || '').trim();
  if (childrenInputType !== undefined && !['single', 'multi', 'text'].includes(childrenInputType)) {
    throw new Error("childrenInputType must be 'single', 'multi', or 'text'");
  }
  const { rows } = await pgSql`
    UPDATE calling_process_dispositions
    SET label = COALESCE(${labelText}, label),
        description = COALESCE(${descText}, description),
        children_input_type = COALESCE(${childrenInputType ?? null}, children_input_type)
    WHERE id = ${id} AND process_key = ${processKey}
    RETURNING id
  `;
  if (!rows.length) throw new Error('Disposition not found for this process');
  return getProcessDispositions(processKey);
}

// Cascades to children automatically (ON DELETE CASCADE on parent_id) - deleting a parent
// option takes its whole child list with it.
async function deleteProcessDisposition(processKey, id) {
  await ensurePgSchema();
  if (!processKey || !id) throw new Error('processKey and id are required');
  await pgSql`DELETE FROM calling_process_dispositions WHERE id = ${id} AND process_key = ${processKey}`;
  return getProcessDispositions(processKey);
}

// Full reorder in one shot within ONE scope - either every top-level option (parentId
// omitted/null), or one specific parent's children (parentId set). The extra
// parent_id-matching WHERE clause is a safety net, not just a filter: if a client ever sent
// an id that doesn't actually belong to the claimed scope, that row's update simply affects 0
// rows instead of silently reparenting/misordering something in a different scope.
// Transactional so a request that fails partway through never leaves sort_order in a
// half-renumbered state.
async function reorderProcessDispositions(processKey, parentId, orderedIds) {
  await ensurePgSchema();
  if (!processKey) throw new Error('processKey is required');
  if (!Array.isArray(orderedIds) || !orderedIds.length) throw new Error('orderedIds must be a non-empty array');
  const parent = parentId || null;
  await withPgTransaction(async (client) => {
    for (let i = 0; i < orderedIds.length; i++) {
      if (parent) {
        await client.query(
          'UPDATE calling_process_dispositions SET sort_order = $1 WHERE id = $2 AND process_key = $3 AND parent_id = $4',
          [i, orderedIds[i], processKey, parent]
        );
      } else {
        await client.query(
          'UPDATE calling_process_dispositions SET sort_order = $1 WHERE id = $2 AND process_key = $3 AND parent_id IS NULL',
          [i, orderedIds[i], processKey]
        );
      }
    }
  });
  return getProcessDispositions(processKey);
}

// Per-partner disposition breakdown (delivery_partner, derived from awb_code - see
// resolvePartnerFromAwb above). Surfaces "Customer Agreed to Accept" specifically alongside the total,
// so it directly answers "which partner is most of our Customer Agreed to Accept coming
// from" rather than just a generic disposed count - sorted by that count descending.
//
// Base table (every disposed cycle), since these are call-outcome counts - see
// getCallingOverviewStats for why that grain and not the live-cycle view.
async function getCallingPartnerBreakdown(dateFrom, dateTo) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const { rows } = await sql`
    SELECT
      COALESCE(delivery_partner, 'Unknown') AS partner,
      COUNT(*) AS total_disposed,
      SUM(CASE WHEN disposition = 'Customer Agreed to Accept' THEN 1 ELSE 0 END) AS customer_agreed_to_accept,
      SUM(CASE WHEN connected = 'Yes' THEN 1 ELSE 0 END) AS connected
    FROM CLS_RTO_calling
    WHERE disposed_at IS NOT NULL
      AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
    GROUP BY 1
    ORDER BY customer_agreed_to_accept DESC, total_disposed DESC
  `;
  return rows.map((r) => ({
    partner: r.partner,
    totalDisposed: Number(r.total_disposed) || 0,
    customerAgreedToAccept: Number(r.customer_agreed_to_accept) || 0,
    connected: Number(r.connected) || 0,
  }));
}

// Buckets the sheet's free-text RTO reason into a fixed set of categories, for
// getCallingRtoReasonBreakdown below. rto_reason comes from the courier/system - not a
// controlled enum - so the same underlying reason shows up under several spellings
// ("Customer Refused To Accept" / "REFUSED TO ACCEPT" / "Customer refused to
// accept:Verified"), and new spellings can appear any time the sheet's upstream source
// changes. Keyword matching (rather than an exact-value map) is what makes this resilient to
// that drift; check order matters where a string could match more than one bucket (e.g. an
// OTP-flavoured cancellation must land in OTP, not Customer Refused/Cancelled).
function categorizeRtoReason(rawReason) {
  const r = (rawReason || '').toUpperCase();
  if (!r || r === 'UNKNOWN' || r === 'N/A' || r === 'OTHERS') return 'Unknown/Other';
  if (r.includes('OTP')) return 'OTP/Verified Cancellation';
  if (['ADDRESS', 'DELIVERY AREA', 'TRACEABLE', 'LOCATED', 'PINCODE', 'PIN CODE'].some((k) => r.includes(k))) {
    return 'Address Issue';
  }
  if (['REATTEMPT', 'FUTURE DELIVERY', 'RESCHEDULE', 'ANOTHER DATE', 'DELAY DELIVERY'].some((k) => r.includes(k))) {
    return 'Reattempt/Future Delivery';
  }
  if (r.includes('REFUS') || r.includes('CANCEL')) return 'Customer Refused/Cancelled';
  if (['UNAVAILABLE', 'NOT CONTACTABLE', 'NOT AVAILABLE', 'NOT ANSWERING', 'RECEIVER NOT', 'PNA',
       'OFFICE CLOSED', 'RESIDENCE CLOSED', 'HOUSE LOCKED', 'PERSON NOT MET', 'DOOR LOCK'].some((k) => r.includes(k))) {
    return 'Customer Unavailable/Unreachable';
  }
  return 'Unknown/Other';
}

// Per-RTO-reason-category funnel (rto_reason bucketed via categorizeRtoReason above):
// assigned -> connected -> converted, each stage's own rate over total assigned. Sorted by
// volume descending, same as the partner breakdown.
//
// paymentMode ('', 'Prepaid', or 'COD') filters every stage by the SAME lead's payment_mode
// - see add_payment_mode_column.py/scripts/backfill_payment_mode.py for where that column
// comes from. '' means no filter (both). Assigned reads the live-cycle view (reassigned_away_at
// IS NULL) scoped by assigned_at, same grain as getCallingOverviewStats' totalAssigned;
// connected/converted read the base table scoped by disposed_at, same grain as its
// totalConnected - see that function's comment for why assigned and disposed/connected are
// deliberately different grains. "Converted" mirrors getCallingHourlyStats' "reordered"
// definition exactly: a disposition indicating the customer re-ordered, OR a replacement
// order_id was captured.
//
// The SQL still groups by the raw rto_reason (a handful of distinct values is cheap to
// aggregate in the database); categorizing and re-summing into buckets happens in JS after,
// since a keyword match isn't expressible as a GROUP BY key without a giant, drift-prone
// CASE WHEN duplicating categorizeRtoReason's logic in SQL.
async function getCallingRtoReasonBreakdown(dateFrom, dateTo, paymentMode) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const mode = paymentMode === 'Prepaid' || paymentMode === 'COD' ? paymentMode : null;
  const { rows } = await sql`
    SELECT
      COALESCE(rto_reason, 'Unknown') AS rto_reason,
      SUM(CASE WHEN reassigned_away_at IS NULL
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to})
          THEN 1 ELSE 0 END) AS total_assigned,
      SUM(CASE WHEN disposed_at IS NOT NULL AND connected = 'Yes'
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
          THEN 1 ELSE 0 END) AS total_connected,
      SUM(CASE WHEN disposed_at IS NOT NULL
            AND (disposition IN ('Customer Agreed to Accept', 'Product Issue / Exchange') OR new_order_id IS NOT NULL)
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
          THEN 1 ELSE 0 END) AS total_converted
    FROM CLS_RTO_calling
    GROUP BY 1
    HAVING total_assigned > 0 OR total_connected > 0 OR total_converted > 0
    ORDER BY total_assigned DESC
  `;
  const byCategory = new Map();
  for (const r of rows) {
    const category = categorizeRtoReason(r.rto_reason);
    const acc = byCategory.get(category) || { totalAssigned: 0, totalConnected: 0, totalConverted: 0 };
    acc.totalAssigned += Number(r.total_assigned) || 0;
    acc.totalConnected += Number(r.total_connected) || 0;
    acc.totalConverted += Number(r.total_converted) || 0;
    byCategory.set(category, acc);
  }
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
  return [...byCategory.entries()]
    .map(([rtoReason, acc]) => ({
      rtoReason,
      totalAssigned: acc.totalAssigned,
      totalConnected: acc.totalConnected,
      connectedPct: pct(acc.totalConnected, acc.totalAssigned),
      totalConverted: acc.totalConverted,
      convertedPct: pct(acc.totalConverted, acc.totalAssigned),
    }))
    .sort((a, b) => b.totalAssigned - a.totalAssigned);
}

// Delivery Partner funnel, each partner expandable (client-side) into its own RTO-reason-
// category funnel - the Overview tab's Delivery Partner Breakdown table, shown ABOVE the RTO
// Reason Breakdown table (getCallingRtoReasonBreakdown) rather than replacing it: that one
// answers "which reasons cost us the most conversions overall", this one answers "which
// courier, and why, for that courier specifically."
//
// Same funnel definition, same paymentMode filter, and the same assigned-vs-disposed grain
// split as getCallingRtoReasonBreakdown - see its comment. Only 9 distinct delivery_partner
// values exist today (measured against live data), so grouping by (delivery_partner,
// rto_reason) together and categorizing/re-summing in JS costs one query, not one per
// partner - cheap enough to return the whole matrix in the same round trip rather than
// fetching a partner's reasons lazily on expand.
async function getCallingPartnerReasonBreakdown(dateFrom, dateTo, paymentMode) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const mode = paymentMode === 'Prepaid' || paymentMode === 'COD' ? paymentMode : null;
  const { rows } = await sql`
    SELECT
      COALESCE(delivery_partner, 'Unknown') AS partner,
      COALESCE(rto_reason, 'Unknown') AS rto_reason,
      SUM(CASE WHEN reassigned_away_at IS NULL
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to})
          THEN 1 ELSE 0 END) AS total_assigned,
      SUM(CASE WHEN disposed_at IS NOT NULL AND connected = 'Yes'
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
          THEN 1 ELSE 0 END) AS total_connected,
      SUM(CASE WHEN disposed_at IS NOT NULL
            AND (disposition IN ('Customer Agreed to Accept', 'Product Issue / Exchange') OR new_order_id IS NOT NULL)
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
          THEN 1 ELSE 0 END) AS total_converted
    FROM CLS_RTO_calling
    GROUP BY 1, 2
    HAVING total_assigned > 0 OR total_connected > 0 OR total_converted > 0
  `;
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
  const emptyAcc = () => ({ totalAssigned: 0, totalConnected: 0, totalConverted: 0 });
  const byPartner = new Map();
  for (const r of rows) {
    const category = categorizeRtoReason(r.rto_reason);
    const assigned = Number(r.total_assigned) || 0;
    const connected = Number(r.total_connected) || 0;
    const converted = Number(r.total_converted) || 0;

    const partnerAcc = byPartner.get(r.partner) || { totals: emptyAcc(), byCategory: new Map() };
    partnerAcc.totals.totalAssigned += assigned;
    partnerAcc.totals.totalConnected += connected;
    partnerAcc.totals.totalConverted += converted;

    const categoryAcc = partnerAcc.byCategory.get(category) || emptyAcc();
    categoryAcc.totalAssigned += assigned;
    categoryAcc.totalConnected += connected;
    categoryAcc.totalConverted += converted;
    partnerAcc.byCategory.set(category, categoryAcc);

    byPartner.set(r.partner, partnerAcc);
  }
  const toFunnelRow = (acc) => ({
    totalAssigned: acc.totalAssigned,
    totalConnected: acc.totalConnected,
    connectedPct: pct(acc.totalConnected, acc.totalAssigned),
    totalConverted: acc.totalConverted,
    convertedPct: pct(acc.totalConverted, acc.totalAssigned),
  });
  return [...byPartner.entries()]
    .map(([deliveryPartner, acc]) => ({
      deliveryPartner,
      ...toFunnelRow(acc.totals),
      reasons: [...acc.byCategory.entries()]
        .map(([rtoReason, categoryAcc]) => ({ rtoReason, ...toFunnelRow(categoryAcc) }))
        .sort((a, b) => b.totalAssigned - a.totalAssigned),
    }))
    .sort((a, b) => b.totalAssigned - a.totalAssigned);
}

// Combines all queries above into the single payload api/report/data/[key].js's
// "calling-overview" route serves - one round trip for the whole Overview tab.
async function getCallingOverviewData(query) {
  const { dateFrom, dateTo, paymentMode } = query || {};
  const [stats, hourly, partnerBreakdown, rtoReasonBreakdown, partnerReasonBreakdown] = await Promise.all([
    getCallingOverviewStats(dateFrom, dateTo),
    getCallingHourlyStats(dateFrom, dateTo),
    getCallingPartnerBreakdown(dateFrom, dateTo),
    getCallingRtoReasonBreakdown(dateFrom, dateTo, paymentMode),
    getCallingPartnerReasonBreakdown(dateFrom, dateTo, paymentMode),
  ]);
  return { stats, hourly, partnerBreakdown, rtoReasonBreakdown, partnerReasonBreakdown };
}

// {order_id: {assignedAt, disposedAt}} for EVERY lead ever assigned, not just a recent window
// like getRecentLeadAssignments (that one exists for the "reset stale pending leads" feature,
// capped at 30 days). The RTO CRM Overview tab's Agent Performance Summary table needs to
// date-filter each column by the REAL date the underlying event happened - assigned_at for
// "Total Leads Assigned"/"Total Prepaid Assigned"/"Total COD Assigned", disposed_at for
// "Total Disposed"/"Total Connected"/"Total Prepaid Connected"/"Total Prepaid Converted"/
// "Total COD Converted" - rather than the lead's own Calling Date/Order Date, which is what
// every other column in this app still uses as a proxy for "when." These two are
// deliberately independent, not one continuous funnel filtered by a single date: a lead
// assigned yesterday and disposed today counts toward TODAY's Disposed/Connected/Converted
// numbers even though it does NOT count toward today's Assigned numbers - "how many did I
// action today" and "how many did I newly receive today" are different questions a call
// centre actually asks. disposedAt is null for a lead not yet disposed (or disposed before
// this Postgres column existed) - the frontend's isLeadDateInScope treats that the same as a
// missing assignedAt: excluded from every date-scoped view except ALL_TIME.
//
// An unbounded read is fine here: this table is bounded by the sheet's own row count (a few
// thousand), the same order of magnitude assign_leads.py already reads whole every 5 minutes.
//
// Reads CLS_RTO_calling WHERE reassigned_away_at IS NULL (the live cycle only), NOT every
// cycle - deliberately the OPPOSITE grain from getCallingOverviewStats' disposed/connected/
// refunded metrics, which read every cycle so a lead's every past attempt still counts toward
// company-wide call-volume KPIs. This function exists purely to decide, for a lead the CLIENT
// is already looking at (allTickets, sourced from the live sheet - which only ever shows the
// CURRENT cycle's state, since a reassignment wipes Q:U for the new agent), which date scope
// that SAME cycle falls into. The table holds one row per cycle (a reassigned lead gets a new
// row rather than an overwrite - see migrate_cls_rto_calling_schema.py), so reading it
// unfiltered here would risk matching an order_id to a RETIRED cycle's dates (whichever row
// happens to come back), not the live one the sheet and this function's caller both mean.
function getAllLeadDates() {
  return cachedRead('calling:leadDates', fetchAllLeadDates);
}

async function fetchAllLeadDates() {
  await ensureSchema();
  const { rows } = await sql`SELECT order_id, assigned_at, disposed_at FROM CLS_RTO_calling WHERE reassigned_away_at IS NULL`;
  const out = {};
  for (const r of rows) out[r.order_id] = { assignedAt: r.assigned_at, disposedAt: r.disposed_at };
  return out;
}

// NDR's own equivalent of getAllLeadDates above, keyed by awb_number (NDR's live-cycle identity
// - see claimNdrLead/disposeNdrLead) rather than order_id. WHERE reassigned_away_at IS NULL for
// the same reason getAllLeadDates filters to the live cycle: only the current cycle's dates
// matter to whatever's on screen right now.
function getAllNdrLeadDates() {
  return cachedRead('calling:ndrLeadDates', fetchAllNdrLeadDates);
}

async function fetchAllNdrLeadDates() {
  await ensurePgSchema();
  const { rows } = await pgSql`
    SELECT awb_number, assigned_at, disposed_at FROM ndr_lead_assignments WHERE reassigned_away_at IS NULL
  `;
  const out = {};
  for (const r of rows) out[r.awb_number] = { assignedAt: r.assigned_at, disposedAt: r.disposed_at };
  return out;
}

// Refund CSV export (Calling Team "Exports" tab) - reads PEP_CLS.refund_all_brands, a table
// fed by GoKwik refund records across every brand storefront (see
// api/refund/gokwik-initiate.js for the refund-INITIATION side of this data; nothing in this
// app writes refund_all_brands itself). See
// docs/superpowers/specs/2026-08-12-refund-export-design.md for the full column/format audit
// this is built from.
//
// created_at/refunded_at are VARCHAR, not real timestamps, and mix two real formats in the
// data - both day-first: 'D/M/YYYY h:mm AM/PM' and 'DD-MM-YYYY HH:MM'. STR_TO_DATE returns
// NULL on a non-matching format rather than erroring, so COALESCE picks whichever pattern
// actually matched a given row.
const REFUND_EXPORT_CREATED_AT_EXPR =
  "COALESCE(STR_TO_DATE(created_at, '%d/%c/%Y %h:%i %p'), STR_TO_DATE(created_at, '%d-%m-%Y %H:%i'))";

const REFUND_EXPORT_BASE_COLUMNS = [
  's_no', 'order_number', 'payment_id', 'platform_order_number', 'rrn_no', 'refund_id',
  'reference_id', 'amount', 'created_at', 'auto_refund', 'refund_type', 'status',
  'is_chargeback', 'chargeback_case_id', 'chargeback_case_status', 'moid', 'initiated_by',
  'refunded_at', 'transaction_payment_id', 'source', 'refund_request_description',
];
// Admin-only - api/refund-export.js decides whether to ask for these from session.isAdmin.
const REFUND_EXPORT_PII_COLUMNS = [
  'customer_name', 'customer_phone', 'customer_email', 'shipping_address', 'billing_address',
];
// Sized from the actual table: measured avg row 438 bytes / true max 1104 bytes across all
// 90k+ rows (all 26 columns) - 10k rows is ~4.4MB expected, safely under Lambda's 6MB response
// ceiling. See the design doc for the full measurement.
const REFUND_EXPORT_MAX_ROWS = 10000;

// Splits a comma-separated query-param value into a trimmed, deduped, non-empty list. ''/null/
// undefined and a value that's only commas/whitespace all mean "no filter on this column".
function splitRefundExportFilterList(value) {
  if (!value) return [];
  const seen = new Set();
  for (const raw of String(value).split(',')) {
    const v = raw.trim();
    if (v) seen.add(v);
  }
  return [...seen];
}

// Builds the WHERE clause + positional params shared by the count and row queries below.
// `from`/`to` must already be validated 'YYYY-MM-DD' strings - validating that shape is
// api/refund-export.js's job, since it's the one place that can return a 400 with a useful
// message; this function only enforces that a range was supplied at all; it has no HTTP
// response to give a caller so callers that skip validation get a plain thrown Error instead.
//
// `to` is compared as the START of the day AFTER `to` (a half-open interval), not
// `<= '<to> 23:59:59'` - a bare `<=` against a literal date string compares against midnight
// and would exclude every row with a nonzero time component, silently turning a same-day
// range (from=to) into zero rows.
function buildRefundExportWhere({ from, to, status, refundType, source }) {
  if (!from || !to) throw new Error('from and to are required');
  const clauses = [
    `${REFUND_EXPORT_CREATED_AT_EXPR} >= ?`,
    `${REFUND_EXPORT_CREATED_AT_EXPR} < DATE_ADD(?, INTERVAL 1 DAY)`,
  ];
  const params = [from, to];

  for (const [column, raw] of [['status', status], ['refund_type', refundType], ['source', source]]) {
    const values = splitRefundExportFilterList(raw);
    if (values.length) {
      clauses.push(`${column} IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    }
  }
  return { where: clauses.join(' AND '), params };
}

async function getRefundExportCount(filters) {
  const { where, params } = buildRefundExportWhere(filters);
  const pool = await getPool();
  const [rows] = await pool.execute(`SELECT COUNT(*) AS n FROM refund_all_brands WHERE ${where}`, params);
  return rows[0].n;
}

// includePii must come from session.isAdmin at the call site (api/refund-export.js) - this
// function trusts its caller completely, same as every other data-fetcher in this file.
async function getRefundExportRows(filters, { includePii } = {}) {
  const { where, params } = buildRefundExportWhere(filters);
  const columns = includePii
    ? [...REFUND_EXPORT_BASE_COLUMNS, ...REFUND_EXPORT_PII_COLUMNS]
    : REFUND_EXPORT_BASE_COLUMNS;
  const columnList = columns.map((c) => `\`${c}\``).join(', ');
  const pool = await getPool();
  // REFUND_EXPORT_MAX_ROWS is a fixed internal constant, never user input - safe to
  // interpolate directly rather than as a bound parameter (mysql2 prepared statements are
  // inconsistent about accepting a placeholder in LIMIT across versions).
  const [rows] = await pool.execute(
    `SELECT ${columnList} FROM refund_all_brands WHERE ${where} ORDER BY ${REFUND_EXPORT_CREATED_AT_EXPR} LIMIT ${REFUND_EXPORT_MAX_ROWS}`,
    params
  );
  return rows;
}

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

const MOM_DEFAULT_STATUSES = [
  { key: 'todo', label: 'To Do', color: '#94a3b8' },
  { key: 'in_progress', label: 'In Progress', color: '#3b82f6' },
  { key: 'done', label: 'Done', color: '#22c55e' },
];

// A single connection wrapped in a MySQL transaction - unlike the `sql` tagged-template
// helper (which checks out a fresh connection from the pool per call, so it cannot span
// multiple statements atomically), this pins one connection for the whole callback so a
// partial failure rolls back instead of leaving, e.g., a board with no owner.
async function withMomTransaction(fn) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

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
  return withMomTransaction(async (conn) => {
    const [result] = await conn.execute(
      'INSERT INTO mom_boards (name, description, created_by) VALUES (?, ?, ?)',
      [name, description || null, email]
    );
    const boardId = result.insertId;
    await conn.execute(
      "INSERT INTO mom_board_members (board_id, email, role) VALUES (?, ?, 'owner')",
      [boardId, email]
    );
    for (let i = 0; i < MOM_DEFAULT_STATUSES.length; i++) {
      const s = MOM_DEFAULT_STATUSES[i];
      await conn.execute(
        'INSERT INTO mom_statuses (board_id, status_key, label, color, position) VALUES (?, ?, ?, ?, ?)',
        [boardId, s.key, s.label, s.color, i]
      );
    }
    return boardId;
  });
}

async function getMomBoardRole(boardId, email) {
  const { rows } = await sql`SELECT role FROM mom_board_members WHERE board_id = ${boardId} AND email = ${email}`;
  return rows[0] ? rows[0].role : null;
}

async function isMomBoardArchived(boardId) {
  const { rows } = await sql`SELECT archived FROM mom_boards WHERE id = ${boardId}`;
  return rows.length ? !!rows[0].archived : null;
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
  if (role !== 'owner') {
    const { rows } = await sql`SELECT email, role FROM mom_board_members WHERE board_id = ${boardId}`;
    const current = rows.find((r) => r.email === email);
    if (current && current.role === 'owner') {
      const otherOwners = rows.filter((r) => r.email !== email && r.role === 'owner');
      if (!otherOwners.length) throw new Error('Cannot demote the last owner of a board');
    }
  }
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
    SELECT board_id AS boardId, title, description, priority, assignee_email AS assigneeEmail, due_date AS dueDate
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
    // Only accept column ids that actually belong to this task's board - a client could
    // otherwise write field values against another board's columns (junk rows, not a read
    // leak, but still not a valid state).
    const { rows: validColumns } = await sql`SELECT id FROM mom_columns WHERE board_id = ${current.boardId}`;
    const validIds = new Set(validColumns.map((c) => String(c.id)));
    const entries = Object.entries(fields.customValues).filter(([columnId]) => validIds.has(String(columnId)));
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
  sql, ensureSchema, CARD_KEYS, CARD_LABELS,
  getUserByEmail, getUserById, getUserPermissions, getUserTabPermissions, setTabPermissions,
  bootstrapAdminIfNeeded, logAccess, logEvent, deleteUser, upsertAgentPresence,
  getAllAgentPresence, getAgentPresenceLogSummary, getAllLeadDates, getAllNdrLeadDates, getRecentLeadAssignments, recordLeadDisposition,
  claimRtoLead, getRtoAgentQuota, getRtoAgentAvailability, getAgentPresenceRow,
  createRtoCsvUploadJob, getRtoCsvUploadJob, updateRtoCsvUploadJob,
  createOrderPunchJob, getOrderPunchJob, failOrderPunchJob, setOrderPunchJobStopRequested,
  getOrderPunchJobRowsForExport, getOrderPunchSettings, upsertOrderPunchSetting,
  getCallingOverviewStats, getCallingHourlyStats, getCallingOverviewData,
  BUSINESS_HOUR_DAYS, getCallingBusinessHours, setCallingBusinessHours,
  CALLING_STATUSES, getCallingProcessAgents, setCallingProcessAgent,
  isCallingProcessAdmin, getAdministeredProcesses,
  getProcessDispositions, addProcessDisposition, updateProcessDisposition,
  deleteProcessDisposition, reorderProcessDispositions,
  claimNdrLead, disposeNdrLead,
  disposeDeliveryEscalationTicket,
  getDeliveryEscalationPage, getDeliveryEscalationStats, getDeliveryEscalationAgents,
  getDeliveryEscalationExport, DELIVERY_ESCALATION_MAX_EXPORT, getDeliveryEscalationRepeatStats,
  getDeliveryEscalationDaywiseStats,
  claimDeliveryEscalationTicketById, disposeDeliveryEscalationTicketById,
  bulkDisposeDeliveryEscalationByAwb,
  REFUND_EXPORT_MAX_ROWS, REFUND_EXPORT_BASE_COLUMNS, REFUND_EXPORT_PII_COLUMNS,
  getRefundExportCount, getRefundExportRows,
  // Exported for api/_lib/db.retry.test.js, db.cache.test.js, db.refundExport.test.js and
  // db.deliveryEscalation.test.js only - nothing in the app calls these directly.
  deWhere, DE_DAYWISE_BUCKET_SQL, DE_DAYWISE_BUCKETS,
  isPoolExhausted, withPgConnectRetry, toTransactionModePooler, cachedRead, invalidateCache, CACHE_TTL_MS,
  buildRefundExportWhere,
  resolveStatusForDeletion,
  getMomBoardsForUser, createMomBoard, getMomBoardRole, isMomBoardArchived, getMomBoardDetail,
  updateMomBoard, archiveMomBoard, upsertMomBoardMember, removeMomBoardMember,
  createMomColumn, getMomColumnBoardId, updateMomColumn, deleteMomColumn,
  createMomStatus, updateMomStatus, deleteMomStatus,
  getMomTasks, getMomTaskBoardId, createMomTask, updateMomTask, deleteMomTask, reorderMomTask,
  getCellComments, saveCellComment,
  // Exported for api/_lib/db.reportCellComments.test.js only - nothing in the app calls this directly.
  shouldDeleteCellComment,
};
