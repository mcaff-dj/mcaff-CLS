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

// RTO CRM operational state (agent_presence, lead_assignments) intentionally stays on
// its own Postgres (Supabase) database, separate from the MySQL PEP_CLS schema above -
// scripts/assign_leads.py and scripts/sync_lead_assignments_to_mysql.py already talk
// to this same Postgres directly via psycopg; only this file's schema bootstrap and
// the handful of functions below need a Postgres connection of their own.
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
  // Records when scripts/assign_leads.py actually assigned each lead (by the sheet's
  // own Order ID). rto-crm.html's "Reset Stale Pending Leads" only had the lead's own
  // Calling Date to judge staleness by, which unassigned leads the moment they were
  // handed out - the backlog assign_leads.py distributes is old by definition, so
  // every fresh assignment looked exactly as "stale" as a genuinely-ignored one. This
  // table lets the reset button tell the two apart. Written by assign_leads.py
  // directly (its own psycopg connection), read by rto-crm.html via a new
  // /api/auth/[action].js?action=recentAssignments endpoint.
  //
  // One row per ASSIGNMENT CYCLE (surrogate `id` PK), not one per order_id: a lead handed
  // to a second agent after a Connected=No gets a brand new row, and the first agent's row
  // is kept - stamped reassigned_away_at - instead of being overwritten. That's what lets
  // this one table replace what used to be two (this, plus a lead_reassignment_attempts
  // side-table holding just (order_id, email) per failed attempt): they were always the
  // same fact - "which agent held this lead, when, and how it turned out" - and keeping the
  // real row rather than a bare marker means each past attempt retains its own
  // disposition/connected/disposed_at instead of throwing that away on reassignment (the
  // old upsert did throw it away, which is also why a reassigned lead used to keep its
  // previous agent's stale disposition in Postgres - fixed as a side effect here).
  //
  // reassigned_away_at IS NULL means "this is the cycle that is live right now", and the
  // partial unique index below enforces at most one such row per order_id - so this table
  // still has a single, well-defined current row per lead, exactly like the old
  // order_id PRIMARY KEY guaranteed. lead_assignments_current (further down) is that set.
  await pgSql`
    CREATE TABLE IF NOT EXISTS lead_assignments (
      id BIGSERIAL PRIMARY KEY,
      order_id TEXT NOT NULL,
      email TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  // When this lead was taken away from the agent in this row (NULL = still theirs). A
  // timestamp rather than a boolean because it strictly supersedes what the old
  // lead_reassignment_attempts row recorded: that table's own assigned_at was stamped
  // now() at reassignment time, i.e. it was really "when the attempt ended". Keeping both
  // means a row now carries the true original assigned_at AND when it was handed on.
  await pgSql`ALTER TABLE lead_assignments ADD COLUMN IF NOT EXISTS reassigned_away_at TIMESTAMPTZ`;
  // Plain (non-unique) index for whole-history lookups by lead - assign_leads.py's
  // fetch_reassignment_attempts scans every reassigned_away_at row to build its
  // "who has already failed on this lead" exclusion set.
  await pgSql`CREATE INDEX IF NOT EXISTS lead_assignments_order_id_idx ON lead_assignments (order_id)`;
  // One-time migration from the pre-merge shape (PRIMARY KEY(order_id), one row per lead)
  // to the per-cycle shape above. The cheap pre-check here is only an optimization so the
  // overwhelmingly common case - already migrated - never even opens a dedicated
  // connection; the authoritative guard is the re-check under the lock inside.
  //
  // Right after this ships, several Lambda instances can cold-start at once and all reach
  // this line before any has migrated. So the whole thing runs as ONE transaction that
  // takes an advisory lock FIRST and only then re-checks and issues DDL: losers block on
  // the lock, then see `id` already present and return having changed nothing. Taking the
  // lock before any DDL is the important part - an earlier draft of this ran DROP
  // CONSTRAINT IF EXISTS lead_assignments_pkey before re-checking, which on the losing
  // instance would have dropped the NEW primary key (ADD COLUMN id BIGSERIAL PRIMARY KEY
  // names its constraint lead_assignments_pkey too) and then committed that. Being one
  // transaction also means a mid-way failure rolls back whole, rather than leaving a
  // half-migrated table no retry could cleanly finish.
  //
  // THIS BLOCK IS A FALLBACK, not the intended path. The migration is meant to be applied by
  // hand before deploying, via
  // scripts/migrations/2026-07-30_merge_reassignment_attempts_into_lead_assignments.sql -
  // which does exactly what this does, with preflight checks and verification queries. Two
  // reasons that ordering matters:
  //   - ADD COLUMN id BIGSERIAL PRIMARY KEY rewrites the whole table. On a request-path cold
  //     start that can be slow enough to threaten the triggering request's own timeout.
  //   - scripts/assign_leads.py and scripts/sync_lead_assignments_to_mysql.py reach Postgres
  //     directly and never call this function, so between the Python shipping and the first
  //     Lambda cold start they would reference reassigned_away_at / lead_assignments_current
  //     before either exists. The assign-leads cron runs every 5 minutes, so that window is
  //     narrow but real.
  // Migrating first closes both: this block then finds `id` present and skips.
  const { rows: idColRows } = await pgSql`
    SELECT 1 FROM information_schema.columns WHERE table_name = 'lead_assignments' AND column_name = 'id'
  `;
  if (idColRows.length === 0) {
    await withPgTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('lead_assignments_cycle_migration'))");
      const { rows: recheck } = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'lead_assignments' AND column_name = 'id'"
      );
      if (recheck.length > 0) return; // another instance migrated while we waited for the lock
      // Look the existing PK's name up rather than assuming Postgres's default
      // 'lead_assignments_pkey', same as the hand-run migration does.
      const { rows: pkRows } = await client.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'lead_assignments'::regclass AND contype = 'p'`
      );
      if (pkRows.length === 0) throw new Error('lead_assignments has no primary key - unexpected shape, refusing to migrate');
      await client.query(`ALTER TABLE lead_assignments DROP CONSTRAINT "${pkRows[0].conname}"`);
      await client.query('ALTER TABLE lead_assignments ADD COLUMN id BIGSERIAL PRIMARY KEY');
      // awb_code's unique index is becoming PARTIAL (see its own comment below). Recreating
      // it needs the old table-wide one gone first, and CREATE UNIQUE INDEX IF NOT EXISTS
      // matches on index NAME alone - it would happily leave the old, now-wrong definition
      // in place - so drop it here and let the create further down rebuild it correctly.
      await client.query('DROP INDEX IF EXISTS lead_assignments_awb_code_key');
      // Fold the retired side-table in. Each of its rows is one past failed attempt, and
      // all it knew was (order_id, email, when it was logged) - so assigned_at and
      // reassigned_away_at both take that single timestamp: the honest statement that this
      // attempt is over, without inventing a start time it never recorded.
      //
      // RENAMED, not dropped - identical to what the hand-run migration does (see
      // scripts/migrations/2026-07-30_merge_reassignment_attempts_into_lead_assignments.sql),
      // so neither path can destroy the only copy of this history if the fold turns out to
      // have been wrong. Drop the leftover by hand once you're satisfied.
      const { rows: oldTableRows } = await client.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'lead_reassignment_attempts'"
      );
      if (oldTableRows.length > 0) {
        await client.query(
          `INSERT INTO lead_assignments (order_id, email, assigned_at, reassigned_away_at)
           SELECT order_id, email, assigned_at, assigned_at FROM lead_reassignment_attempts`
        );
        await client.query(
          'ALTER TABLE lead_reassignment_attempts RENAME TO lead_reassignment_attempts_premerge_20260730'
        );
      }
    });
  }
  // At most one live cycle per lead - the invariant the old order_id PRIMARY KEY provided,
  // re-expressed so past cycles can coexist. Both write paths (assign_leads.py's
  // record_lead_assignments and recordLeadDisposition below) target this index with ON
  // CONFLICT, so each still gets a single atomic upsert against "the current row for this
  // lead", with no read-then-write race to guard - the same guarantee they had when
  // order_id was the primary key.
  await pgSql`CREATE UNIQUE INDEX IF NOT EXISTS lead_assignments_order_id_current_key ON lead_assignments (order_id) WHERE reassigned_away_at IS NULL`;
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
  // Disposal side of the same lead lifecycle - written by rto-crm.html's submitDisp()
  // in real time (via a new recordDisposition auth action) alongside its existing
  // direct-to-Sheet write, so this history survives independent of the Google Sheet
  // (e.g. for reporting) and doesn't require re-scanning the sheet to reconstruct.
  await pgSql`ALTER TABLE lead_assignments ADD COLUMN IF NOT EXISTS disposed_at TIMESTAMPTZ`;
  await pgSql`ALTER TABLE lead_assignments ADD COLUMN IF NOT EXISTS disposition TEXT`;
  await pgSql`ALTER TABLE lead_assignments ADD COLUMN IF NOT EXISTS agent_remarks TEXT`;
  await pgSql`ALTER TABLE lead_assignments ADD COLUMN IF NOT EXISTS connected TEXT`;
  await pgSql`ALTER TABLE lead_assignments ADD COLUMN IF NOT EXISTS attempt TEXT`;
  await pgSql`ALTER TABLE lead_assignments ADD COLUMN IF NOT EXISTS refund_amount NUMERIC`;
  // AWB Code (sheet column G) - unique per lead (see scripts/lead_priority.py's
  // COL_AWB_CODE), written by both assign_leads.py's assignment INSERT and
  // recordLeadDisposition below, so it's present regardless of which path first
  // creates the row. A unique index (not a plain UNIQUE constraint, so this stays
  // idempotent via IF NOT EXISTS) - Postgres already treats multiple NULLs as
  // distinct, so leads created before this column existed don't block real ones.
  //
  // Partial (WHERE reassigned_away_at IS NULL), matching the order_id index above: a
  // reassignment leaves the old cycle's row in place carrying the SAME awb_code (one
  // physical shipment, successive agents), so a table-wide unique index would reject the
  // new cycle outright. Restricting it to live cycles lets a lead's own history repeat its
  // AWB while still enforcing what this index is actually for - one AWB never belonging to
  // two different live leads at once.
  await pgSql`ALTER TABLE lead_assignments ADD COLUMN IF NOT EXISTS awb_code TEXT`;
  await pgSql`CREATE UNIQUE INDEX IF NOT EXISTS lead_assignments_awb_code_key ON lead_assignments (awb_code) WHERE reassigned_away_at IS NULL`;
  await pgSql`ALTER TABLE lead_assignments ADD COLUMN IF NOT EXISTS rto_reason TEXT`;
  // Replacement order ID (sheet column V) - lets "reordered" be computed the same way
  // the RTO-CRM UI itself already defines it (see reordersConverted in
  // app/rto-crm/RtoCrmClient.js) directly from Postgres, without re-deriving it from
  // disposition text alone. Only populated going forward; leads disposed before this
  // column existed have it NULL even if they were genuinely reorders.
  await pgSql`ALTER TABLE lead_assignments ADD COLUMN IF NOT EXISTS new_order_id TEXT`;
  // Delivery partner, derived from awb_code via the same AWB-prefix rule already used
  // in scripts/lead_priority.py's prefix_rule_partner (SF->Shadowfax, MC->ElasticRun,
  // etc. - see resolvePartnerFromAwb below for the JS mirror). Plain column, populated
  // explicitly at write time (recordLeadDisposition below, and assign_leads.py's own
  // Postgres write) the same way awb_code itself already is, rather than a generated
  // column - both writers already know the AWB when they write, so there's no reason
  // to make Postgres re-derive it on every read.
  await pgSql`ALTER TABLE lead_assignments ADD COLUMN IF NOT EXISTS delivery_partner TEXT`;
  // The live cycle of every lead - i.e. exactly what lead_assignments itself held back when
  // order_id was its primary key. Every reader whose question is about a lead's CURRENT
  // state (is it assigned, to whom, still pending?) selects from this rather than the base
  // table; readers counting CALL OUTCOMES stay on the base table so earlier attempts on
  // reassigned leads keep counting (see getCallingOverviewStats for which is which).
  //
  // No DISTINCT ON / ORDER BY needed to pick a winner: lead_assignments_order_id_current_key
  // already guarantees at most one row per order_id here.
  //
  // CREATE OR REPLACE (not DROP + CREATE) so this swaps atomically under live readers.
  // Deliberately placed after every ALTER TABLE ADD COLUMN above, so `*` picks up the full
  // column set - Postgres permits CREATE OR REPLACE VIEW to append columns, which is what
  // makes re-running this after a future column is added a no-op rather than an error.
  await pgSql`
    CREATE OR REPLACE VIEW lead_assignments_current AS
    SELECT * FROM lead_assignments WHERE reassigned_away_at IS NULL
  `;
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
  // NDR Calling's own assignment/disposition history - the same role lead_assignments plays
  // for RTO, but deliberately a SEPARATE table (not a shared/generic one): NDR has no
  // reassignment/connected/refund workflow yet, so this only carries the shape actually used
  // today. Parallel write alongside the Google Sheet (scripts/assign_ndr_leads.py's Q:R,
  // the Call modal's S:U in app/rto-crm/RtoCrmClient.js) - the sheet stays what the UI reads
  // from; this is the durable/queryable history side, same relationship RTO's own sheet
  // Column Q + lead_assignments already have. reassigned_away_at exists for the same
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
  // At most one live cycle per awb - same partial-unique-index pattern as RTO's
  // lead_assignments_order_id_current_key, so claimNdrLead's ON CONFLICT below has a real
  // arbiter to target.
  await pgSql`CREATE UNIQUE INDEX IF NOT EXISTS ndr_lead_assignments_awb_current_key ON ndr_lead_assignments (awb_number) WHERE reassigned_away_at IS NULL`;
  // Escalation desk's own assignment/resolution history - the same role lead_assignments
  // plays for RTO and ndr_lead_assignments for NDR. Deliberately keyed by parent_order
  // (HYP_Parent_OrderID), NOT a Sheet/ticket row number: a row number shifts whenever its
  // source table is re-sorted or re-synced, while parent_order is the same stable key
  // getEscalationOrderIndex (this file) already matches CSV-import rows on. Written
  // directly from api/escalation/[action].js's assign/update/bulk-update actions (there is no
  // cron equivalent of assign_leads.py for this desk - assignment here is always an admin/
  // agent clicking something in the UI), replacing the old non-durable in-memory
  // assignmentMap that lost every assignment on a Lambda cold start.
  await pgSql`
    CREATE TABLE IF NOT EXISTS escalation_lead_assignments (
      id BIGSERIAL PRIMARY KEY,
      parent_order TEXT NOT NULL,
      email TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reassigned_away_at TIMESTAMPTZ,
      last_updated_at TIMESTAMPTZ,
      resolution TEXT,
      agent_remarks TEXT
    )
  `;
  // Rename resolved_at → last_updated_at on existing deployments (new installs use the name above).
  const { rows: renameCheck } = await pgSql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'escalation_lead_assignments' AND column_name = 'resolved_at'
  `;
  if (renameCheck.length > 0) {
    await pgSql`ALTER TABLE escalation_lead_assignments RENAME COLUMN resolved_at TO last_updated_at`;
  }
  // At most one live cycle per order - same partial-unique-index pattern as RTO's
  // lead_assignments_order_id_current_key and NDR's ndr_lead_assignments_awb_current_key.
  // "Live" means neither reassigned nor resolved - reassigned_away_at IS NULL AND
  // last_updated_at IS NULL - so a fresh re-escalation after resolution gets a new row, not
  // a silent conflict with the old one. Checked via pg_indexes first (not a bare
  // DROP+CREATE) so this is a true no-op after the first run, same as every other
  // statement here - an unconditional DROP+CREATE on every cold start would instead leave
  // a brief window on EVERY container start where the index doesn't exist, and a
  // concurrent assignEscalationOrder insert landing in that window would fail with
  // Postgres error 42P10 (no arbiter for its ON CONFLICT target).
  const { rows: escIdxRows } = await pgSql`
    SELECT indexdef FROM pg_indexes WHERE indexname = 'escalation_lead_assignments_parent_order_current_key'
  `;
  if (escIdxRows.length === 0 || !escIdxRows[0].indexdef.includes('last_updated_at IS NULL')) {
    await pgSql`DROP INDEX IF EXISTS escalation_lead_assignments_parent_order_current_key`;
    await pgSql`CREATE UNIQUE INDEX IF NOT EXISTS escalation_lead_assignments_parent_order_current_key ON escalation_lead_assignments (parent_order) WHERE reassigned_away_at IS NULL AND last_updated_at IS NULL`;
  }
  // Resolution's replacement-order fields, added for the BigQuery/Postgres hybrid migration
  // (docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md) - `resolution`
  // and `agent_remarks` already existed (status/notes' Postgres mirror); only the replacement
  // order id and AWB were sheet-only (columns T/U) until now.
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS new_order_id TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS new_awb TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`;
  // tat_to_resolve holds the BUCKET LABEL ("Within 48 hrs", "4-8 days", ...), reproducing the
  // Google Sheet's own IF-ladder now that the sheet is no longer the source of truth. The raw day
  // count keeps its own numeric column, tat_days - the label is derived from it, so storing only
  // the label would throw away the number every average/threshold question needs.
  //
  // Existing deployments have tat_to_resolve as the NUMERIC column: rename it to tat_days (the
  // data is the day count, so this preserves it) before the label column claims the name. Checked
  // against information_schema rather than attempted blindly, same pattern as the
  // resolved_at -> last_updated_at rename above.
  const { rows: tatNumeric } = await pgSql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'escalation_lead_assignments'
      AND column_name = 'tat_to_resolve' AND data_type = 'numeric'
  `;
  if (tatNumeric.length > 0) {
    await pgSql`ALTER TABLE escalation_lead_assignments RENAME COLUMN tat_to_resolve TO tat_days`;
  }
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS tat_days NUMERIC`;
  // GENERATED ... STORED, not a column the app writes: the bucket is a pure function of
  // delivered_at and assigned_at, so Postgres recomputing it on every write is one less thing that
  // can drift (a hand-written label would go stale the moment either timestamp is corrected, and
  // every future writer would have to remember the ladder). Both operands are immutable, which is
  // what makes them legal in a generated expression - now() would not be.
  //
  // delivered_at is only stamped for resolution = 'Delivered' (see resolveEscalationAssignment),
  // so an order resolved as Reshipped/Cancelled/Lost reads 'unresolved' here. That follows the
  // "bucket by delivered_at" rule as asked - COALESCE(delivered_at, last_updated_at) would instead
  // bucket every resolution by when it was resolved.
  await pgSql`
    ALTER TABLE escalation_lead_assignments
    ADD COLUMN IF NOT EXISTS tat_to_resolve TEXT GENERATED ALWAYS AS (
      CASE
        WHEN delivered_at IS NULL THEN 'unresolved'
        WHEN EXTRACT(EPOCH FROM (delivered_at - assigned_at)) / 86400.0 <= 2  THEN 'Within 48 hrs'
        WHEN EXTRACT(EPOCH FROM (delivered_at - assigned_at)) / 86400.0 <= 4  THEN 'Within 2-4 days'
        WHEN EXTRACT(EPOCH FROM (delivered_at - assigned_at)) / 86400.0 <= 8  THEN '4-8 days'
        WHEN EXTRACT(EPOCH FROM (delivered_at - assigned_at)) / 86400.0 <= 10 THEN '8-10 days'
        ELSE 'Greater than 10 days'
      END
    ) STORED
  `;
  // email becomes nullable: resolveEscalationAssignment now INSERTs a row for orders resolved
  // without ever being assigned (see that function below) - such a row genuinely has no agent.
  await pgSql`ALTER TABLE escalation_lead_assignments ALTER COLUMN email DROP NOT NULL`;
  // Ticket data for the Escalation desk, merged directly onto escalation_lead_assignments
  // instead of a separate escalation_tickets table (that table's LEFT JOIN was never actually
  // wired into getEscalationOrders - these columns went unread). Populated by
  // scripts/sync_delivery_tickets_to_pg.py, upserted every 2h onto each order's live row (see
  // that script for the update-live-row-else-insert logic), not written by the app itself.
  // Date-shaped columns stay TEXT - they're display-formatted strings
  // (sync_delivery_tickets_to_sheet.py's build_sheet_row), not real timestamps. One order can
  // have multiple MySQL tickets over time; only the most-recently-synced ticket's fields survive
  // on the shared live row (last-synced-ticket-wins), matching this table's existing
  // one-live-row-per-order shape.
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS brand TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS ticket_number TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS awb_number TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS added_date TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS query_class TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS query_category TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS delivery_partner_name TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS order_date TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS order_month TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS query_date TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS query_month TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS wh_name TEXT`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS total_times_user_reached INTEGER`;
  await pgSql`ALTER TABLE escalation_lead_assignments ADD COLUMN IF NOT EXISTS ticket_loaded_at TIMESTAMPTZ`;
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

const CARD_KEYS = ['mcaffeine', 'hyphen', 'productkyc', 'mom', 'calling', 'onboarding', 'deepdive', 'orgoverview'];
const CARD_LABELS = {
  mcaffeine: 'mCaffeine', hyphen: 'Hyphen', productkyc: 'Product Calling KYC',
  mom: 'MOM', calling: 'Calling Team', onboarding: 'Onboarding Test', deepdive: 'Deep Dive',
  orgoverview: 'Org Overview',
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
  await ensurePgSchema();
  const { rows: prevRows } = await pgSql`SELECT status FROM agent_presence WHERE email = ${email}`;
  const prevStatus = prevRows[0]?.status;
  await pgSql`
    INSERT INTO agent_presence (email, name, status, updated_at)
    VALUES (${email}, ${name}, ${status}, now())
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now()
  `;
  // Only log an actual transition (including an agent's very first report), not every
  // periodic heartbeat re-sending the same status - see agent_presence_log's comment.
  if (prevStatus !== status) {
    await pgSql`INSERT INTO agent_presence_log (email, name, status, changed_at) VALUES (${email}, ${name}, ${status}, now())`;
  }
}

// Returns every agent's last-reported status, keyed by lowercase email - lets the
// roster table (rto-crm.html) show each agent's real Postgres-backed presence
// instead of the mock/local status it falls back to before anyone's ever reported in.
async function getAllAgentPresence() {
  await ensurePgSchema();
  const { rows } = await pgSql`SELECT email, name, status, updated_at FROM agent_presence`;
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
  await ensurePgSchema();
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
    ({ rows: priorRows } = await pgSql`
      SELECT DISTINCT ON (email) email, status
      FROM agent_presence_log
      WHERE changed_at < ${from}
      ORDER BY email, changed_at DESC
    `);
  }
  const { rows: rangeRows } = await pgSql`
    SELECT email, status, changed_at
    FROM agent_presence_log
    WHERE (${from}::timestamptz IS NULL OR changed_at >= ${from}) AND changed_at <= ${rangeEnd}
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
  await ensurePgSchema();
  const { rows } = await pgSql`
    SELECT order_id, assigned_at FROM lead_assignments_current
    WHERE assigned_at >= now() - make_interval(hours => ${sinceHours})
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
// reassigned_away_at IS NULL - which is why the conflict target names that partial index's
// predicate (see lead_assignments_order_id_current_key in ensurePgSchema). Still one atomic
// statement, exactly as when order_id was the primary key: Postgres resolves
// insert-or-update under the index itself, so concurrent disposals of the same lead (a
// double-submit, say) serialize on their own rather than needing a lock around a
// read-then-write.
//
// Naming the live cycle is what keeps this an in-place update of the row the agent is
// actually working, rather than appending a second live row per disposal - which would
// collide with lead_assignments_awb_code_key, since a lead's successive rows carry the same
// AWB.
//
// Note it updates whichever row is live for this order_id, not specifically the calling
// agent's. So a disposal arriving from an agent the lead has ALREADY been reassigned away
// from writes onto the new agent's cycle. That is pre-existing behavior (when order_id was
// the primary key there was only ever one row to upsert onto, with the same outcome) and is
// left alone deliberately: the fix would be to condition DO UPDATE on the stored email
// matching the caller's, and any drift between the sheet's Column Q and the session email -
// case, whitespace, an alias address - would then silently discard legitimate disposals,
// which is far worse than the narrow case it guards. Reaching it needs a stale tab: once
// reassigned, the sheet no longer lists the lead under the old agent.
//
// If assign_leads.py never recorded this order_id (assigned before lead_assignments
// existed, or assigned manually straight in the sheet), the INSERT branch creates the row
// now with the disposing agent's own email as assigned_at's best-available attribution,
// rather than dropping the disposal details on the floor.
//
// awbCode/delivery_partner use COALESCE on conflict rather than overwriting, so a
// disposal call without an AWB (e.g. an older cached client) never clobbers what
// assign_leads.py already stamped for this order_id.
//
// rto_reason/delivery_partner can end up NULL from the original assignment (sheet's RTO
// Reason cell was still blank then, or the AWB's prefix wasn't in AWB_PREFIX_RULES yet).
// The client always has the sheet's current values by the time an agent disposes
// (RtoCrmClient.js's dispTkt.rtoReason/awbCode), so this is a second chance to fill them
// in - but only the gaps: rto_reason prefers whatever's already stored (COALESCE(existing,
// new)) since it shouldn't legitimately change once set, while delivery_partner keeps its
// existing "recompute every time" behavior (COALESCE(new, existing)) since
// resolvePartnerFromAwb is deterministic from the AWB alone.
async function recordLeadDisposition(orderId, email, awbCode, details) {
  await ensurePgSchema();
  const { disposition, agentRemarks, connected, attempt, refundAmount, newOrderId, rtoReason } = details || {};
  const deliveryPartner = resolvePartnerFromAwb(awbCode);
  await pgSql`
    INSERT INTO lead_assignments (order_id, email, assigned_at, disposed_at, disposition, agent_remarks, connected, attempt, refund_amount, awb_code, new_order_id, rto_reason, delivery_partner)
    VALUES (${orderId}, ${email}, now(), now(), ${disposition || null}, ${agentRemarks || null}, ${connected || null}, ${attempt || null}, ${refundAmount || null}, ${awbCode || null}, ${newOrderId || null}, ${rtoReason || null}, ${deliveryPartner})
    ON CONFLICT (order_id) WHERE reassigned_away_at IS NULL DO UPDATE SET
      disposed_at = now(),
      disposition = EXCLUDED.disposition,
      agent_remarks = EXCLUDED.agent_remarks,
      connected = EXCLUDED.connected,
      attempt = EXCLUDED.attempt,
      refund_amount = EXCLUDED.refund_amount,
      awb_code = COALESCE(EXCLUDED.awb_code, lead_assignments.awb_code),
      new_order_id = COALESCE(EXCLUDED.new_order_id, lead_assignments.new_order_id),
      rto_reason = COALESCE(lead_assignments.rto_reason, EXCLUDED.rto_reason),
      delivery_partner = COALESCE(EXCLUDED.delivery_partner, lead_assignments.delivery_partner)
  `;
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
}

// Escalation's own equivalent of claimNdrLead, but explicit about reassignment: closes any
// OTHER agent's currently-live row for this order before opening a new one, so history is
// preserved (matches RTO/NDR's "reassigned_away_at, not overwritten" cycle model) rather than
// silently mutating email in place. A no-op re-assign to the SAME agent (e.g. re-saving the
// dropdown without changing it) touches nothing, same ON CONFLICT DO NOTHING safety claimNdrLead
// relies on. "Live" means neither reassigned nor resolved (reassigned_away_at IS NULL AND
// last_updated_at IS NULL), so a fresh assignment after resolution starts a new cycle.
async function assignEscalationOrder(parentOrder, email) {
  await ensurePgSchema();
  await pgSql`
    UPDATE escalation_lead_assignments
    SET reassigned_away_at = now()
    WHERE parent_order = ${parentOrder} AND reassigned_away_at IS NULL AND last_updated_at IS NULL AND email <> ${email}
  `;
  await pgSql`
    INSERT INTO escalation_lead_assignments (parent_order, email)
    VALUES (${parentOrder}, ${email})
    ON CONFLICT (parent_order) WHERE reassigned_away_at IS NULL AND last_updated_at IS NULL DO NOTHING
  `;
}

// Clears an order's live assignment (the queue table's "Clear assignment" action) without
// assigning it to anyone new - closes the live cycle, leaving its history intact. Only touches
// unresolved rows (resolved rows are already closed and shouldn't be touched).
async function unassignEscalationOrder(parentOrder) {
  await ensurePgSchema();
  await pgSql`
    UPDATE escalation_lead_assignments
    SET reassigned_away_at = now()
    WHERE parent_order = ${parentOrder} AND reassigned_away_at IS NULL AND last_updated_at IS NULL
  `;
}

// Stamps a resolution onto the SAME row this order already has - same relationship
// disposeNdrLead has to claimNdrLead. Prefers the live row (reassigned_away_at IS NULL AND
// last_updated_at IS NULL, guaranteed unique by the partial index); if this order's live cycle
// already got closed out from under it (reassigned away, or already resolved by an earlier call -
// re-import, a double-submit, whatever), falls back to the most recently assigned row for this
// parent_order instead of leaving it untouched. Without that fallback, resolving a non-live order
// used to fall straight through to the cold-insert branch below and spawn a second, email-less,
// disconnected row for an order that already had one - duplicating history instead of updating it.
// Only actually inserts when NO row exists for this parent_order at all (both subqueries NULL).
// Silently a no-op if the order was never assigned to anyone (WHERE matches zero rows) - resolving
// an unassigned order still writes to the sheet (the desk's real source of truth) via
// updateOrder/batchUpdateOrders; this table is only the durable history side, so having nothing to
// update here is not an error.
// Writes tat_days (the raw day count) and never tat_to_resolve - that one is a generated column
// holding the bucket label, which Postgres recomputes from delivered_at/assigned_at on this same
// write. Assigning to it would be an error, not a no-op.
async function resolveEscalationAssignment(parentOrder, resolution, agentRemarks, newOrderId, newAwb) {
  await ensurePgSchema();
  // pgSql only ever returns `{ rows }` (see its definition above) - RETURNING lets an UPDATE
  // still report whether it matched anything, without needing pgSql to expose rowCount.
  const { rows } = await pgSql`
    UPDATE escalation_lead_assignments
    SET last_updated_at = now(),
        resolution = ${resolution || null}, agent_remarks = ${agentRemarks || null},
        new_order_id = ${newOrderId || null}, new_awb = ${newAwb || null},
        delivered_at = CASE WHEN ${resolution} = 'Delivered' THEN now() ELSE delivered_at END,
        tat_days = EXTRACT(EPOCH FROM (now() - assigned_at)) / 86400.0
    WHERE id = COALESCE(
      (SELECT id FROM escalation_lead_assignments
        WHERE parent_order = ${parentOrder} AND reassigned_away_at IS NULL AND last_updated_at IS NULL LIMIT 1),
      (SELECT id FROM escalation_lead_assignments
        WHERE parent_order = ${parentOrder} ORDER BY assigned_at DESC LIMIT 1)
    )
    RETURNING parent_order
  `;
  if (rows.length === 0) {
    // No live row to update - this order was resolved without ever being assigned. Insert a
    // standalone resolved row (email NULL) so it's still durably recorded; without this, an
    // order resolved cold would look unresolved forever once Postgres is the read source.
    const deliveredAt = resolution === 'Delivered' ? new Date() : null;
    await pgSql`
      INSERT INTO escalation_lead_assignments
        (parent_order, email, last_updated_at, resolution, agent_remarks, new_order_id, new_awb,
         delivered_at)
      VALUES (${parentOrder}, NULL, now(), ${resolution || null}, ${agentRemarks || null},
              ${newOrderId || null}, ${newAwb || null}, ${deliveredAt})
    `;
  }
}

// bulk-update's own equivalent of resolveEscalationAssignment, for many orders sharing the
// SAME resolution/remarks in one call (that's what a bulk action means) - one UPDATE ...
// WHERE parent_order = ANY(...) instead of N round-trips for what is logically one operation.
async function resolveEscalationAssignmentsBulk(parentOrders, resolution) {
  await ensurePgSchema();
  if (!parentOrders.length) return;
  await pgSql`
    UPDATE escalation_lead_assignments
    SET last_updated_at = now(), resolution = ${resolution || null},
        delivered_at = CASE WHEN ${resolution} = 'Delivered' THEN now() ELSE delivered_at END,
        tat_days = EXTRACT(EPOCH FROM (now() - assigned_at)) / 86400.0
    WHERE parent_order = ANY(${parentOrders}::text[]) AND reassigned_away_at IS NULL AND last_updated_at IS NULL
  `;
}

// Full history, newest first. No date filtering here on purpose: "assigned this week" and
// "resolved this week" are different questions about different timestamps on the same table
// (same reasoning as getCallingOverviewStats' own per-metric date scoping above) - a single
// WHERE clause on one timestamp would silently miscount whichever metric doesn't share it.
// Callers that need date-scoped metrics (AssignmentsPanel) filter each metric by its own
// timestamp client-side instead. Also doubles as the read side of the live assignment map
// (api/escalation/[action].js's assign GET filters this down to rows with neither
// reassignedAwayAt nor resolvedAt set).
// LIMIT is a soft ceiling, not a real solution for unbounded growth - if this desk's history
// ever exceeds 5000 rows, add either pagination to the Assignments UI or a date-range param
// here (getLiveEscalationAssignments below covers the actually-common "who's live right now"
// case without touching history size at all).
async function getEscalationAssignments() {
  await ensurePgSchema();
  const { rows } = await pgSql`
    SELECT parent_order, email, assigned_at, reassigned_away_at, last_updated_at, resolution, agent_remarks,
           new_order_id, new_awb, delivered_at, tat_days, tat_to_resolve
    FROM escalation_lead_assignments
    ORDER BY assigned_at DESC
    LIMIT 5000
  `;
  return rows.map((r) => ({
    parentOrder: r.parent_order,
    email: r.email,
    assignedAt: r.assigned_at,
    reassignedAwayAt: r.reassigned_away_at,
    lastUpdatedAt: r.last_updated_at,
    resolution: r.resolution,
    agentRemarks: r.agent_remarks,
    newOrderId: r.new_order_id,
    newAwb: r.new_awb,
    deliveredAt: r.delivered_at,
    tatDays: r.tat_days,
    // The bucket label, not a number - see the generated column in bootstrapPgSchema.
    tatToResolve: r.tat_to_resolve,
  }));
}

// The live-only subset of the above, for callers that just need "who's assigned right now"
// (the assign GET action) - reading only rows the partial unique index already guarantees are
// few (at most one per parent_order), instead of the full ever-growing history.
async function getLiveEscalationAssignments() {
  await ensurePgSchema();
  const { rows } = await pgSql`
    SELECT parent_order, email FROM escalation_lead_assignments
    WHERE reassigned_away_at IS NULL AND last_updated_at IS NULL
  `;
  return rows.map((r) => ({ parentOrder: r.parent_order, email: r.email }));
}

// Escalation desk's read path - one query, replacing what used to be a BigQuery query plus a
// JavaScript-side merge against getEscalationAssignments (two systems, because ticket data and
// resolution data used to live in different databases; now they're both here). The LATERAL
// join picks the single most-recent assignment row per order (highest assigned_at) - the same
// "most recent wins" rule the old JS Map-based merge applied by keeping the first-seen row from
// an assigned_at DESC list. The last_updated_at IS NULL predicate drops already-resolved orders,
// and sits OUTSIDE the DISTINCT ON - inside it, an order whose latest cycle is resolved would be
// resurrected by an older unresolved cycle, since DISTINCT ON would then pick the most recent of
// only the surviving rows. An order never assigned still passes (its columns are NULL). No
// predicate beyond that - RTO Queue and Fresh Leads both return the same pending rows;
// brand/tab-specific filtering rules are a follow-up, not implemented here.
//
// Capped, and returns { orders, total } rather than a bare array. Restoring the pending filter
// above was not on its own enough to keep this response under Lambda's 6MB limit: the ticket sync
// (scripts/sync_delivery_tickets_to_pg.py) inserts a LIVE row per order, so nearly every row in
// the table is pending and the filter removes far less than it looks like it should. Past the
// limit Lambda never gets to return at all - API Gateway substitutes its own opaque
// {"message":"Internal server error"}, which is what the desk showed as "Failed to load". `total`
// is the true unfiltered pending count, so a truncated response is visible to the caller (the
// client shows a banner) instead of silently looking like the whole queue.
const ESCALATION_ORDERS_LIMIT = 2000;

async function getEscalationOrders(limit = ESCALATION_ORDERS_LIMIT) {
  await ensurePgSchema();
  // Newest cycles first, so a truncated response keeps the orders most likely to still need
  // action rather than an arbitrary slice.
  const { rows } = await pgSql`
    SELECT * FROM (
      SELECT DISTINCT ON (parent_order)
        parent_order, email, resolution, agent_remarks, new_order_id, new_awb, last_updated_at,
        assigned_at, brand, ticket_number, awb_number, added_date, query_class, query_category,
        delivery_partner_name, order_date, order_month, query_date, query_month, wh_name,
        total_times_user_reached
      FROM escalation_lead_assignments
      ORDER BY parent_order, assigned_at DESC
    ) latest
    WHERE last_updated_at IS NULL
    ORDER BY assigned_at DESC
    LIMIT ${limit}
  `;
  // Counted over the same DISTINCT ON set, not over raw rows - one order with five past cycles is
  // one pending order, and a count that disagreed with the list would make the banner nonsense.
  const { rows: countRows } = await pgSql`
    SELECT count(*)::int AS total FROM (
      SELECT DISTINCT ON (parent_order) parent_order, last_updated_at
      FROM escalation_lead_assignments
      ORDER BY parent_order, assigned_at DESC
    ) latest
    WHERE last_updated_at IS NULL
  `;
  const orders = rows.map((r) => ({
    brand: r.brand || '',
    parentOrder: r.parent_order || '',
    awbNumber: r.awb_number || '',
    addedDate: r.added_date || '',
    queryClass: r.query_class || '',
    queryCategory: r.query_category || '',
    deliveryPartnerName: r.delivery_partner_name || '',
    orderDate: r.order_date || '',
    orderMonth: r.order_month || '',
    queryDate: r.query_date || '',
    queryMonth: r.query_month || '',
    whName: r.wh_name || '',
    ticketNumber: r.ticket_number || '',
    totalTimesConsumerReached: r.total_times_user_reached ?? '',
    newOrderId: r.new_order_id || '',
    awb: r.new_awb || '',
    status: r.resolution || '',
    notes: r.agent_remarks || '',
  }));
  return { orders, total: (countRows[0] && countRows[0].total) || orders.length };
}

// getEligibleOrders/getFreshLeads both call the one query above and currently return identical
// rows - see getEscalationOrders' own comment. Kept as two names (not one, with call sites
// deduplicated) because api/escalation/[action].js's `orders`/`export` actions already branch on
// req.query.type === 'fresh-leads' to pick one or the other, and tab-wise rules that will one day
// make them differ are a known follow-up, not this task's job.
async function getEligibleOrders(limit) {
  return getEscalationOrders(limit);
}

async function getFreshLeads(limit) {
  return getEscalationOrders(limit);
}

// CSV import's row-matching index - a matched row only needs to confirm the order exists and
// learn its brand. Replaces the old getSheetIndexFromBq (which queried BigQuery's
// orders_sheet_columns). byParentAwb is now populated from the merged awb_number column (dead
// until the ticket-data merge put awb_number on this same table).
async function getEscalationOrderIndex() {
  await ensurePgSchema();
  const { rows } = await pgSql`SELECT DISTINCT ON (parent_order) parent_order, brand, awb_number FROM escalation_lead_assignments ORDER BY parent_order, assigned_at DESC`;
  const byParent = new Map();
  const byParentAwb = new Map();
  rows.forEach((r) => {
    const parent = String(r.parent_order || '').trim().toLowerCase();
    if (!parent) return;
    const ref = { brand: r.brand || '' };
    if (!byParent.has(parent)) byParent.set(parent, ref);
    const awb = String(r.awb_number || '').trim().toLowerCase();
    if (awb) byParentAwb.set(`${parent}||${awb}`, ref);
  });
  return { byParent, byParentAwb };
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
// (app/calling-overview/) - aggregated straight from lead_assignments, the same table
// rto-crm.html's own submitDisp() already writes to, so this needs no new data
// pipeline. "Connect rate" mirrors rto-crm's own definition: disposed leads where
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
  await ensurePgSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const { rows } = await pgSql`
    SELECT
      count(*) FILTER (
        WHERE reassigned_away_at IS NULL AND (${from}::timestamptz IS NULL OR assigned_at >= ${from}) AND (${to}::timestamptz IS NULL OR assigned_at <= ${to})
      )::int AS total_assigned,
      count(*) FILTER (
        WHERE disposed_at IS NOT NULL AND (${from}::timestamptz IS NULL OR disposed_at >= ${from}) AND (${to}::timestamptz IS NULL OR disposed_at <= ${to})
      )::int AS total_disposed,
      count(*) FILTER (
        WHERE reassigned_away_at IS NULL AND disposed_at IS NULL AND (${from}::timestamptz IS NULL OR assigned_at >= ${from}) AND (${to}::timestamptz IS NULL OR assigned_at <= ${to})
      )::int AS total_pending,
      count(*) FILTER (
        WHERE connected = 'Yes' AND disposed_at IS NOT NULL AND (${from}::timestamptz IS NULL OR disposed_at >= ${from}) AND (${to}::timestamptz IS NULL OR disposed_at <= ${to})
      )::int AS total_connected,
      count(*) FILTER (
        WHERE connected = 'No' AND disposed_at IS NOT NULL AND (${from}::timestamptz IS NULL OR disposed_at >= ${from}) AND (${to}::timestamptz IS NULL OR disposed_at <= ${to})
      )::int AS total_unreachable,
      count(*) FILTER (
        WHERE (disposition = 'Refund Requested' OR refund_amount IS NOT NULL)
          AND disposed_at IS NOT NULL AND (${from}::timestamptz IS NULL OR disposed_at >= ${from}) AND (${to}::timestamptz IS NULL OR disposed_at <= ${to})
      )::int AS total_refunded,
      coalesce(sum(refund_amount) FILTER (
        WHERE disposed_at IS NOT NULL AND (${from}::timestamptz IS NULL OR disposed_at >= ${from}) AND (${to}::timestamptz IS NULL OR disposed_at <= ${to})
      ), 0)::float AS total_refund_amount
    FROM lead_assignments
  `;
  const r = rows[0] || {};
  const totalDisposed = r.total_disposed || 0;
  const totalConnectAttempts = (r.total_connected || 0) + (r.total_unreachable || 0);
  return {
    totalAssigned: r.total_assigned || 0,
    totalDisposed,
    totalPending: r.total_pending || 0,
    connectRate: totalConnectAttempts > 0 ? Math.round((r.total_connected / totalConnectAttempts) * 100) : 0,
    totalRefunded: r.total_refunded || 0,
    totalRefundAmount: r.total_refund_amount || 0,
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
  await ensurePgSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const [assignedRows, disposedRows] = await Promise.all([
    pgSql`
      SELECT extract(hour FROM assigned_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, count(*)::int AS n
      FROM lead_assignments_current
      WHERE (${from}::timestamptz IS NULL OR assigned_at >= ${from}) AND (${to}::timestamptz IS NULL OR assigned_at <= ${to})
      GROUP BY 1
    `,
    pgSql`
      SELECT
        extract(hour FROM disposed_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
        count(*)::int AS dialled,
        count(*) FILTER (WHERE connected = 'Yes')::int AS connected,
        count(*) FILTER (WHERE disposition IN ('Customer Agreed to Accept', 'Product Issue / Exchange') OR new_order_id IS NOT NULL)::int AS reordered,
        count(*) FILTER (WHERE disposition = 'Refund Requested' OR refund_amount IS NOT NULL)::int AS refunded
      FROM lead_assignments
      WHERE disposed_at IS NOT NULL
        AND (${from}::timestamptz IS NULL OR disposed_at >= ${from}) AND (${to}::timestamptz IS NULL OR disposed_at <= ${to})
      GROUP BY 1
    `,
  ]);

  const byHour = Array.from({ length: 24 }, (_, hour) => ({
    hour, assigned: 0, dialled: 0, connected: 0, reordered: 0, refunded: 0,
  }));
  for (const r of assignedRows.rows) byHour[r.hour].assigned = r.n;
  for (const r of disposedRows.rows) {
    byHour[r.hour].dialled = r.dialled;
    byHour[r.hour].connected = r.connected;
    byHour[r.hour].reordered = r.reordered;
    byHour[r.hour].refunded = r.refunded;
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
    SELECT id, parent_id, label, description, sort_order FROM calling_process_dispositions
    WHERE process_key = ${processKey}
    ORDER BY sort_order ASC, id ASC
  `;
  const byId = {};
  rows.forEach((r) => {
    byId[r.id] = { id: r.id, label: r.label, description: r.description || '', sortOrder: r.sort_order, children: [] };
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
async function updateProcessDisposition(processKey, id, { label, description } = {}) {
  await ensurePgSchema();
  if (!processKey || !id) throw new Error('processKey and id are required');
  const labelText = label === undefined ? null : String(label).trim();
  if (label !== undefined && !labelText) throw new Error('A disposition label is required');
  if (labelText && labelText.length > DISPOSITION_LABEL_MAX) throw new Error(`Label must be ${DISPOSITION_LABEL_MAX} characters or fewer`);
  const descText = description === undefined ? null : String(description || '').trim();
  const { rows } = await pgSql`
    UPDATE calling_process_dispositions
    SET label = COALESCE(${labelText}, label),
        description = COALESCE(${descText}, description)
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
// ensurePgSchema). Surfaces "Customer Agreed to Accept" specifically alongside the total,
// so it directly answers "which partner is most of our Customer Agreed to Accept coming
// from" rather than just a generic disposed count - sorted by that count descending.
//
// Base table (every disposed cycle), since these are call-outcome counts - see
// getCallingOverviewStats for why that grain and not the live-cycle view.
async function getCallingPartnerBreakdown(dateFrom, dateTo) {
  await ensurePgSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const { rows } = await pgSql`
    SELECT
      coalesce(delivery_partner, 'Unknown') AS partner,
      count(*)::int AS total_disposed,
      count(*) FILTER (WHERE disposition = 'Customer Agreed to Accept')::int AS customer_agreed_to_accept,
      count(*) FILTER (WHERE connected = 'Yes')::int AS connected
    FROM lead_assignments
    WHERE disposed_at IS NOT NULL
      AND (${from}::timestamptz IS NULL OR disposed_at >= ${from}) AND (${to}::timestamptz IS NULL OR disposed_at <= ${to})
    GROUP BY 1
    ORDER BY customer_agreed_to_accept DESC, total_disposed DESC
  `;
  return rows.map((r) => ({
    partner: r.partner,
    totalDisposed: r.total_disposed,
    customerAgreedToAccept: r.customer_agreed_to_accept,
    connected: r.connected,
  }));
}

// Per-RTO-reason lead volume (rto_reason - the sheet's own RTO reason column, mirrored
// into Postgres). Sorted by volume descending, same as the partner breakdown.
async function getCallingRtoReasonBreakdown(dateFrom, dateTo) {
  await ensurePgSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const { rows } = await pgSql`
    SELECT
      coalesce(rto_reason, 'Unknown') AS rto_reason,
      count(*)::int AS total
    FROM lead_assignments_current
    WHERE (${from}::timestamptz IS NULL OR assigned_at >= ${from}) AND (${to}::timestamptz IS NULL OR assigned_at <= ${to})
    GROUP BY 1
    ORDER BY total DESC
  `;
  return rows.map((r) => ({ rtoReason: r.rto_reason, total: r.total }));
}

// Combines all queries above into the single payload api/report/data/[key].js's
// "calling-overview" route serves - one round trip for the whole Overview tab.
async function getCallingOverviewData(query) {
  const { dateFrom, dateTo } = query || {};
  const [stats, hourly, partnerBreakdown, rtoReasonBreakdown] = await Promise.all([
    getCallingOverviewStats(dateFrom, dateTo),
    getCallingHourlyStats(dateFrom, dateTo),
    getCallingPartnerBreakdown(dateFrom, dateTo),
    getCallingRtoReasonBreakdown(dateFrom, dateTo),
  ]);
  return { stats, hourly, partnerBreakdown, rtoReasonBreakdown };
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
// Reads lead_assignments_current (the live-cycle view), NOT the base lead_assignments table -
// deliberately the OPPOSITE grain from getCallingOverviewStats' disposed/connected/refunded
// metrics, which read the base table so a lead's every past attempt still counts toward
// company-wide call-volume KPIs. This function exists purely to decide, for a lead the CLIENT
// is already looking at (allTickets, sourced from the live sheet - which only ever shows the
// CURRENT cycle's state, since a reassignment wipes Q:U for the new agent), which date scope
// that SAME cycle falls into. The base table now holds one row per cycle (a reassigned lead
// gets a new row rather than an overwrite - see ensurePgSchema's lead_assignments comment), so
// reading it unfiltered here would risk matching an order_id to a RETIRED cycle's dates
// (whichever row Postgres happens to return last), not the live one the sheet and this
// function's caller both mean.
async function getAllLeadDates() {
  await ensurePgSchema();
  const { rows } = await pgSql`SELECT order_id, assigned_at, disposed_at FROM lead_assignments_current`;
  const out = {};
  for (const r of rows) out[r.order_id] = { assignedAt: r.assigned_at, disposedAt: r.disposed_at };
  return out;
}

// NDR's own equivalent of getAllLeadDates above, keyed by awb_number (NDR's live-cycle identity
// - see claimNdrLead/disposeNdrLead) rather than order_id. WHERE reassigned_away_at IS NULL for
// the same reason getAllLeadDates reads lead_assignments_current instead of the base table: only
// the current cycle's dates matter to whatever's on screen right now.
async function getAllNdrLeadDates() {
  await ensurePgSchema();
  const { rows } = await pgSql`
    SELECT awb_number, assigned_at, disposed_at FROM ndr_lead_assignments WHERE reassigned_away_at IS NULL
  `;
  const out = {};
  for (const r of rows) out[r.awb_number] = { assignedAt: r.assigned_at, disposedAt: r.disposed_at };
  return out;
}

module.exports = {
  sql, ensureSchema, CARD_KEYS, CARD_LABELS,
  getUserByEmail, getUserById, getUserPermissions, getUserTabPermissions, setTabPermissions,
  bootstrapAdminIfNeeded, logAccess, logEvent, deleteUser, upsertAgentPresence,
  getAllAgentPresence, getAgentPresenceLogSummary, getAllLeadDates, getAllNdrLeadDates, getRecentLeadAssignments, recordLeadDisposition,
  getCallingOverviewStats, getCallingHourlyStats, getCallingOverviewData,
  BUSINESS_HOUR_DAYS, getCallingBusinessHours, setCallingBusinessHours,
  CALLING_STATUSES, getCallingProcessAgents, setCallingProcessAgent,
  isCallingProcessAdmin, getAdministeredProcesses,
  getProcessDispositions, addProcessDisposition, updateProcessDisposition,
  deleteProcessDisposition, reorderProcessDispositions,
  claimNdrLead, disposeNdrLead,
  assignEscalationOrder, unassignEscalationOrder, resolveEscalationAssignment, getEscalationAssignments,
  getLiveEscalationAssignments, resolveEscalationAssignmentsBulk,
  getEligibleOrders, getFreshLeads, getEscalationOrderIndex,
  // Exported for api/_lib/db.retry.test.js only - nothing in the app calls these directly.
  isPoolExhausted, withPgConnectRetry, toTransactionModePooler,
};
