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
async function recordLeadDisposition(orderId, email, awbCode, details) {
  await ensureSchema();
  const { disposition, agentRemarks, connected, attempt, refundAmount, newOrderId, rtoReason } = details || {};
  const deliveryPartner = resolvePartnerFromAwb(awbCode);
  const now = new Date();
  try {
    await sql`
      INSERT INTO CLS_RTO_calling (order_id, agent_email, assigned_at, disposed_at, disposition, agent_remarks, connected, attempt, refund_amount, awb_code, new_order_id, rto_reason, delivery_partner)
      VALUES (${orderId}, ${email}, ${now}, ${now}, ${disposition || null}, ${agentRemarks || null}, ${connected || null}, ${attempt || null}, ${refundAmount || null}, ${awbCode || null}, ${newOrderId || null}, ${rtoReason || null}, ${deliveryPartner})
    `;
  } catch (e) {
    if (!/live_order_id_key/.test((e && e.message) || '')) throw e;
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
        delivery_partner = COALESCE(${deliveryPartner}, delivery_partner)
      WHERE order_id = ${orderId} AND reassigned_away_at IS NULL
    `;
  }
  invalidateCache('calling:leadDates');
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
const DE_FORCED_RTO_WHERE = `tat = 'Forced to be marked as RTO'`;

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

async function getDeliveryEscalationAgents() {
  const { rows } = await sql`
    SELECT DISTINCT agent_email FROM Delivery_escalation
    WHERE agent_email IS NOT NULL AND agent_email != ''
    ORDER BY agent_email
  `;
  return rows.map((r) => r.agent_email);
}

// Rows for a CSV export - the current filter/scope, but every matching row rather than one
// page, capped so the response still fits the 6MB ceiling. The cap is reported back (see
// record.js) so a truncated export can say so instead of looking complete.
async function getDeliveryEscalationExport(view, opts = {}) {
  const { where, params } = deWhere(view, opts);
  const pool = await getPool();
  const [rows] = await pool.execute(
    `SELECT ${DE_SELECT_COLUMNS} FROM Delivery_escalation WHERE ${where}
     ORDER BY ${deOrderBy(view)} LIMIT ${DELIVERY_ESCALATION_MAX_EXPORT}`, params);
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
async function disposeDeliveryEscalationTicketById(id, email, outcome, agentRemarks) {
  await sql`
    UPDATE Delivery_escalation
    SET outcome = ${outcome || null}, agent_remarks = ${agentRemarks || null}, disposed_at = now(),
        agent_email = CASE WHEN agent_email IS NULL OR agent_email = '' THEN ${email} ELSE agent_email END,
        assigned_at = CASE WHEN assigned_at IS NULL THEN now() ELSE assigned_at END
    WHERE id = ${id}
  `;
}

// Bulk outcome upload for Fresh tickets (see api/delivery-escalation/record.js's 'bulkDispose'
// action) - one UPDATE per (awb, outcome) pair, matching EVERY row with that awb_code: an AWB
// can legitimately repeat (same AWB reused across brands, or a re-shipped order), and there's
// no brand column in the upload to disambiguate, so every match gets the same outcome. Scoped
// to Fresh-eligible rows only (outcome blank/RTO/Escalated - same set getDeliveryEscalationFresh
// lists) so a bad upload can't silently overwrite an already-Delivered ticket's history. Returns
// how many rows each pair actually changed, so the caller can report AWBs that matched nothing
// (typo, wrong AWB) or matched zero because every row for that AWB was already resolved.
//
// agent_email is ALWAYS set to whoever ran the upload, even if some other agent had already
// claimed the row - unlike the single claim/dispose path (claimDeliveryEscalationTicketById/
// disposeDeliveryEscalationTicketById), which only fills a blank agent_email and never
// overwrites an existing claim. A bulk upload's outcome IS the disposal, uploaded by the person
// who ran it, not a claim being made on someone else's behalf.
async function bulkDisposeDeliveryEscalationByAwb(rows, email) {
  const results = [];
  for (const { awb, outcome, remarks } of rows) {
    const { affectedRows } = await sql`
      UPDATE Delivery_escalation
      SET outcome = ${outcome}, agent_remarks = ${remarks || null}, disposed_at = now(),
          agent_email = ${email},
          assigned_at = CASE WHEN assigned_at IS NULL THEN now() ELSE assigned_at END
      WHERE awb_code = ${awb}
        AND (outcome IS NULL OR outcome = ''
             OR outcome = 'RTO' OR outcome LIKE 'RTO > %'
             OR outcome = 'Escalated' OR outcome LIKE 'Escalated > %')
    `;
    results.push({ awb, outcome, matched: affectedRows || 0 });
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
      COALESCE(SUM(CASE WHEN disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN refund_amount ELSE 0 END), 0) AS total_refund_amount
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

// Per-RTO-reason lead volume (rto_reason - the sheet's own RTO reason column, mirrored
// into MySQL). Sorted by volume descending, same as the partner breakdown.
async function getCallingRtoReasonBreakdown(dateFrom, dateTo) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const { rows } = await sql`
    SELECT
      COALESCE(rto_reason, 'Unknown') AS rto_reason,
      COUNT(*) AS total
    FROM CLS_RTO_calling
    WHERE reassigned_away_at IS NULL
      AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to})
    GROUP BY 1
    ORDER BY total DESC
  `;
  return rows.map((r) => ({ rtoReason: r.rto_reason, total: Number(r.total) || 0 }));
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
  disposeDeliveryEscalationTicket,
  getDeliveryEscalationPage, getDeliveryEscalationStats, getDeliveryEscalationAgents,
  getDeliveryEscalationExport, DELIVERY_ESCALATION_MAX_EXPORT, getDeliveryEscalationRepeatStats,
  claimDeliveryEscalationTicketById, disposeDeliveryEscalationTicketById,
  bulkDisposeDeliveryEscalationByAwb,
  REFUND_EXPORT_MAX_ROWS, REFUND_EXPORT_BASE_COLUMNS, REFUND_EXPORT_PII_COLUMNS,
  getRefundExportCount, getRefundExportRows,
  // Exported for api/_lib/db.retry.test.js, db.cache.test.js, db.refundExport.test.js and
  // db.deliveryEscalation.test.js only - nothing in the app calls these directly.
  deWhere,
  isPoolExhausted, withPgConnectRetry, toTransactionModePooler, cachedRead, invalidateCache, CACHE_TTL_MS,
  buildRefundExportWhere,
};
