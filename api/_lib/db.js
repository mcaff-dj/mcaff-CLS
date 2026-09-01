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

// Short-lived read cache for the handful of queries that pull WHOLE tables back over the wire.
// This exists for network egress, not latency - a few agents working a normal day can move
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

// Collapses concurrent first-callers onto ONE bootstrap run - api/auth/[action].js fans out to
// three functions that each land here, and one shared bootstrap run per container is what this
// always meant to be, not three racing DDL passes.
async function ensureSchema() {
  if (schemaReady) return;
  if (!schemaPromise) schemaPromise = bootstrapSchema().finally(() => { schemaPromise = null; });
  return schemaPromise;
}

// Every table CREATE-d below - kept in sync by hand (add a table above, add its name here).
// schemaLooksComplete() uses this list to short-circuit the whole bootstrap with one query
// once every table already exists, which is every cold start in production but for a very
// long time cost 20 full round-trips (19 CREATE TABLE IF NOT EXISTS + the 3 rename UPDATEs
// + the settings INSERT, each individually a no-op) to find that out. Diagnosed 2026-08-28:
// a redeploy zeroes schemaReady on every warm container simultaneously, so a burst of
// concurrent cold-start requests each pay the full 20-round-trip bootstrap AND contend for
// the same tables' DDL metadata locks at once - on a slow connection that stacked past the
// API Lambda's timeout and every request in the window got a bare "Internal server error".
const BOOTSTRAP_TABLES = [
  'users', 'permissions', 'audit_log', 'report_tab_permissions',
  'mom_boards', 'mom_board_members', 'mom_statuses', 'mom_columns', 'mom_tasks', 'mom_task_field_values',
  'report_cell_comments', 'ndr_lead_assignments', 'calling_process_dispositions', 'calling_business_hours',
  'calling_agent_process', 'calling_teams', 'rto_csv_upload_jobs', 'order_punch_jobs',
  'order_punch_job_rows', 'order_punch_settings',
];

// Fails open (false) on any error - a broken existence check must never be the reason schema
// creation gets silently skipped on a genuinely fresh database. Only ever SKIPS work that
// bootstrapSchema() would have found to be a no-op anyway (every statement below is IF NOT
// EXISTS / ON DUPLICATE KEY UPDATE), so this changes wall-clock cost, never end-state.
async function schemaLooksComplete() {
  try {
    const p = await getPool();
    const placeholders = BOOTSTRAP_TABLES.map(() => '?').join(',');
    const [rows] = await p.execute(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
      BOOTSTRAP_TABLES,
    );
    return rows[0].n === BOOTSTRAP_TABLES.length;
  } catch {
    return false;
  }
}

// Idempotent - safe to call on every cold start. Only runs the DDL once per warm instance.
// This is a fresh schema (PEP_CLS), so unlike the Postgres version, there's no historical
// ALTER/rename migrations to carry forward - just the final desired shape.
async function bootstrapSchema() {
  if (await schemaLooksComplete()) { schemaReady = true; return; }
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
  // NDR Calling's assignment/disposition history - moved here from Postgres (see
  // migrate_ndr_lead_assignments_to_mysql.py), the same MySQL-over-Postgres move
  // lead_assignments already made onto CLS_RTO_calling. reassigned_away_at IS actually set,
  // by scripts/assign_ndr_leads.py's own record_new_assignments (a lead can come back around
  // to the unassigned pool and be handed to a different agent) - a plain UNIQUE on awb_number
  // would collide the moment a retired cycle and its replacement coexist. live_awb_number is
  // MySQL's emulation of Postgres's old partial unique index (`WHERE reassigned_away_at IS
  // NULL`) - see migrate_cls_rto_calling_schema.py's live_order_id/live_awb_code for the same
  // trick: NULL on every retired row (MySQL treats every NULL in a UNIQUE index as distinct),
  // non-NULL (= awb_number) only on the one live cycle.
  await sql`
    CREATE TABLE IF NOT EXISTS ndr_lead_assignments (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      awb_number VARCHAR(64) NOT NULL,
      email VARCHAR(320) NOT NULL,
      assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reassigned_away_at TIMESTAMP NULL,
      disposed_at TIMESTAMP NULL,
      disposition VARCHAR(255),
      agent_remarks TEXT,
      live_awb_number VARCHAR(64) GENERATED ALWAYS AS
        (IF(reassigned_away_at IS NULL, awb_number, NULL)) VIRTUAL,
      UNIQUE KEY ndr_lead_assignments_live_awb_key (live_awb_number)
    )
  `;
  // A process's own admin-defined disposition list - moved here from Postgres (see
  // migrate_calling_process_dispositions_to_mysql.py). parent_id is self-referencing
  // (arbitrary nesting depth - see getProcessDispositions), ON DELETE CASCADE so removing a
  // parent takes its children with it, same as the Postgres version had.
  // team_id (added by scripts/migrate_team_dispositions.py, NOT here - this bootstrap has no
  // ALTER TABLE and CREATE TABLE IF NOT EXISTS is inert against the existing table) scopes a row
  // to one calling_teams row; NULL means the SHARED tree every process without a team split uses.
  await sql`
    CREATE TABLE IF NOT EXISTS calling_process_dispositions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      process_key VARCHAR(64) NOT NULL,
      parent_id INT NULL,
      label VARCHAR(120) NOT NULL,
      description TEXT,
      sort_order INT NOT NULL DEFAULT 0,
      children_input_type VARCHAR(16) NOT NULL DEFAULT 'single',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(320),
      CHECK (children_input_type IN ('single', 'multi', 'text')),
      FOREIGN KEY (parent_id) REFERENCES calling_process_dispositions(id) ON DELETE CASCADE,
      KEY calling_process_dispositions_process_key_idx (process_key, sort_order),
      KEY calling_process_dispositions_parent_idx (parent_id, sort_order)
    )
  `;
  // Per-process, per-weekday calling hours - moved here from Postgres (see
  // migrate_calling_business_hours_and_agent_process_to_mysql.py). See getCallingBusinessHours
  // for the open_time/close_time NULL-means-closed contract.
  await sql`
    CREATE TABLE IF NOT EXISTS calling_business_hours (
      process_key VARCHAR(64) NOT NULL,
      day VARCHAR(16) NOT NULL,
      open_time VARCHAR(8),
      close_time VARCHAR(8),
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by VARCHAR(320),
      PRIMARY KEY (process_key, day)
    )
  `;
  // Per-process availability/capacity/filters for one agent - moved here from Postgres (same
  // migration as calling_business_hours above). scripts/assign_leads.py and
  // scripts/assign_ndr_leads.py now read this directly via mysql_lib instead of psycopg.
  //
  // is_process_admin: administers this ONE process (roster/hours, full team data) without
  // company-wide admin (users.is_admin) - see RtoCrmClient.js's isProcessAdmin exemptions.
  // prepaid_pct: soft prepaid-mix target for this agent's round-robin (0-100, NULL = no
  // target) - steers, never blocks outright (build_assignment_queue's agent_prepaid_target).
  // priority_rto_reasons: comma-separated RTO-reason substrings this agent specializes in -
  // a matching lead gets first refusal before the general round-robin.
  // reassign_payment_mode: hard filter on Connected=No REASSIGNMENTS only - '' = no
  // restriction, 'Prepaid'/'COD' = only that payment type, never relaxed on a later pass.
  // attempt_count_filter/ndr_reason_filter/ndr_payment_mode_filter/ndr_brand_filter: NDR
  // Calling's own hard filters, applied to EVERY lead (not just reassignments) - see
  // scripts/assign_ndr_leads.py's agent_attempt_filter/agent_reason_filter/
  // agent_payment_mode_filter/agent_brand_filter. '' = no restriction throughout.
  await sql`
    CREATE TABLE IF NOT EXISTS calling_agent_process (
      email VARCHAR(320) NOT NULL,
      process_key VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'Offline',
      max_quota INT,
      is_process_admin BOOLEAN NOT NULL DEFAULT FALSE,
      prepaid_pct INT,
      priority_rto_reasons TEXT,
      reassign_payment_mode VARCHAR(16),
      attempt_count_filter TEXT,
      ndr_reason_filter TEXT,
      ndr_payment_mode_filter VARCHAR(16),
      ndr_brand_filter VARCHAR(16),
      -- team_id: which calling_teams row (if any) this agent belongs to within the process. This
      -- column already exists on the LIVE table via scripts/migrate_ndr_team_id.py, which is
      -- still the path for prod - IF NOT EXISTS makes this line a no-op there. It is added here so
      -- a FRESH environment bootstrapped by ensureSchema alone (nothing but this file) comes up
      -- correct instead of permanently missing the column three other call sites select/insert.
      team_id INT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by VARCHAR(320),
      PRIMARY KEY (email, process_key)
    )
  `;
  // One row per team within a calling process. Teams are a dimension INSIDE a process, not
  // processes of their own: two NDR teams share the process's disposition tree, calling hours
  // and permission tab, and differ only in WHO is on them and WHICH sheet they work. See
  // docs/superpowers/specs/2026-08-26-ndr-per-team-isolation-design.md for why this is not
  // modelled as two process keys.
  //
  // sheet_id / sheet_tab: the team's own Google Sheet. Stored per team rather than hardcoded
  // because the two live NDR sheets are different files that happen to share a tab name
  // ('Latest NDR ', trailing space significant) - nothing guarantees a third would. Never trim
  // sheet_tab anywhere it's read: trimming turns that trailing space into a Sheets API range
  // string that resolves to nothing.
  // Writes to sheet_id are full-admin only (never is_process_admin): the service account has
  // Editor access, so whoever sets this steers it at an arbitrary spreadsheet.
  //
  // active: soft-delete. Deactivating a team is the intended way to reverse a rollout, since
  // isolation switches on at two ACTIVE teams - so this must never be a hard DELETE, which
  // would orphan the team_id on every calling_agent_process row pointing at it.
  await sql`
    CREATE TABLE IF NOT EXISTS calling_teams (
      id INT AUTO_INCREMENT PRIMARY KEY,
      process_key VARCHAR(64) NOT NULL,
      name VARCHAR(120) NOT NULL,
      sheet_id VARCHAR(128) NOT NULL,
      sheet_tab VARCHAR(120) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(320),
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by VARCHAR(320),
      UNIQUE KEY calling_teams_process_name_key (process_key, name),
      KEY calling_teams_process_active_idx (process_key, active)
    )
  `;
  // One row per RTO CSV upload - moved here from Postgres (see
  // migrate_rto_csv_upload_jobs_to_mysql.py). rows_pending holds the validated, deduped rows
  // still awaiting the background worker (scripts/process_rto_csv_upload_job.py) - cleared to
  // NULL once the job reaches 'done' or 'failed'. errors is a capped sample ({line, reason}[],
  // max 50) - see api/_lib/rtoCsvImport.js's buildRowPlan for where these originate. See
  // docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md for the full job lifecycle.
  await sql`
    CREATE TABLE IF NOT EXISTS rto_csv_upload_jobs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      created_by VARCHAR(320) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      total_rows INT NOT NULL,
      prepaid_count INT NOT NULL,
      checked_count INT NOT NULL DEFAULT 0,
      already_refunded_count INT NOT NULL DEFAULT 0,
      already_punched_count INT NOT NULL DEFAULT 0,
      appended_count INT NOT NULL DEFAULT 0,
      duplicate_in_sheet_count INT NOT NULL DEFAULT 0,
      duplicate_in_file_count INT NOT NULL DEFAULT 0,
      missing_awb_count INT NOT NULL DEFAULT 0,
      rows_pending JSON,
      errors JSON,
      error_message TEXT
    )
  `;
  // Order Punch - background repunch pipeline - moved here from Postgres (see
  // migrate_order_punch_to_mysql.py). id is BIGINT UNSIGNED to match rto_csv_upload_jobs' own
  // id convention.
  await sql`
    CREATE TABLE IF NOT EXISTS order_punch_jobs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      created_by VARCHAR(320) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      total_rows INT NOT NULL,
      processed_count INT NOT NULL DEFAULT 0,
      success_count INT NOT NULL DEFAULT 0,
      error_count INT NOT NULL DEFAULT 0,
      skipped_count INT NOT NULL DEFAULT 0,
      stop_requested BOOLEAN NOT NULL DEFAULT FALSE,
      error_message TEXT
    )
  `;
  // One row per order to repunch. status/so_code/target_channel/error_message are written by
  // the Python worker (its own pymysql connection) as each row is processed - Node only ever
  // INSERTs these at job creation (see createOrderPunchJob below).
  await sql`
    CREATE TABLE IF NOT EXISTS order_punch_job_rows (
      job_id BIGINT UNSIGNED NOT NULL,
      row_index INT NOT NULL,
      display_order_code VARCHAR(64) NOT NULL,
      reason TEXT,
      facility_code VARCHAR(64),
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      so_code VARCHAR(64),
      target_channel VARCHAR(64),
      error_message TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (job_id, row_index),
      FOREIGN KEY (job_id) REFERENCES order_punch_jobs(id),
      KEY order_punch_job_rows_pending_idx (job_id, status, row_index)
    )
  `;
  // Admin-editable settings, seeded below with the Apps Script's own hardcoded constants so
  // behavior is identical on day one. The Python worker reads this table directly (its own
  // pymysql connection) at the start of each invocation.
  await sql`
    CREATE TABLE IF NOT EXISTS order_punch_settings (
      \`key\` VARCHAR(64) PRIMARY KEY,
      value JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by VARCHAR(320) NOT NULL
    )
  `;
  // Seed defaults once - ON DUPLICATE KEY UPDATE against itself (a no-op) means an admin's
  // later edit is never overwritten by a subsequent cold start re-running this bootstrap.
  await sql`
    INSERT INTO order_punch_settings (\`key\`, value, updated_by) VALUES
      ('facility_codes', '["HYP_SRKOL","HYP_SRBGLR","mCaff_Mumbai2","mCaff_Gurgaon3","HYP_AHMD","HYP_SRLOK2","HYP_SRGWHT","Omnivio_Noida1","HYP_DLNAG"]', 'system'),
      ('mcaffeine_channels', '["SHOPIFY","FIEN_SHOPIFY","HYPD","COMPENSATION","MCaf_Shopify.in","MCAFF_TEST"]', 'system'),
      ('hyphen_channels', '["HYP_SHOPIFY","HYPD_HYPHEN","HYP_COMPENSATION","HYP_SHOPIFY_IN"]', 'system'),
      ('target_mcaffeine', '"MCAFFEINE_D2C"', 'system'),
      ('target_hyphen', '"HYPHEN_D2C"', 'system'),
      ('cooldown_days', '3', 'system'),
      ('max_suffix', '2', 'system')
    ON DUPLICATE KEY UPDATE \`key\` = \`key\`
  `;
  schemaReady = true;
}

// Every RTO CRM operational table that used to live on a separate Postgres/Supabase database
// (agent_presence, agent_presence_log, calling_business_hours, calling_agent_process,
// calling_process_dispositions, ndr_lead_assignments, rto_csv_upload_jobs, order_punch_jobs/
// order_punch_job_rows/order_punch_settings) has moved onto this same MySQL PEP_CLS schema -
// see each table's own comment above in bootstrapSchema, and the migrate_*_to_mysql.py script
// that moved its data. There is no longer a second database or a Postgres-specific bootstrap
// in this file.

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
// How long after a disposal a re-submission by the SAME agent is treated as the same piece of
// work rather than a new cycle. Sized for a slow round trip, not for an agent's judgement: the
// disposal modal's Save button ran the whole flow - MySQL write, live Column-Q map fetch, sheet
// write-back, next-lead top-up - and stayed clickable throughout, so a cold Lambda meant several
// seconds of an apparently dead button. Order 9184758 collected 16 extra cycles in 6 seconds
// that way on 2026-08-25, each one retiring the row the click before it created. A minute is
// far longer than any such burst and far shorter than a real re-open, which is someone finding
// the lead again in All Leads later in the shift.
const REDISPOSE_SAME_CYCLE_MS = 60 * 1000;

// Does this disposal deserve its own cycle row, or is it the same work arriving twice?
//
// A new cycle exists to record that SOMEONE ELSE, or the same person in a genuinely new
// session, worked the lead again - it carries its own agent_email and its own assigned_at so
// FRT stays honest (see recordLeadDisposition's own comment). A double-click has neither
// property: same agent, same second. Kept pure and exported so this rule is testable without a
// database - see db.redispose.test.js.
function shouldOpenNewCycle(liveRow, email, nowMs) {
  if (!liveRow || liveRow.disposed_at == null) return false; // not disposed yet - plain UPDATE
  const sameAgent = String(liveRow.agent_email || '').trim().toLowerCase()
    === String(email || '').trim().toLowerCase();
  if (!sameAgent) return true;                                // a different agent re-worked it
  const disposedMs = new Date(liveRow.disposed_at).getTime();
  if (!Number.isFinite(disposedMs)) return true;              // unreadable timestamp - keep history
  return nowMs - disposedMs >= REDISPOSE_SAME_CYCLE_MS;       // same agent, later session
}

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
    // live_order_id, not order_id: it is the VIRTUAL column `IF(reassigned_away_at IS NULL,
    // order_id, NULL)` that live_order_id_key is built on (see ensureSchema and
    // migrate_cls_rto_calling_schema.py), so matching on it is the same set of rows the old
    // `order_id = ? AND reassigned_away_at IS NULL` pair selected - except the optimizer can
    // use the unique index instead of scanning. CLS_RTO_calling has no index on order_id (the
    // old one was dropped), so every one of the three statements in this catch block was a
    // full table scan, on the hottest write path in the CRM. The redundant
    // `reassigned_away_at IS NULL` is kept alongside so the intent stays readable and the
    // predicate is unambiguous on the UPDATE that changes that very column.
    const { rows: liveRows } = await sql`
      SELECT disposed_at, agent_email FROM CLS_RTO_calling
      WHERE live_order_id = ${orderId} AND reassigned_away_at IS NULL
    `;
    // Same agent re-submitting within a minute is one disposal arriving twice, not a re-open:
    // it updates the row in place, exactly as an undisposed lead would. Everything else - a
    // different agent, or the same agent finding the lead again later - still opens its own
    // cycle. See shouldOpenNewCycle above.
    if (shouldOpenNewCycle(liveRows[0], email, now.getTime())) {
      const p = await getPool();
      const conn = await p.getConnection();
      try {
        await conn.beginTransaction();
        // Matches on order_id alone (not disposed_at, which could itself have moved between
        // the SELECT above and here) - same benign-race tolerance as claimRtoLead: whichever
        // re-dispose lands first retires the row, and this UPDATE affecting 0 rows a moment
        // later on a genuine race just means the OTHER submission already did it.
        await conn.execute(
          'UPDATE CLS_RTO_calling SET reassigned_away_at = ? WHERE live_order_id = ? AND reassigned_away_at IS NULL',
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
        WHERE live_order_id = ${orderId} AND reassigned_away_at IS NULL
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
async function claimRtoLead(orderId, email, awbCode, rtoReason, paymentMode, addressCity, addressState, addressPincode) {
  await ensureSchema();
  const deliveryPartner = resolvePartnerFromAwb(awbCode);
  try {
    await sql`
      INSERT INTO CLS_RTO_calling (order_id, agent_email, assigned_at, awb_code, rto_reason, payment_mode, delivery_partner, address_city, address_state, address_pincode)
      VALUES (${orderId}, ${email}, ${new Date()}, ${awbCode || null}, ${rtoReason || null}, ${paymentMode || null}, ${deliveryPartner}, ${addressCity || null}, ${addressState || null}, ${addressPincode || null})
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
    await ensureSchema();
    const { rows } = await sql`
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
    await ensureSchema();
    const { rows } = await sql`
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

// Per-agent RTO specializations (calling_agent_process.priority_rto_reasons) for everyone who
// is genuinely callable RIGHT NOW, so api/rto/next-lead.js can apply the same first-refusal rule
// scripts/lead_priority.py's build_assignment_queue Pass 1 applies. Without this the two
// assignment paths disagreed: the sweep routed a reason to its specialist while an instant
// top-up handed the same reason to whoever happened to dispose first.
//
// "Callable now" is the SAME two-part test next-lead's own isEligibleNow makes of its caller -
// per-process status Online AND a global presence heartbeat newer than freshSince - because a
// specialist who is Offline, Busy or silently gone must not hold leads back from an agent who
// is actually working. freshSince is passed in rather than derived here so the caller's
// STALE_MINUTES stays the one definition of "fresh" (it already mirrors assign_leads.py's).
//
// Returns [{ email, reasons }] with reasons already comma-split, trimmed, lowercased and
// blank-dropped - the same normalization assign_leads.py does when it builds `specializations`.
// Agents with no reasons set are omitted entirely: they have nothing to reserve.
//
// null (not []) on error, and the caller treats that as "cannot tell - do not reorder", which
// degrades to the plain tier ordering this endpoint used before. Failing OPEN is right here,
// unlike getRtoAgentAvailability above: this only steers WHICH lead an eligible agent gets, so
// the bad outcome is a slightly worse-matched lead, not an agent who should not be working.
async function getRtoOnlineSpecializations(freshSince) {
  try {
    await ensureSchema();
    const { rows } = await sql`
      SELECT cap.email, cap.priority_rto_reasons AS reasons
      FROM calling_agent_process cap
      JOIN agent_presence ap ON LOWER(ap.email) = LOWER(cap.email)
      WHERE cap.process_key = 'rto'
        AND cap.status = 'Online'
        AND cap.priority_rto_reasons IS NOT NULL
        AND cap.priority_rto_reasons <> ''
        AND ap.status = 'Online'
        AND ap.updated_at >= ${freshSince}
    `;
    return rows
      .map((r) => ({
        email: (r.email || '').toLowerCase(),
        reasons: String(r.reasons || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
      }))
      .filter((r) => r.email && r.reasons.length);
  } catch (e) {
    console.error('getRtoOnlineSpecializations: lookup failed:', e.message);
    return null;
  }
}

// { id } for a freshly-created RTO CSV upload job. status starts 'queued' - the worker Lambda
// (mcaff-cls-csv-upload-worker) hasn't necessarily started yet by the time this returns, since
// it's invoked fire-and-forget right after this insert (see api/rto/upload-start.js).
async function createRtoCsvUploadJob({ createdBy, totalRows, prepaidCount, rowsPending }) {
  await ensureSchema();
  const { insertId } = await sql`
    INSERT INTO rto_csv_upload_jobs (created_by, total_rows, prepaid_count, rows_pending)
    VALUES (${createdBy}, ${totalRows}, ${prepaidCount}, ${JSON.stringify(rowsPending)})
  `;
  return insertId;
}

// The full job row, or null if `id` doesn't exist - api/rto/upload-status.js's whole job.
async function getRtoCsvUploadJob(id) {
  await ensureSchema();
  const { rows } = await sql`SELECT * FROM rto_csv_upload_jobs WHERE id = ${id}`;
  return rows[0] || null;
}

// Partial update - `fields` keys must be a subset of the table's own columns. Used by the
// Python worker's own Postgres connection too (via a plain UPDATE, not this function directly -
// Node and Python each use their native DB client) but this is the ONLY way the Node side
// (api/rto/upload-start.js, for the non-prepaid immediate-append counts) writes to this table,
// so both sides stay consistent about which columns exist.
async function updateRtoCsvUploadJob(id, fields) {
  await ensureSchema();
  const allowed = new Set([
    'status', 'checked_count', 'already_refunded_count', 'already_punched_count',
    'appended_count', 'duplicate_in_sheet_count', 'duplicate_in_file_count',
    'missing_awb_count', 'rows_pending', 'errors', 'error_message',
  ]);
  const keys = Object.keys(fields).filter((k) => allowed.has(k));
  if (!keys.length) return;
  // sql is a tagged template (see its own definition earlier in this file), so the SET
  // clause has to be built with real interpolation, not a loop of separate awaited queries -
  // one UPDATE per call, whatever fields are given.
  for (const key of keys) {
    const value = key === 'rows_pending' || key === 'errors'
      ? JSON.stringify(fields[key])
      : fields[key];
    if (key === 'status') await sql`UPDATE rto_csv_upload_jobs SET status = ${value}, updated_at = NOW() WHERE id = ${id}`;
    else if (key === 'checked_count') await sql`UPDATE rto_csv_upload_jobs SET checked_count = ${value}, updated_at = NOW() WHERE id = ${id}`;
    else if (key === 'already_refunded_count') await sql`UPDATE rto_csv_upload_jobs SET already_refunded_count = ${value}, updated_at = NOW() WHERE id = ${id}`;
    else if (key === 'already_punched_count') await sql`UPDATE rto_csv_upload_jobs SET already_punched_count = ${value}, updated_at = NOW() WHERE id = ${id}`;
    else if (key === 'appended_count') await sql`UPDATE rto_csv_upload_jobs SET appended_count = ${value}, updated_at = NOW() WHERE id = ${id}`;
    else if (key === 'duplicate_in_sheet_count') await sql`UPDATE rto_csv_upload_jobs SET duplicate_in_sheet_count = ${value}, updated_at = NOW() WHERE id = ${id}`;
    else if (key === 'duplicate_in_file_count') await sql`UPDATE rto_csv_upload_jobs SET duplicate_in_file_count = ${value}, updated_at = NOW() WHERE id = ${id}`;
    else if (key === 'missing_awb_count') await sql`UPDATE rto_csv_upload_jobs SET missing_awb_count = ${value}, updated_at = NOW() WHERE id = ${id}`;
    else if (key === 'rows_pending') await sql`UPDATE rto_csv_upload_jobs SET rows_pending = ${value}, updated_at = NOW() WHERE id = ${id}`;
    else if (key === 'errors') await sql`UPDATE rto_csv_upload_jobs SET errors = ${value}, updated_at = NOW() WHERE id = ${id}`;
    else if (key === 'error_message') await sql`UPDATE rto_csv_upload_jobs SET error_message = ${value}, updated_at = NOW() WHERE id = ${id}`;
  }
}

// { id } for a freshly-created Order Punch job - job row + every submitted row inserted in ONE
// transaction, so a crash between the two inserts can never leave a job with zero rows (which
// the worker would otherwise treat as instantly "done"). rows is [{doc, reason,
// facility_code}], already validated by the caller (see api/_lib/orderPunchRows.js) -
// row_index is assigned here as submission order.
async function createOrderPunchJob({ createdBy, rows }) {
  await ensureSchema();
  const p = await getPool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const [jobResult] = await conn.execute(
      'INSERT INTO order_punch_jobs (created_by, total_rows) VALUES (?, ?)',
      [createdBy, rows.length],
    );
    const jobId = jobResult.insertId;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await conn.execute(
        `INSERT INTO order_punch_job_rows (job_id, row_index, display_order_code, reason, facility_code)
         VALUES (?, ?, ?, ?, ?)`,
        [jobId, i, r.doc, r.reason || null, r.facility_code || null],
      );
    }
    await conn.commit();
    return jobId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// The full job row, including the Python worker's own progress counters, or null if `id`
// doesn't exist.
async function getOrderPunchJob(id) {
  await ensureSchema();
  const { rows } = await sql`SELECT * FROM order_punch_jobs WHERE id = ${id}`;
  return rows[0] || null;
}

// Marks a job dead on arrival, for the one case Node can detect by itself: the worker Lambda
// invoke was never accepted, so no worker will ever pick this job up. Without this the row sits
// at 'queued' forever and the polling UI can only show a job that looks healthy but is not (the
// 2026-08-21 incident - see triggerLambda's own comment). Every other failure mode is the
// worker's own to record, since only it knows how far it got.
async function failOrderPunchJob(id, message) {
  await ensureSchema();
  await sql`
    UPDATE order_punch_jobs SET status = 'failed', error_message = ${message}, updated_at = NOW()
    WHERE id = ${id}
  `;
}

// Sets the flag the Python worker checks between rows/chunks - see api/order-punch/stop.js.
async function setOrderPunchJobStopRequested(id) {
  await ensureSchema();
  await sql`UPDATE order_punch_jobs SET stop_requested = true, updated_at = NOW() WHERE id = ${id}`;
}

// Every row for a job, in submission order - api/order-punch/results.js's CSV source.
async function getOrderPunchJobRowsForExport(id) {
  await ensureSchema();
  const { rows } = await sql`
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
  await ensureSchema();
  const { rows } = await sql`SELECT \`key\`, value FROM order_punch_settings`;
  const settings = { ...ORDER_PUNCH_SETTINGS_DEFAULTS };
  rows.forEach((r) => { settings[r.key] = r.value; });
  return settings;
}

async function upsertOrderPunchSetting(key, value, updatedBy) {
  await ensureSchema();
  const json = JSON.stringify(value);
  await sql`
    INSERT INTO order_punch_settings (\`key\`, value, updated_by) VALUES (${key}, ${json}, ${updatedBy})
    ON DUPLICATE KEY UPDATE value = ${json}, updated_at = NOW(), updated_by = ${updatedBy}
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

// The live cycle's owning email for one AWB, or '' if there is no live row (never claimed, or its
// cycle already ended). Used by api/ndr/lead-assignment.js's team guard (see its own comment) to
// decide whether a claim/dispose is touching a lead that already belongs to someone else - and,
// if so, which team that someone is on. Deliberately returns '' rather than null for "no row" so
// a caller can treat both "no row" and "row with no email" (email is NOT NULL today, but this
// stays defensive rather than assuming that forever) the same way with one falsy check.
async function getLiveNdrLeadEmail(awbNumber) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT email FROM ndr_lead_assignments WHERE awb_number = ${awbNumber} AND reassigned_away_at IS NULL LIMIT 1
  `;
  return (rows.length && rows[0].email) || '';
}

// NDR's own equivalent of the assignment half of record_lead_assignments (scripts/
// assign_leads.py) - a fresh live cycle for this awb. INSERT IGNORE targets the unique key
// (ndr_lead_assignments_live_awb_key), so a re-claim of an already-live row (a race, or the UI's
// own auto-claim firing twice) is a safe no-op rather than an error - the sheet's own Q/R
// write already decided who holds the lead; this just mirrors that into MySQL.
async function claimNdrLead(awbNumber, email) {
  await ensureSchema();
  await sql`
    INSERT IGNORE INTO ndr_lead_assignments (awb_number, email)
    VALUES (${awbNumber}, ${email})
  `;
  invalidateCache('calling:ndrLeadDates');
}

// NDR's own equivalent of the disposal half of recordLeadDisposition above - updates the live
// row claimNdrLead (or scripts/assign_ndr_leads.py's record_new_assignments) created.
//
// It does NOT assume that row exists. The original version only ever UPDATEd, on the reasoning
// that a disposition can only follow a claim - true of the sheet, but the claim's MySQL half is
// a separate best-effort write that can be missing, and then this UPDATE matches zero rows and
// says nothing. That is how 1,483 disposed NDR leads ended up unrepresented here by 2026-08-25
// (1,257 with no row at all, 226 with a row still showing open) while the sheet was correct
// throughout: every reader of this table - getAllNdrLeadDates, the CRM's Agent Performance
// Summary - was silently behind, with no error anywhere to notice.
//
// So a zero-row UPDATE now inserts the cycle already stamped disposed, which makes the mirror
// self-healing: the assignment half failing no longer loses the disposal too. email is needed
// for that insert (NOT NULL) and is the disposing agent's own - the same value the claim would
// have written.
async function disposeNdrLead(awbNumber, disposition, agentRemarks, email) {
  await ensureSchema();
  const { affectedRows } = await sql`
    UPDATE ndr_lead_assignments
    SET disposed_at = NOW(), disposition = ${disposition || null}, agent_remarks = ${agentRemarks || null}
    WHERE awb_number = ${awbNumber} AND reassigned_away_at IS NULL
  `;
  if (!affectedRows && email) {
    // INSERT IGNORE, same as claimNdrLead: if a concurrent claim won the live key between the
    // UPDATE and here, that row is the real cycle and this disposal is already lost to a race
    // no worse than before - never an error the agent has to see.
    await sql`
      INSERT IGNORE INTO ndr_lead_assignments
        (awb_number, email, disposed_at, disposition, agent_remarks)
      VALUES (${awbNumber}, ${email}, NOW(), ${disposition || null}, ${agentRemarks || null})
    `;
  }
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
// Shipping_Address_City/State/Pincode/Payment_Mode for an AWB, straight from mcaff_prod's
// Item_level_data - same source and per-column latest-row-wins tie-break as the Python side's
// fetch_city_by_awb/fetch_state_by_awb/fetch_pincode_by_awb/fetch_payment_mode_by_awb
// (scripts/sync_delivery_tickets_to_sheet.py). A single-AWB lookup (this fires once per dispose,
// not batched), LIMIT 20 rather than 1: Item_level_data has multiple rows per Tracking_Number
// (split shipments/re-syncs) and the most recent one isn't guaranteed to have every column
// filled, so each field independently takes the newest row that actually has it - not just
// whatever the single latest row happens to carry. Item_level_data has no Payment_Mode column of
// its own, only COD (bigint); derived the same way the Python backfill does: COD = 1 -> 'COD',
// else -> 'Prepaid'. Best-effort: a lookup failure (or the AWB simply not existing there yet)
// must never block the actual disposal - it just leaves these four columns for a later backfill.
async function fetchItemLevelGeoByAwb(awbCode) {
  const empty = { city: null, state: null, pincode: null, paymentMode: null };
  if (!awbCode) return empty;
  try {
    const { rows } = await sql`
      SELECT Shipping_Address_City, Shipping_Address_State, Pincode, COD
      FROM mcaff_prod.Item_level_data
      WHERE Tracking_Number = ${awbCode}
      ORDER BY Created DESC
      LIMIT 20
    `;
    const out = { ...empty };
    for (const r of rows) {
      if (out.city === null && r.Shipping_Address_City) out.city = r.Shipping_Address_City;
      if (out.state === null && r.Shipping_Address_State) out.state = r.Shipping_Address_State;
      if (out.pincode === null && r.Pincode) out.pincode = String(r.Pincode);
      if (out.paymentMode === null && r.COD !== null && r.COD !== undefined) {
        out.paymentMode = Number(r.COD) === 1 ? 'COD' : 'Prepaid';
      }
    }
    return out;
  } catch (e) {
    console.error('fetchItemLevelGeoByAwb: Item_level_data lookup failed for', awbCode, e.message);
    return empty;
  }
}

async function disposeDeliveryEscalationTicket(ticket, email, outcome, agentRemarks) {
  const { brand, orderId, awbCode, deliveryPartner, queryClass, queryCategory, whName, statusAsPerAwb, tat } = ticket;
  const now = new Date();
  const { city, state, pincode, paymentMode } = await fetchItemLevelGeoByAwb(awbCode);
  await sql`
    INSERT INTO Delivery_escalation
      (brand, order_id, awb_code, delivery_partner, query_class, query_category, wh_name,
       status_as_per_awb, tat, agent_email, assigned_at, outcome, agent_remarks, disposed_at,
       Shipping_Address_City, Payment_Mode, Shipping_Address_State, Pincode)
    VALUES (
      ${brand}, ${orderId}, ${awbCode || null}, ${deliveryPartner || null}, ${queryClass || null},
      ${queryCategory || null}, ${whName || null}, ${statusAsPerAwb || null}, ${tat || null},
      ${email || null}, ${now}, ${outcome || null}, ${agentRemarks || null}, ${now},
      ${city}, ${paymentMode}, ${state}, ${pincode}
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
      disposed_at = VALUES(disposed_at),
      Shipping_Address_City = COALESCE(VALUES(Shipping_Address_City), Shipping_Address_City),
      Payment_Mode = COALESCE(VALUES(Payment_Mode), Payment_Mode),
      Shipping_Address_State = COALESCE(VALUES(Shipping_Address_State), Shipping_Address_State),
      Pincode = COALESCE(VALUES(Pincode), Pincode)
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
//
// `tat IS NOT NULL AND` guards the tat comparison for the identical reason - missed the first
// time around. A row whose tat hasn't been backfilled yet (tat NULL, common: 5,724 rows/3,763
// AWBs found live) made this whole OR evaluate to NULL instead of FALSE, which poisoned
// NOT(FORCED) the same way, silently dropping those rows out of Fresh, Forced RTO, AND
// Resolved - visible nowhere except the unconditional `total` tile.
const DE_FORCED_RTO_WHERE = `((tat IS NOT NULL AND tat = 'Forced to be marked as RTO') OR (outcome IS NOT NULL AND (outcome = 'RTO' OR outcome LIKE 'RTO > %')))`;

// A ticket is Fresh while its outcome is blank (never disposed), RTO (an RTO'd order can still
// be re-shipped and later delivered, so it isn't terminal), or Escalated (still waiting on the
// delivery partner) - EXCLUDING Forced RTO, which moved to its own view (DE_FORCED_RTO_WHERE)
// instead of sitting inside Fresh's ordinary RTO rows. Resolved is Delivered ONLY. Matched on
// the top-level outcome label, so a nested "Delivered > <sub-reason>" still counts.
const DE_FRESH_WHERE = `((outcome IS NULL OR outcome = ''
   OR outcome = 'RTO' OR outcome LIKE 'RTO > %'
   OR outcome = 'Escalated' OR outcome LIKE 'Escalated > %')
   AND NOT (${DE_FORCED_RTO_WHERE}))`;
// 'Resolved' is scripts/auto_dispose_de_categories.py's own root: query categories whose
// outcome is known from the category alone (Fake Order RTO -> new order placed, Pincode not
// serviceable -> cancelled and refunded, ...) are stamped by that job rather than clicked
// through by an agent. Nested under one root ON PURPOSE - matching on the top-level label is
// what this clause does, so each such outcome as its own top-level sibling would have landed in
// no view at all (not Fresh, not Resolved, not Forced RTO), the same silent-disappearance the
// two comments above record. Kept separate from 'Delivered' rather than reusing it: those 18.5k
// rows mean the parcel actually reached the customer, which a cancelled-and-refunded or
// POD-requested ticket does not.
// 'Resolved > New order placed' moved to its own tab/view (DE_NEW_ORDER_PLACED_WHERE below) -
// excluded here so it stops double-counting into Resolved's own tile and ticket list.
const DE_RESOLVED_WHERE = `(outcome = 'Delivered' OR outcome LIKE 'Delivered > %'
   OR outcome = 'Resolved' OR (outcome LIKE 'Resolved > %' AND outcome <> 'Resolved > New order placed'))`;
// Its own tab: agent- or auto_dispose_de_categories.py-marked 'Resolved > New order placed' is
// common enough (Fake Order RTO/Pickup Exception/Lost-Damaged-Destroyed all map to it) to want
// its own queue rather than being buried in the wider Resolved list.
const DE_NEW_ORDER_PLACED_WHERE = `(outcome = 'Resolved > New order placed')`;
const DE_VIEW_WHERE = {
  fresh: DE_FRESH_WHERE, resolved: DE_RESOLVED_WHERE, forced_rto: DE_FORCED_RTO_WHERE,
  new_order_placed: DE_NEW_ORDER_PLACED_WHERE,
};

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
//
// getDeliveryEscalationDaywiseStats itself counts DISTINCT awb_code per (date, bucket), not
// rows, so this table's 'unresolved' lines up with the Fresh tile instead of over-counting
// repeat-contact AWBs. That distinct count is taken per date+bucket group, not globally - an
// AWB that legitimately shows up unresolved on two different Query dates (re-escalated later)
// is counted once in each, same tradeoff getDeliveryEscalationRepeatStats already accepts for
// its own per-AWB grouping.
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
    order_date, contact_count, first_added_date, new_order_AWB AS new_order_awb,
    ${DE_TAT_BUCKET_SQL} AS tat_bucket`;

// Same buckets getDeliveryEscalationRepeatStats groups by - reused here so the Total-times-
// user-came filter and that Overview tile can never disagree on what "2-4 times" means.
const DE_CONTACT_BUCKET_RANGES = {
  '1': { sql: 'contact_count = ?', params: [1] },
  '2-4': { sql: 'contact_count BETWEEN ? AND ?', params: [2, 4] },
  '5-9': { sql: 'contact_count BETWEEN ? AND ?', params: [5, 9] },
  '10+': { sql: 'contact_count >= ?', params: [10] },
};

// Same buckets/labels as DE_CONTACT_BUCKET_RANGES above and getDeliveryEscalationRepeatStats'
// own CASE, as a groupable label instead of a filter predicate - for the day-wise table's own
// "TAT by Repeat Contacts" breakdown (getDeliveryEscalationDaywiseStats). contact_count is
// always >= 1 by the time a ticket exists (the sync job/dispose flow both stamp it), so the <= 1
// branch is really just "= 1" written defensively rather than a real 0/negative case.
const DE_CONTACT_BUCKET_SQL = `CASE
    WHEN contact_count <= 1 THEN '1 time'
    WHEN contact_count BETWEEN 2 AND 4 THEN '2-4 times'
    WHEN contact_count BETWEEN 5 AND 9 THEN '5-9 times'
    ELSE '10+ times'
  END`;

// Which date column a query groups/filters rows by - 'added_date' (the Query date shown
// elsewhere on this page) or 'order_date' (when the underlying order was placed, per
// sync_delivery_tickets_to_sheet.py). A whitelist, not user-supplied SQL, since callers below
// interpolate the resolved value as a bare column name rather than binding it as a value.
const DE_DAYWISE_DATE_FIELDS = { added_date: 'added_date', order_date: 'order_date' };

// Every user-supplied value here becomes a bound parameter - none is ever concatenated into
// the SQL text. `agent` is the optional Agent-filter dropdown, a user's own choice of view -
// there is no forced per-agent scope (see the header comment above). `date`/`dateTo` filter on
// dateField's calendar day - 'added_date' (the Query date shown elsewhere on this page, e.g.
// the day-wise table, and the default when dateField is omitted/unrecognized) or 'order_date'
// (when the order was placed) - not disposed_at. dateField is whitelisted via
// DE_DAYWISE_DATE_FIELDS (same map the day-wise table uses) since it's interpolated as a bare
// column name rather than bound as a value. `dateTo` turns the exact-day match into an
// inclusive range - the day-wise table's own month/week drill-down (see
// DeliveryEscalationClient.js's drillIntoDaywise) clicking through to a month or week spans more
// than one day; the plain date picker never sends it, so its single-day behavior is unchanged.
// `tatBucket` matches DE_TAT_BUCKET_SQL's own per-row label (the day-wise table's bucket
// columns, minus its Forced-RTO/Fresh special-casing - see DE_DAYWISE_BUCKET_SQL's own comment
// on why those two are whole views instead) - bound as a value, not interpolated, so it needs no
// whitelist.
function deFilterSql({ search, brand, agent, date, dateTo, dateField, tatBucket, contactBucket } = {}) {
  const clauses = [];
  const params = [];
  if (brand) { clauses.push('brand = ?'); params.push(brand); }
  if (agent) { clauses.push('LOWER(agent_email) = ?'); params.push(String(agent).toLowerCase()); }
  if (date) {
    const col = DE_DAYWISE_DATE_FIELDS[dateField] || 'added_date';
    if (dateTo) { clauses.push(`DATE(${col}) BETWEEN ? AND ?`); params.push(date, dateTo); }
    else { clauses.push(`DATE(${col}) = ?`); params.push(date); }
  }
  if (tatBucket) { clauses.push(`${DE_TAT_BUCKET_SQL} = ?`); params.push(tatBucket); }
  if (contactBucket && DE_CONTACT_BUCKET_RANGES[contactBucket]) {
    const range = DE_CONTACT_BUCKET_RANGES[contactBucket];
    clauses.push(range.sql);
    params.push(...range.params);
  }
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

// Resolved (and New Order Placed, itself a Resolved sub-outcome) reads newest-disposed first;
// Fresh/Forced RTO have no meaningful disposed_at yet, so they read newest-row first. id breaks
// ties so paging can't repeat or skip a row between pages.
function deOrderBy(view) {
  return (view === 'resolved' || view === 'new_order_placed') ? 'disposed_at DESC, id DESC' : 'id DESC';
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
            COUNT(DISTINCT CASE WHEN ${DE_FORCED_RTO_WHERE} THEN awb_code END) AS forcedRto,
            COUNT(DISTINCT CASE WHEN ${DE_NEW_ORDER_PLACED_WHERE} THEN awb_code END) AS newOrderPlaced
     FROM Delivery_escalation WHERE ${where}`, params);
  const r = rows[0] || {};
  return {
    total: Number(r.total) || 0,
    assigned: Number(r.assigned) || 0,
    resolved: Number(r.resolved) || 0,
    fresh: Number(r.fresh) || 0,
    forcedRto: Number(r.forcedRto) || 0,
    newOrderPlaced: Number(r.newOrderPlaced) || 0,
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
// dateField (both here and in deFilterSql above) always measures rows against added_date for
// the day-wise table's own TAT bucket (DE_DAYWISE_BUCKET_SQL) regardless of which column it
// groups by - it only changes which date a row is grouped/filtered under, not how its own
// turnaround is computed.
// Order Date's pre-June-2026 rows are sparse backfill noise (a handful of parcels per month
// going back to May 2024) that swamp the table with mostly-empty rows above where its real
// volume starts - Query Date has no such gap, so this only ever trims the order_date grouping.
const DE_ORDER_DATE_FLOOR = '2026-06-01';

async function getDeliveryEscalationDaywiseStats(opts = {}) {
  const { brand, agent, dateField, partner, paymentMode } = opts;
  const col = DE_DAYWISE_DATE_FIELDS[dateField] || 'added_date';
  const extraClauses = [];
  const params = [];
  if (brand) { extraClauses.push('brand = ?'); params.push(brand); }
  if (agent) { extraClauses.push('LOWER(agent_email) = ?'); params.push(String(agent).toLowerCase()); }
  // partner is a list of raw delivery_partner values the client already resolved from its own
  // canonical-name -> raw-variant map (PARTNER_NAME_MAP in DeliveryEscalationClient.js) - this
  // stays a dumb IN() over whatever it's handed rather than duplicating that map server-side.
  if (Array.isArray(partner) && partner.length) {
    extraClauses.push(`delivery_partner IN (${partner.map(() => '?').join(',')})`);
    params.push(...partner);
  }
  if (paymentMode) { extraClauses.push('Payment_Mode = ?'); params.push(paymentMode); }
  const extra = extraClauses.length ? ` AND ${extraClauses.join(' AND ')}` : '';
  const pool = await getPool();
  // The floor only ever applies to the dated rows query, never to noDateCount below - that one
  // counts order_date IS NULL rows, which "order_date >= floor" would always contradict and
  // silently zero out.
  const floorClause = col === 'order_date' ? ' AND order_date >= ?' : '';
  const floorParams = col === 'order_date' ? [DE_ORDER_DATE_FLOOR] : [];
  // COUNT(DISTINCT awb_code), not COUNT(*) - same "how many parcels, not how many rows" fix
  // getDeliveryEscalationStats' own Fresh tile already applies (see its comment): a repeat-
  // contact AWB gets a fresh ticket_number per day it's still flagged, so row count double-
  // (or triple-, ...) counts it. Ignores NULL/blank awb_code the same way COUNT(DISTINCT) does
  // there too - a ticket with no AWB at all doesn't land in any bucket.
  const [rows] = await pool.execute(`
    SELECT DATE_FORMAT(${col}, '%Y-%m-%d') AS d, COALESCE(delivery_partner, 'Unknown') AS partner, COALESCE(query_category, 'Unknown') AS category, ${DE_CONTACT_BUCKET_SQL} AS contactBucket, ${DE_DAYWISE_BUCKET_SQL} AS bucket, COUNT(DISTINCT awb_code) AS c
    FROM Delivery_escalation
    WHERE ${col} IS NOT NULL${extra}${floorClause}
    GROUP BY d, partner, category, contactBucket, bucket
    ORDER BY d
  `, [...params, ...floorParams]);
  const [[{ noDateCount }]] = await pool.execute(
    `SELECT COUNT(DISTINCT awb_code) AS noDateCount FROM Delivery_escalation WHERE ${col} IS NULL${extra}`, params);

  const zeroCounts = () => Object.fromEntries(DE_DAYWISE_BUCKETS.map((b) => [b, 0]));
  const pctOf = (counts, total) => Object.fromEntries(DE_DAYWISE_BUCKETS.map((b) => [
    b, total ? Math.round((counts[b] / total) * 100) : 0,
  ]));

  const byDate = new Map();
  const grandTotal = zeroCounts();
  let grandTotalAll = 0;
  for (const r of rows) {
    const c = Number(r.c) || 0;
    if (!byDate.has(r.d)) byDate.set(r.d, { date: r.d, counts: zeroCounts(), total: 0, partners: new Map(), categories: new Map(), contactBuckets: new Map() });
    const entry = byDate.get(r.d);
    if (!entry.partners.has(r.partner)) entry.partners.set(r.partner, { partner: r.partner, counts: zeroCounts(), total: 0 });
    const partnerEntry = entry.partners.get(r.partner);
    if (!entry.categories.has(r.category)) entry.categories.set(r.category, { category: r.category, counts: zeroCounts(), total: 0 });
    const categoryEntry = entry.categories.get(r.category);
    if (!entry.contactBuckets.has(r.contactBucket)) {
      entry.contactBuckets.set(r.contactBucket, { contactBucket: r.contactBucket, counts: zeroCounts(), total: 0, partners: new Map() });
    }
    const contactBucketEntry = entry.contactBuckets.get(r.contactBucket);
    // Same raw row already carries partner alongside contactBucket (the SELECT above groups by
    // both together) - folding that pairing into its own map here, instead of throwing it away
    // like the two flat breakdowns above do, is what lets the Repeat Contacts table drill
    // Times Contacted -> Delivery Partner (see groupContactBucketPartnerwiseRows) without a
    // second query.
    if (!contactBucketEntry.partners.has(r.partner)) {
      contactBucketEntry.partners.set(r.partner, { partner: r.partner, counts: zeroCounts(), total: 0 });
    }
    const contactBucketPartnerEntry = contactBucketEntry.partners.get(r.partner);
    entry.counts[r.bucket] += c;
    entry.total += c;
    partnerEntry.counts[r.bucket] += c;
    partnerEntry.total += c;
    categoryEntry.counts[r.bucket] += c;
    categoryEntry.total += c;
    contactBucketEntry.counts[r.bucket] += c;
    contactBucketEntry.total += c;
    contactBucketPartnerEntry.counts[r.bucket] += c;
    contactBucketPartnerEntry.total += c;
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
    pct: pctOf(entry.counts, entry.total),
    partners: [...entry.partners.values()]
      .sort((a, b) => b.total - a.total)
      .map((p) => ({ partner: p.partner, total: p.total, counts: p.counts, pct: pctOf(p.counts, p.total) })),
    categories: [...entry.categories.values()]
      .sort((a, b) => b.total - a.total)
      .map((c) => ({ category: c.category, total: c.total, counts: c.counts, pct: pctOf(c.counts, c.total) })),
    contactBuckets: [...entry.contactBuckets.values()]
      .sort((a, b) => b.total - a.total)
      .map((cb) => ({
        contactBucket: cb.contactBucket, total: cb.total, counts: cb.counts, pct: pctOf(cb.counts, cb.total),
        partners: [...cb.partners.values()]
          .sort((a, b) => b.total - a.total)
          .map((p) => ({ partner: p.partner, total: p.total, counts: p.counts, pct: pctOf(p.counts, p.total) })),
      })),
  }));
  return { buckets: DE_DAYWISE_BUCKETS, rows: rowsOut, grandTotal, grandTotalAll, missingDateCount };
}

// State -> City -> Pincode x Query Category breakdown for the Overview's standalone geo table -
// drilled lazily ONE LEVEL AT A TIME as the client expands a column (level 'state'|'city'
// scoped by state|'pincode' scoped by state+city), same shape as getDeliveryEscalationAwbHistory's
// own fetch-on-expand. Shipping_Address_State/City/Pincode come from Item_level_data via the
// backfill scripts (backfill_delivery_escalation_shipping_city.py /
// backfill_delivery_escalation_state_pincode.py) - plain nullable columns on this table, not
// computed here. Returning every pincode for a whole month in one response could be thousands
// of rows; scoping to whichever branch is actually expanded keeps this well under Lambda's 6MB
// cap regardless of how deep someone drills.
//
// month is 'YYYY-MM' against added_date (Query Date - same basis the tables above this one use).
// Grouped by query_category same as everywhere else on this page, COUNT(DISTINCT awb_code) for
// the same "how many parcels, not how many rows" reason getDeliveryEscalationDaywiseStats uses.
async function getDeliveryEscalationGeoCategoryStats(opts = {}) {
  const { brand, month, level, state, city } = opts;
  if (!month) return { categories: [], rows: [], grandTotal: {}, grandTotalAll: 0 };
  const geoCol = level === 'pincode' ? 'Pincode' : level === 'city' ? 'Shipping_Address_City' : 'Shipping_Address_State';
  const geoKey = level === 'pincode' ? 'pincode' : level === 'city' ? 'city' : 'state';
  const clauses = ['added_date IS NOT NULL', "DATE_FORMAT(added_date, '%Y-%m') = ?"];
  const params = [month];
  if (brand) { clauses.push('brand = ?'); params.push(brand); }
  if (level === 'city' || level === 'pincode') {
    clauses.push("COALESCE(Shipping_Address_State, 'Unknown') = ?");
    params.push(state || 'Unknown');
  }
  if (level === 'pincode') {
    clauses.push("COALESCE(Shipping_Address_City, 'Unknown') = ?");
    params.push(city || 'Unknown');
  }
  const pool = await getPool();
  const [dbRows] = await pool.execute(`
    SELECT COALESCE(query_category, 'Unknown') AS category, COALESCE(${geoCol}, 'Unknown') AS geo, COUNT(DISTINCT awb_code) AS c
    FROM Delivery_escalation
    WHERE ${clauses.join(' AND ')}
    GROUP BY category, geo
  `, params);

  const categoryTotals = new Map();
  const byGeo = new Map();
  for (const r of dbRows) {
    const c = Number(r.c) || 0;
    categoryTotals.set(r.category, (categoryTotals.get(r.category) || 0) + c);
    if (!byGeo.has(r.geo)) byGeo.set(r.geo, { [geoKey]: r.geo, counts: {}, total: 0 });
    const entry = byGeo.get(r.geo);
    entry.counts[r.category] = (entry.counts[r.category] || 0) + c;
    entry.total += c;
  }
  // Same category set and order (by volume) at every level, so a state's/city's/pincode's
  // columns and the outer Grand Total row always line up under the same category rows -
  // categories a branch doesn't have just read 0 (see counts lookup on the client). Always
  // highest-volume first, at every level the client drills into - ties broken alphabetically
  // so equal totals don't jitter between requests.
  const categories = [...categoryTotals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category]) => category);
  const rows = [...byGeo.values()].sort((a, b) => b.total - a.total || String(a[geoKey]).localeCompare(String(b[geoKey])));
  const grandTotal = Object.fromEntries(categories.map((cat) => [cat, categoryTotals.get(cat) || 0]));
  const grandTotalAll = [...categoryTotals.values()].reduce((sum, v) => sum + v, 0);
  return { categories, rows, grandTotal, grandTotalAll };
}

async function getDeliveryEscalationAgents() {
  const { rows } = await sql`
    SELECT DISTINCT agent_email FROM Delivery_escalation
    WHERE agent_email IS NOT NULL AND agent_email != ''
    ORDER BY agent_email
  `;
  return rows.map((r) => r.agent_email);
}

// Every ticket ever raised for one parcel, across ALL views (Fresh/Resolved/Forced RTO) - not
// just the one whose page happened to load it. contact_count already tells the client a repeat
// exists; this is what the client's expand-to-timeline calls to actually fetch the rest, since
// a repeat's other tickets can land anywhere in the id-ordered table, not necessarily on the
// same page as the newest one. Scoped to brand as well as awb_code, matching the same brand
// scoping disposeDeliveryEscalationTicketById's cascade already uses for "this AWB" - a bare
// awb_code isn't guaranteed unique across both brands. No paging: contact_count (bounded, see
// its own sync) keeps this a handful of rows, never the whole table.
async function getDeliveryEscalationAwbHistory(awb, brand) {
  const pool = await getPool();
  const [rows] = await pool.execute(
    `SELECT ${DE_SELECT_COLUMNS} FROM Delivery_escalation WHERE awb_code = ? AND brand = ? ORDER BY id DESC`,
    [awb, brand]
  );
  return rows;
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

// Bulk outcome upload for the Fresh AND Forced RTO tabs, AND the New Order Placed tab's own
// bulk `new_order_AWB` fill-in (see api/delivery-escalation/record.js's 'bulkDispose' action) -
// one UPDATE per row, matching every row with that awb_code THAT'S STILL IN THE UPLOADING TAB'S
// OWN VIEW (DE_VIEW_WHERE[view]): an AWB can
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
  if (view !== 'fresh' && view !== 'forced_rto' && view !== 'new_order_placed') {
    throw new Error(`Unknown Delivery-Escalation bulk-upload view: ${view}`);
  }
  const where = DE_VIEW_WHERE[view];
  const pool = await getPool();
  const results = [];
  for (let i = 0; i < rows.length; i += BULK_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + BULK_CHUNK_SIZE);
    const chunkResults = await Promise.all(chunk.map(async ({ awb, outcome, remarks, newOrderAwb }) => {
      // New Order Placed tab: these rows are already resolved (DE_NEW_ORDER_PLACED_WHERE), so a
      // bulk row here only fills in the reshipped order's own AWB - it must NOT touch
      // outcome/disposed_at/agent_email the way the Fresh/Forced-RTO dispose path below does.
      const [result] = view === 'new_order_placed'
        ? await pool.execute(`
            UPDATE Delivery_escalation
            SET new_order_AWB = ?
            WHERE awb_code = ? AND (${where})
          `, [newOrderAwb, awb])
        : await pool.execute(`
            UPDATE Delivery_escalation
            SET outcome = ?, agent_remarks = ?, disposed_at = NOW(),
                agent_email = ?,
                assigned_at = CASE WHEN assigned_at IS NULL THEN NOW() ELSE assigned_at END
            WHERE awb_code = ? AND (${where})
          `, [outcome, remarks || null, email, awb]);
      return { awb, outcome, newOrderAwb, matched: result.affectedRows || 0 };
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
  // COUNT(DISTINCT order_id) everywhere, not COUNT(*)/SUM(1) - see getCallingCallTrend's own
  // note for the mechanism. Short version: a row is an assignment CYCLE, and re-disposing an
  // already-disposed lead deliberately creates a fresh cycle carrying the same disposition, so
  // counting rows counted one lead's 18 re-opens as 18 conversions. This tile read 282 against
  // the Converted Orders list's 212 on 2026-08-25 for exactly that reason.
  //
  // assigned/pending keep their reassigned_away_at IS NULL predicate, which already limits them
  // to the one live row per order - DISTINCT is a no-op there, kept only so every metric in
  // this tile row is counted the same way and nobody has to work out which ones needed it.
  const { rows } = await sql`
    SELECT
      COUNT(DISTINCT CASE WHEN reassigned_away_at IS NULL AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to}) THEN order_id END) AS total_assigned,
      COUNT(DISTINCT CASE WHEN disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN order_id END) AS total_disposed,
      COUNT(DISTINCT CASE WHEN reassigned_away_at IS NULL AND disposed_at IS NULL AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to}) THEN order_id END) AS total_pending,
      COUNT(DISTINCT CASE WHEN connected = 'Yes' AND disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN order_id END) AS total_connected,
      COUNT(DISTINCT CASE WHEN connected = 'No' AND disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN order_id END) AS total_unreachable,
      COUNT(DISTINCT CASE WHEN (disposition = 'Refund Requested' OR refund_amount IS NOT NULL) AND disposed_at IS NOT NULL AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to}) THEN order_id END) AS total_refunded,
      COUNT(DISTINCT CASE WHEN disposed_at IS NOT NULL
            AND (disposition IN ('Customer Agreed to Accept', 'Product Issue / Exchange') OR new_order_id IS NOT NULL)
            AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
          THEN order_id END) AS total_converted
    FROM CLS_RTO_calling
  `;
  // Refund AMOUNT cannot ride along above: SUM over cycles adds the same refund once per
  // re-dispose, and SUM(DISTINCT) would dedupe by AMOUNT - collapsing two different leads that
  // happen to be refunded the same rupees into one. So it sums one value per order instead.
  const { rows: refundRows } = await sql`
    SELECT COALESCE(SUM(amt), 0) AS total_refund_amount FROM (
      SELECT order_id, MAX(refund_amount) AS amt
      FROM CLS_RTO_calling
      WHERE disposed_at IS NOT NULL AND refund_amount IS NOT NULL
        AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
      GROUP BY order_id
    ) t
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

// Daily dialled/connected/converted for the RTO CRM Overview's Call Trend chart, optionally
// narrowed to a set of agents. Same three definitions as getCallingHourlyStats above, quoted
// rather than re-invented so the chart can never disagree with the Time-of-Day table it sits
// under; same IST offset conversion too, and for the same reason (named zones need zoneinfo
// tables RDS does not guarantee).
//
// DAILY only - week and month are summed in api/_lib/trendChart.js's rollup(). One grouping in
// SQL, one week definition in JS (isoWeekKey, tested), instead of YEARWEEK here and a second
// boundary rule in the chart. A year of daily rows is ~365, free next to the round trip.
//
// COUNT(DISTINCT order_id), not COUNT(*): a row here is an assignment CYCLE, and
// recordLeadDisposition deliberately retires the live row and inserts a fresh cycle every time
// an already-disposed lead is disposed again (that is what stops a re-opened lead from
// overwriting the original agent and inflating FRT - see its own comment). Correct for
// attribution, wrong for counting: the new row carries the same disposition and new_order_id,
// so one lead re-opened 18 times reads as 18 conversions. That is not hypothetical - order
// 9184758 had exactly that on 2026-08-25, and 386 orders desk-wide had more than one disposed
// row that day, 355 of them by the SAME agent. Counting leads instead of cycles is what makes
// this agree with the Converted Orders list, which has always been one row per order.
// Distinct per DAY, so a lead re-dialled on two days counts on each of them.
//
// Unlike getCallingHourlyStats this reads EVERY cycle (no reassigned_away_at filter), matching
// that function's disposed half: a lead a previous agent already worked and lost still cost
// that agent a dial, and dropping retired cycles would quietly understate call volume.
//
// agents: array of emails, or empty/absent for everyone. Matched with FIND_IN_SET over one
// comma-joined parameter rather than a built IN (...) list - it keeps this a single prepared
// statement with a fixed placeholder count (sql`` binds one ? per interpolation and does not
// expand arrays), and an email cannot contain a comma. The range scan on disposed_at is what
// bounds this query either way.
async function getCallingCallTrend({ dateFrom, dateTo, agents } = {}) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const agentList = (Array.isArray(agents) ? agents : String(agents || '').split(','))
    .map((a) => String(a || '').trim().toLowerCase()).filter(Boolean).join(',');
  const { rows } = await sql`
    SELECT
      DATE(CONVERT_TZ(disposed_at, '+00:00', '+05:30')) AS bucket,
      COUNT(DISTINCT order_id) AS dialled,
      COUNT(DISTINCT CASE WHEN connected = 'Yes' THEN order_id END) AS connected,
      COUNT(DISTINCT CASE WHEN disposition IN ('Customer Agreed to Accept', 'Product Issue / Exchange') OR new_order_id IS NOT NULL THEN order_id END) AS converted
    FROM CLS_RTO_calling
    WHERE disposed_at IS NOT NULL
      AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
      AND (${agentList} = '' OR FIND_IN_SET(LOWER(agent_email), ${agentList}) > 0)
    GROUP BY 1
    ORDER BY 1
  `;
  // A DATE column comes back as a JS Date from mysql2; the chart keys on 'YYYY-MM-DD' strings.
  // Formatted from the UTC parts, not toISOString-after-local-parse, which would shift the day
  // for anyone running this outside UTC.
  return rows.map((r) => ({
    bucket: r.bucket instanceof Date
      ? `${r.bucket.getFullYear()}-${String(r.bucket.getMonth() + 1).padStart(2, '0')}-${String(r.bucket.getDate()).padStart(2, '0')}`
      : String(r.bucket),
    dialled: Number(r.dialled) || 0,
    connected: Number(r.connected) || 0,
    converted: Number(r.converted) || 0,
  }));
}

// Per-agent, per-15-minute-of-day counts for the RTO CRM Overview's Time-of-Day Distribution
// table. That table used to be computed in the browser from the sheet, which cannot see the
// whole picture: the sheet only ever holds a lead's CURRENT cycle (a reassignment wipes Q:U for
// the new agent), so every retired cycle was invisible to it. On 2026-08-25 that was 70 of 282
// conversions - the table said 212 while the KPI tile beside it said 282, and the difference
// was one agent's 45 reassigned-away rows. Reading MySQL directly makes the two agree.
//
// 15 minutes because that is the finest bucket the table offers (heatmapIntervalOptions:
// 15/30/60); the client sums adjacent buckets for the coarser two rather than refetching. All
// three metrics come back in one row for the same reason - switching the metric dropdown is
// then free. ~12 agents x 96 buckets is a trivial result set even before the date filter.
//
// Every cycle, no reassigned_away_at filter - same grain as getCallingOverviewStats' disposed/
// connected/converted, and the whole point of this function.
//
// COUNT(DISTINCT order_id), not COUNT(*): a row here is an assignment CYCLE, and
// recordLeadDisposition deliberately retires the live row and inserts a fresh cycle every time
// an already-disposed lead is disposed again (that is what stops a re-opened lead from
// overwriting the original agent and inflating FRT - see its own comment). Correct for
// attribution, wrong for counting: the new row carries the same disposition and new_order_id,
// so one lead re-opened 18 times reads as 18 conversions. That is not hypothetical - order
// 9184758 had exactly that on 2026-08-25, and 386 orders desk-wide had more than one disposed
// row that day, 355 of them by the SAME agent. Counting leads instead of cycles is what makes
// this agree with the Converted Orders list, which has always been one row per order.
// Distinct WITHIN a bucket: a lead genuinely re-dialled hours later counts in both buckets,
// which is what a time-of-day view is asking about.
async function getCallingTimeOfDay({ dateFrom, dateTo } = {}) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  // Collapsed per (agent, lead, day) FIRST, then bucketed by that lead's earliest disposal.
  // Deduping inside each bucket instead would leave a lead re-disposed an hour later counted in
  // two buckets - the column sums would then overshoot the day's real total (217 against 213
  // when measured on 2026-08-25), and this table's own Team Total is a sum of its columns.
  // Attributing each lead to where its work STARTED keeps that total honest.
  const { rows } = await sql`
    SELECT
      agent_email,
      FLOOR((HOUR(first_at) * 60 + MINUTE(first_at)) / 15) AS bucket15,
      COUNT(*) AS dialled,
      SUM(was_connected) AS connected,
      SUM(was_converted) AS converted
    FROM (
      SELECT
        LOWER(agent_email) AS agent_email,
        order_id,
        MIN(CONVERT_TZ(disposed_at, '+00:00', '+05:30')) AS first_at,
        MAX(connected = 'Yes') AS was_connected,
        MAX(disposition IN ('Customer Agreed to Accept', 'Product Issue / Exchange') OR new_order_id IS NOT NULL) AS was_converted
      FROM CLS_RTO_calling
      WHERE disposed_at IS NOT NULL AND agent_email IS NOT NULL AND agent_email <> ''
        AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
      GROUP BY 1, 2, DATE(CONVERT_TZ(disposed_at, '+00:00', '+05:30'))
    ) t
    GROUP BY 1, 2
  `;
  return rows.map((r) => ({
    agentEmail: r.agent_email,
    bucket15: Number(r.bucket15) || 0,
    dialled: Number(r.dialled) || 0,
    connected: Number(r.connected) || 0,
    converted: Number(r.converted) || 0,
  }));
}

async function getCallingTimeOfDayData(query) {
  const { dateFrom, dateTo } = query || {};
  return { buckets: await getCallingTimeOfDay({ dateFrom, dateTo }) };
}

// The payload api/report/data/[key].js's "calling-trend" route serves. Thin on purpose: the
// route hands over req.query verbatim, so the coercion of agents (a repeated or comma-joined
// query param) lives in one place rather than in every caller.
async function getCallingTrendData(query) {
  const { dateFrom, dateTo, agents } = query || {};
  return { daily: await getCallingCallTrend({ dateFrom, dateTo, agents }) };
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
  await ensureSchema();
  const { rows } = await sql`
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
  await ensureSchema();
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
    await sql`
      INSERT INTO calling_business_hours (process_key, day, open_time, close_time, updated_at, updated_by)
      VALUES (${processKey}, ${day}, ${open}, ${close}, NOW(), ${updatedBy || null})
      ON DUPLICATE KEY UPDATE
        open_time = VALUES(open_time),
        close_time = VALUES(close_time),
        updated_at = VALUES(updated_at),
        updated_by = VALUES(updated_by)
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

const { filterRosterByTeam } = require('./callingTeams');

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
async function getCallingProcessAgents(processKey, teamId) {
  await ensureSchema();
  // Membership has to follow the same convention the rest of the app uses: holding the
  // 'calling' card with NO tab rows means unrestricted - every process - so those people
  // belong in every process's roster. An earlier version required an explicit tab row, which
  // listed only the handful of people who happened to have one and silently omitted everybody
  // with blanket access (including a process admin, who then couldn't see their own roster).
  //
  // So: in if you hold the card and either have no calling tab rows at all, or have one for
  // THIS process. Global admins are always in, since they hold no tab rows by convention.
  // Neither query depends on the other's result - they're only combined in JS below (byEmail)
  // - both now against the same MySQL pool, so this Promise.all just avoids a round-trip wait.
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
    sql`
      SELECT email, status, max_quota, is_process_admin, prepaid_pct, priority_rto_reasons,
             reassign_payment_mode, attempt_count_filter, ndr_reason_filter, ndr_payment_mode_filter,
             ndr_brand_filter, team_id, updated_at, updated_by
      FROM calling_agent_process WHERE process_key = ${processKey}
    `,
  ]);
  const byEmail = {};
  for (const s of state) byEmail[String(s.email).toLowerCase()] = s;
  const mapped = members.map((m) => {
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
      // null means "no team", which for a team-scoped view means excluded from every real
      // team's roster - the INVERSE of the report_tab_permissions convention above (membership
      // query) where absence of a tab row means unrestricted/every-process. Two tables, two
      // opposite meanings for "no row" - worth spelling out because it's exactly the kind of
      // thing that looks like a copy-paste bug later. An agent with no calling_agent_process
      // row at all (s is undefined) must surface null here, not undefined, so
      // filterRosterByTeam's strict equality check excludes them rather than an `undefined ===
      // teamId` accidentally matching nothing OR everything depending on caller.
      teamId: s && s.team_id != null ? s.team_id : null,
      updatedAt: (s && s.updated_at) || null,
      updatedBy: (s && s.updated_by) || null,
    };
  });
  // teamId === undefined leaves this array reference untouched, which is what keeps
  // api/escalation/[action].js, api/auth/[action].js and api/admin/[action].js's existing
  // one-argument calls working with zero behaviour change - see filterRosterByTeam's own
  // contract comment in callingTeams.js.
  return filterRosterByTeam(mapped, teamId);
}

// Upserts one agent's status and/or quota for one process. Either field may be omitted, so an
// agent flipping their own status can't accidentally reset a quota an admin set.
async function setCallingProcessAgent(processKey, email, { status, maxQuota, isProcessAdmin, prepaidPct, priorityRtoReasons, reassignPaymentMode, attemptCountFilter, ndrReasonFilter, ndrPaymentModeFilter, ndrBrandFilter, teamId } = {}, updatedBy) {
  await ensureSchema();
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
  // team_id needs a THIRD state that COALESCE(new, old) cannot express on its own: undefined =
  // leave the stored team alone (COALESCE would handle this fine), a number = assign that team
  // (COALESCE handles this too) - but null = explicitly UNASSIGN, and COALESCE(NULL, team_id)
  // just keeps the old value, the opposite of an explicit clear. So this uses the same
  // "sentinel flag + IF()" shape as adminFlag above, but adminFlag's flag (null) doubles as
  // its own "leave alone" value, which doesn't work here because null is also the value we
  // need to WRITE for "unassign". touchTeam separates "was teamId supplied at all" from "what
  // should it be set to", and the ON DUPLICATE KEY UPDATE clause below uses IF(touchTeam, ...)
  // instead of COALESCE for this one column.
  //
  // The revoke path in api/admin/[action].js (DELETE /api/admin/calling-agents) depends on the
  // null case: without an explicit unassign, a revoked agent keeps their team_id and silently
  // rejoins that team's roster and metrics the moment anyone re-invites them - the access grant
  // and the team membership would then disagree about who belongs where.
  const touchTeam = teamId !== undefined;
  let teamValue = null;
  if (touchTeam && teamId !== null) {
    teamValue = parseInt(teamId, 10);
    if (!Number.isFinite(teamValue) || teamValue <= 0) throw new Error('teamId must be a positive whole number or null');
  }
  await sql`
    INSERT INTO calling_agent_process (email, process_key, status, max_quota, is_process_admin, prepaid_pct, priority_rto_reasons, reassign_payment_mode, attempt_count_filter, ndr_reason_filter, ndr_payment_mode_filter, ndr_brand_filter, team_id, updated_at, updated_by)
    VALUES (${key}, ${processKey}, ${status || 'Offline'}, ${quota}, ${adminFlag === null ? false : adminFlag}, ${prepaidTarget}, ${reasonsText || ''}, ${reassignModeText || ''}, ${attemptFilterText || ''}, ${ndrReasonFilterText || ''}, ${ndrPaymentModeFilterText || ''}, ${ndrBrandFilterText || ''}, ${touchTeam ? teamValue : null}, NOW(), ${updatedBy || null})
    ON DUPLICATE KEY UPDATE
      status = COALESCE(${status || null}, status),
      max_quota = COALESCE(${quota}, max_quota),
      is_process_admin = COALESCE(${adminFlag}, is_process_admin),
      prepaid_pct = COALESCE(${prepaidTarget}, prepaid_pct),
      priority_rto_reasons = COALESCE(${reasonsText}, priority_rto_reasons),
      reassign_payment_mode = COALESCE(${reassignModeText}, reassign_payment_mode),
      attempt_count_filter = COALESCE(${attemptFilterText}, attempt_count_filter),
      team_id = IF(${touchTeam}, ${teamValue}, team_id),
      ndr_reason_filter = COALESCE(${ndrReasonFilterText}, ndr_reason_filter),
      ndr_payment_mode_filter = COALESCE(${ndrPaymentModeFilterText}, ndr_payment_mode_filter),
      ndr_brand_filter = COALESCE(${ndrBrandFilterText}, ndr_brand_filter),
      updated_at = NOW(),
      updated_by = ${updatedBy || null}
  `;
  return getCallingProcessAgents(processKey);
}

// Does this person administer this ONE process? Used to let a process admin through the
// admin routes for their own process only - it is not company-wide admin (users.is_admin) and
// must never be treated as such.
async function isCallingProcessAdmin(email, processKey) {
  await ensureSchema();
  if (!email || !processKey) return false;
  const { rows } = await sql`
    SELECT 1 FROM calling_agent_process
    WHERE LOWER(email) = ${String(email).toLowerCase()}
      AND process_key = ${processKey}
      AND is_process_admin = true
    LIMIT 1
  `;
  return rows.length > 0;
}

// Every process this person administers, for narrowing what a process admin is shown.
async function getAdministeredProcesses(email) {
  await ensureSchema();
  if (!email) return [];
  const { rows } = await sql`
    SELECT process_key FROM calling_agent_process
    WHERE LOWER(email) = ${String(email).toLowerCase()} AND is_process_admin = true
  `;
  return rows.map((r) => r.process_key);
}

// ── Per-team registry (calling_teams) ────────────────────────────────────────────────────
// A team is a dimension inside a process; see the table's own comment in bootstrapSchema.

const { isValidSheetId, normalizeTeamName, SHEET_TAB_MAX } = require('./callingTeams');
const { planTreeClone } = require('./dispositionTrees');

function mapTeamRow(r) {
  return {
    id: r.id,
    processKey: r.process_key,
    name: r.name,
    sheetId: r.sheet_id,
    sheetTab: r.sheet_tab,
    active: !!r.active,
  };
}

async function listCallingTeams(processKey, { includeInactive = false } = {}) {
  await ensureSchema();
  if (!processKey) return [];
  const { rows } = includeInactive
    ? await sql`SELECT * FROM calling_teams WHERE process_key = ${processKey} ORDER BY name ASC`
    : await sql`SELECT * FROM calling_teams WHERE process_key = ${processKey} AND active = true ORDER BY name ASC`;
  return rows.map(mapTeamRow);
}

// processKey is optional and, when given, filters the lookup to that process too - defense in
// depth so a team id can never resolve to a row belonging to a DIFFERENT process's team. The
// concrete risk this closes: api/ndr/sheet.js's resolveSheetFor calls this with a
// calling_agent_process.team_id read straight from the DB, on an Editor-scoped write path (the
// service account has Editor access on whatever sheetId the resolved row carries) - the admin UI
// ties team_id to process_key at creation so this should be unreachable in practice, but an
// admin fat-finger or a future bug in that UI would otherwise let it silently steer NDR traffic
// at some OTHER process's team's sheet. Left optional (not required) because updateCallingTeam's
// own initial lookup below has to find the row BEFORE it can know what process it belongs to.
async function getCallingTeam(id, processKey) {
  await ensureSchema();
  const teamId = parseInt(id, 10);
  if (!Number.isFinite(teamId)) return null;
  const { rows } = processKey
    ? await sql`SELECT * FROM calling_teams WHERE id = ${teamId} AND process_key = ${processKey} LIMIT 1`
    : await sql`SELECT * FROM calling_teams WHERE id = ${teamId} LIMIT 1`;
  return rows.length ? mapTeamRow(rows[0]) : null;
}

// sheetId is validated here as well as at the route, because this is the last line before a
// value an admin typed becomes the URL path of a request made with an Editor-scoped service
// account credential.
function assertTeamFields({ name, sheetId, sheetTab }) {
  const cleanName = normalizeTeamName(name);
  if (!cleanName) throw new Error('Team name is required');
  if (!isValidSheetId(sheetId)) {
    throw new Error('sheetId must be a Google Sheets file id (letters, digits, - and _ only) - not a full URL');
  }
  const cleanTab = (sheetTab == null ? '' : String(sheetTab));
  // NOT trimmed: the live NDR tab is literally named 'Latest NDR ' with a trailing space, and
  // trimming it would produce a range string Sheets cannot resolve. Capped (not silently sliced)
  // at the column's own VARCHAR(120) width instead: MySQL would otherwise truncate an oversized
  // value on INSERT/UPDATE with no error in non-strict mode, storing a tab name that never
  // matches the live sheet and produces a Sheets range string that resolves to nothing - a
  // thrown, readable error here is strictly better than that silent, unresolvable write.
  if (!cleanTab) throw new Error('sheetTab is required');
  if (cleanTab.length > SHEET_TAB_MAX) {
    throw new Error(`sheetTab must be ${SHEET_TAB_MAX} characters or fewer (this column is VARCHAR(${SHEET_TAB_MAX}))`);
  }
  return { cleanName, cleanTab };
}

async function createCallingTeam(processKey, { name, sheetId, sheetTab }, byEmail) {
  await ensureSchema();
  if (!processKey) throw new Error('processKey is required');
  const { cleanName, cleanTab } = assertTeamFields({ name, sheetId, sheetTab });
  const { insertId } = await sql`
    INSERT INTO calling_teams (process_key, name, sheet_id, sheet_tab, created_by, updated_by)
    VALUES (${processKey}, ${cleanName}, ${sheetId}, ${cleanTab}, ${byEmail || null}, ${byEmail || null})
  `;
  // A new team starts with a copy of the process's shared tree, so its lead edits a real list
  // instead of building one from scratch before their agents can dispose anything. Deliberately
  // NOT fatal to team creation: a clone that fails leaves an empty tree, and
  // getProcessDispositions falls back to the shared list for exactly that case - the team still
  // works, and the admin can re-run scripts/migrate_team_dispositions.py to fill it in.
  try {
    const { rows } = await sql`
      SELECT id, parent_id, label, description, sort_order, children_input_type
      FROM calling_process_dispositions
      WHERE process_key = ${processKey} AND team_id IS NULL
      ORDER BY sort_order ASC, id ASC
    `;
    const plan = planTreeClone(rows.map((r) => ({
      id: r.id, parentId: r.parent_id, label: r.label, description: r.description,
      sortOrder: r.sort_order, childrenInputType: r.children_input_type,
    })));
    const realIdByTempKey = new Map();
    for (const p of plan) {
      // One INSERT per row, not a batch: a child's parent_id is unknown until its parent's insert
      // has returned an id.
      const { insertId: newId } = await sql`
        INSERT INTO calling_process_dispositions
          (process_key, team_id, parent_id, label, description, sort_order, children_input_type, created_by)
        VALUES (${processKey}, ${insertId}, ${p.parentTempKey == null ? null : realIdByTempKey.get(p.parentTempKey)},
                ${p.label}, ${p.description}, ${p.sortOrder}, ${p.childrenInputType}, ${byEmail || null})
      `;
      realIdByTempKey.set(p.tempKey, newId);
    }
  } catch (e) {
    console.error('createCallingTeam: disposition clone failed for team', insertId, e);
    // A mid-loop failure leaves whatever rows already inserted for this team - not an empty
    // tree - so the getProcessDispositions fallback (which only fires on ZERO rows) would never
    // kick in and the team would be stuck with a partial tree forever. Wipe it back to zero rows.
    await sql`DELETE FROM calling_process_dispositions WHERE team_id = ${insertId}`;
  }
  return getCallingTeam(insertId, processKey);
}

async function updateCallingTeam(id, { name, sheetId, sheetTab, active }, byEmail) {
  await ensureSchema();
  const existing = await getCallingTeam(id);
  if (!existing) throw new Error('No such team');
  const next = {
    name: name === undefined ? existing.name : name,
    sheetId: sheetId === undefined ? existing.sheetId : sheetId,
    sheetTab: sheetTab === undefined ? existing.sheetTab : sheetTab,
  };
  const { cleanName, cleanTab } = assertTeamFields(next);
  const nextActive = active === undefined ? existing.active : !!active;
  await sql`
    UPDATE calling_teams
       SET name = ${cleanName}, sheet_id = ${next.sheetId}, sheet_tab = ${cleanTab},
           active = ${nextActive}, updated_at = NOW(), updated_by = ${byEmail || null}
     WHERE id = ${existing.id}
  `;
  // No invalidateCache call here (there used to be one, keyed by teamCacheKey('calling:teams',
  // ...)) - listCallingTeams never goes through cachedRead, so that call invalidated nothing. It
  // read as a working cache-invalidation and wasn't; removed rather than kept as camouflage for a
  // cache this function doesn't have. Do not re-add it without also making listCallingTeams
  // actually cached - see F9's own note in the final-review report for why.
  return getCallingTeam(existing.id, existing.processKey);
}

// The caller's own team, plus how many ACTIVE teams the process has - both inputs to
// teamScopeFor(). Returns callerTeamId null for anyone with no calling_agent_process row, which
// includes every full admin by convention (see getCallingProcessAgents' own note).
//
// Deliberately NOT cached: a stale answer here is a stale ANSWER TO "whose data may I see",
// and readCache is per-warm-container with a 5-minute TTL, so an agent moved between teams
// could keep reading the old team for minutes. The two SELECTs are indexed point reads.
async function resolveCallerTeam(email, processKey) {
  await ensureSchema();
  if (!email || !processKey) return { callerTeamId: null, activeTeamCount: 0 };
  const [{ rows: mine }, { rows: counted }] = await Promise.all([
    sql`
      SELECT team_id FROM calling_agent_process
      WHERE LOWER(email) = ${String(email).toLowerCase()} AND process_key = ${processKey}
      LIMIT 1
    `,
    sql`SELECT COUNT(*) AS n FROM calling_teams WHERE process_key = ${processKey} AND active = true`,
  ]);
  return {
    callerTeamId: mine.length && mine[0].team_id != null ? mine[0].team_id : null,
    activeTeamCount: Number((counted[0] && counted[0].n) || 0),
  };
}

// ── Per-process admin-defined disposition list (see calling_process_dispositions above) ────
// Arbitrary nesting depth - any option, at any depth, can have its own child sub-options.
// parent_id is self-referencing with no depth check, and getProcessDispositions' two-pass
// build already links children regardless of how deep they are.
const DISPOSITION_LABEL_MAX = 120;

// teamId null = the shared tree (team_id IS NULL), which is what every process without a split
// has always used. A teamId whose tree is EMPTY falls back to that shared tree rather than
// returning [] - an agent handed an empty picker cannot dispose a call at all, so a team created
// before its clone ran (or whose clone failed) must not take its agents off the phones. See the
// spec's resolution rules.
async function getProcessDispositions(processKey, teamId = null) {
  await ensureSchema();
  if (!processKey) return [];
  // sql() executes eagerly (it's `await p.execute(...)` inside, not a lazy fragment builder), so
  // a nested `${sql\`...\`}` fragment would stringify a Promise into the outer query text - two
  // separate literal queries instead of building SQL by concatenation.
  const fetchRows = async (team) => (team == null
    ? (await sql`
        SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
        WHERE process_key = ${processKey} AND team_id IS NULL
        ORDER BY sort_order ASC, id ASC`).rows
    : (await sql`
        SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
        WHERE process_key = ${processKey} AND team_id = ${team}
        ORDER BY sort_order ASC, id ASC`).rows);
  let rows;
  try {
    rows = await fetchRows(teamId);
    if (!rows.length && teamId != null) rows = await fetchRows(null);
  } catch (e) {
    // Unlike the release-1 team-isolation softening (api/_lib/callingTeams.js), this migration
    // is NOT order-independent: the column can be deployed before the api/ code that selects it
    // is live. Rather than require a strict deploy order, retry as a plain pre-migration read
    // (no team_id predicate - the column doesn't exist yet, so there is no team to filter by).
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    rows = (await sql`
      SELECT id, parent_id, label, description, sort_order, children_input_type FROM calling_process_dispositions
      WHERE process_key = ${processKey}
      ORDER BY sort_order ASC, id ASC`).rows;
  }
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
async function addProcessDisposition(processKey, label, description, createdBy, parentId, teamId = null) {
  await ensureSchema();
  if (!processKey) throw new Error('processKey is required');
  const trimmed = String(label || '').trim();
  if (!trimmed) throw new Error('A disposition label is required');
  if (trimmed.length > DISPOSITION_LABEL_MAX) throw new Error(`Label must be ${DISPOSITION_LABEL_MAX} characters or fewer`);
  const parent = parentId || null;
  if (parent) {
    // The parent must live in the SAME tree - without the team_id term a Team Lead could pass
    // the other team's parent id and graft a child onto their tree.
    const { rows: parentRows } = teamId == null
      ? await sql`SELECT id FROM calling_process_dispositions WHERE id = ${parent} AND process_key = ${processKey} AND team_id IS NULL`
      : await sql`SELECT id FROM calling_process_dispositions WHERE id = ${parent} AND process_key = ${processKey} AND team_id = ${teamId}`;
    if (!parentRows.length) throw new Error('Parent option not found for this process');
  }
  const maxRows = teamId == null
    ? (parent
      ? (await sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM calling_process_dispositions WHERE process_key = ${processKey} AND parent_id = ${parent} AND team_id IS NULL`).rows
      : (await sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM calling_process_dispositions WHERE process_key = ${processKey} AND parent_id IS NULL AND team_id IS NULL`).rows)
    : (parent
      ? (await sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM calling_process_dispositions WHERE process_key = ${processKey} AND parent_id = ${parent} AND team_id = ${teamId}`).rows
      : (await sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM calling_process_dispositions WHERE process_key = ${processKey} AND parent_id IS NULL AND team_id = ${teamId}`).rows);
  await sql`
    INSERT INTO calling_process_dispositions (process_key, team_id, parent_id, label, description, sort_order, created_by)
    VALUES (${processKey}, ${teamId ?? null}, ${parent}, ${trimmed}, ${String(description || '').trim() || null}, ${maxRows[0].next}, ${createdBy || null})
  `;
  return getProcessDispositions(processKey, teamId);
}

// label/description are independently optional - omitting one (undefined) leaves it
// untouched, same "unset means leave it alone" contract setCallingProcessAgent already uses
// for its own optional fields. An explicitly blank description ('') really does clear it;
// label can never be blanked out this way since a disposition must always have a name.
// Works the same regardless of whether id is a top-level option or a child - nesting depth
// never changes once an option is created.
async function updateProcessDisposition(processKey, id, { label, description, childrenInputType } = {}, teamId = null) {
  await ensureSchema();
  if (!processKey || !id) throw new Error('processKey and id are required');
  const labelText = label === undefined ? null : String(label).trim();
  if (label !== undefined && !labelText) throw new Error('A disposition label is required');
  if (labelText && labelText.length > DISPOSITION_LABEL_MAX) throw new Error(`Label must be ${DISPOSITION_LABEL_MAX} characters or fewer`);
  const descText = description === undefined ? null : String(description || '').trim();
  if (childrenInputType !== undefined && !['single', 'multi', 'text'].includes(childrenInputType)) {
    throw new Error("childrenInputType must be 'single', 'multi', or 'text'");
  }
  // Existence checked separately, not via affected-row count: MySQL's affectedRows only counts
  // rows actually CHANGED, not matched (unlike Postgres's RETURNING) - a no-op update (every
  // field already equal to what's being set) would otherwise look like "not found". The team
  // term on both queries means an id from another team's tree simply does not match, and this
  // same "not found" error covers it - no separate cross-team error needed.
  const { rows: existing } = teamId == null
    ? await sql`SELECT id FROM calling_process_dispositions WHERE id = ${id} AND process_key = ${processKey} AND team_id IS NULL`
    : await sql`SELECT id FROM calling_process_dispositions WHERE id = ${id} AND process_key = ${processKey} AND team_id = ${teamId}`;
  if (!existing.length) throw new Error('Disposition not found for this process');
  if (teamId == null) {
    await sql`
      UPDATE calling_process_dispositions
      SET label = COALESCE(${labelText}, label),
          description = COALESCE(${descText}, description),
          children_input_type = COALESCE(${childrenInputType ?? null}, children_input_type)
      WHERE id = ${id} AND process_key = ${processKey} AND team_id IS NULL
    `;
  } else {
    await sql`
      UPDATE calling_process_dispositions
      SET label = COALESCE(${labelText}, label),
          description = COALESCE(${descText}, description),
          children_input_type = COALESCE(${childrenInputType ?? null}, children_input_type)
      WHERE id = ${id} AND process_key = ${processKey} AND team_id = ${teamId}
    `;
  }
  return getProcessDispositions(processKey, teamId);
}

// Cascades to children automatically (ON DELETE CASCADE on parent_id) - deleting a parent
// option takes its whole child list with it.
async function deleteProcessDisposition(processKey, id, teamId = null) {
  await ensureSchema();
  if (!processKey || !id) throw new Error('processKey and id are required');
  if (teamId == null) {
    await sql`DELETE FROM calling_process_dispositions WHERE id = ${id} AND process_key = ${processKey} AND team_id IS NULL`;
  } else {
    await sql`DELETE FROM calling_process_dispositions WHERE id = ${id} AND process_key = ${processKey} AND team_id = ${teamId}`;
  }
  return getProcessDispositions(processKey, teamId);
}

// Full reorder in one shot within ONE scope - either every top-level option (parentId
// omitted/null), or one specific parent's children (parentId set). The extra
// parent_id-matching WHERE clause is a safety net, not just a filter: if a client ever sent
// an id that doesn't actually belong to the claimed scope, that row's update simply affects 0
// rows instead of silently reparenting/misordering something in a different scope.
// Transactional so a request that fails partway through never leaves sort_order in a
// half-renumbered state.
async function reorderProcessDispositions(processKey, parentId, orderedIds, teamId = null) {
  await ensureSchema();
  if (!processKey) throw new Error('processKey is required');
  if (!Array.isArray(orderedIds) || !orderedIds.length) throw new Error('orderedIds must be a non-empty array');
  const parent = parentId || null;
  const p = await getPool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < orderedIds.length; i++) {
      if (parent) {
        await conn.execute(
          teamId == null
            ? 'UPDATE calling_process_dispositions SET sort_order = ? WHERE id = ? AND process_key = ? AND parent_id = ? AND team_id IS NULL'
            : 'UPDATE calling_process_dispositions SET sort_order = ? WHERE id = ? AND process_key = ? AND parent_id = ? AND team_id = ?',
          teamId == null ? [i, orderedIds[i], processKey, parent] : [i, orderedIds[i], processKey, parent, teamId]
        );
      } else {
        await conn.execute(
          teamId == null
            ? 'UPDATE calling_process_dispositions SET sort_order = ? WHERE id = ? AND process_key = ? AND parent_id IS NULL AND team_id IS NULL'
            : 'UPDATE calling_process_dispositions SET sort_order = ? WHERE id = ? AND process_key = ? AND parent_id IS NULL AND team_id = ?',
          teamId == null ? [i, orderedIds[i], processKey] : [i, orderedIds[i], processKey, teamId]
        );
      }
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getProcessDispositions(processKey, teamId);
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

// Bucketing of the sheet's free-text rto_reason into the fixed category set used by
// getCallingRtoReasonBreakdown/-Funnel below. Moved to its own module so the RTO CRM's
// Team Roster picker can group its options under the SAME headings without a second copy
// of the keyword rules drifting from this one - see that file for why keywords, not a map.
const { categorizeRtoReason } = require('./rtoReasonCategory');

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
async function getCallingRtoReasonBreakdown(dateFrom, dateTo, paymentMode, brand) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const mode = paymentMode === 'Prepaid' || paymentMode === 'COD' ? paymentMode : null;
  // Brand has no column of its own - it's derived from Order ID, same rule as brand_of()
  // in scripts/assign_ndr_leads.py. IF(...) reproduces that derivation in SQL so the filter
  // can never disagree with what the app calls this order elsewhere.
  const brandFilter = brand === 'Hyphen' || brand === 'mCaffeine' ? brand : null;
  const { rows } = await sql`
    SELECT
      COALESCE(rto_reason, 'Unknown') AS rto_reason,
      SUM(CASE WHEN reassigned_away_at IS NULL
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${brandFilter} IS NULL OR IF(UPPER(order_id) LIKE 'HYP%', 'Hyphen', 'mCaffeine') = ${brandFilter})
            AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to})
          THEN 1 ELSE 0 END) AS total_assigned,
      SUM(CASE WHEN disposed_at IS NOT NULL AND connected = 'Yes'
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${brandFilter} IS NULL OR IF(UPPER(order_id) LIKE 'HYP%', 'Hyphen', 'mCaffeine') = ${brandFilter})
            AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
          THEN 1 ELSE 0 END) AS total_connected,
      SUM(CASE WHEN disposed_at IS NOT NULL
            AND (disposition IN ('Customer Agreed to Accept', 'Product Issue / Exchange') OR new_order_id IS NOT NULL)
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${brandFilter} IS NULL OR IF(UPPER(order_id) LIKE 'HYP%', 'Hyphen', 'mCaffeine') = ${brandFilter})
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
async function getCallingPartnerReasonBreakdown(dateFrom, dateTo, paymentMode, brand) {
  await ensureSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const mode = paymentMode === 'Prepaid' || paymentMode === 'COD' ? paymentMode : null;
  const brandFilter = brand === 'Hyphen' || brand === 'mCaffeine' ? brand : null;
  const { rows } = await sql`
    SELECT
      COALESCE(delivery_partner, 'Unknown') AS partner,
      COALESCE(rto_reason, 'Unknown') AS rto_reason,
      SUM(CASE WHEN reassigned_away_at IS NULL
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${brandFilter} IS NULL OR IF(UPPER(order_id) LIKE 'HYP%', 'Hyphen', 'mCaffeine') = ${brandFilter})
            AND (${from} IS NULL OR assigned_at >= ${from}) AND (${to} IS NULL OR assigned_at <= ${to})
          THEN 1 ELSE 0 END) AS total_assigned,
      SUM(CASE WHEN disposed_at IS NOT NULL AND connected = 'Yes'
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${brandFilter} IS NULL OR IF(UPPER(order_id) LIKE 'HYP%', 'Hyphen', 'mCaffeine') = ${brandFilter})
            AND (${from} IS NULL OR disposed_at >= ${from}) AND (${to} IS NULL OR disposed_at <= ${to})
          THEN 1 ELSE 0 END) AS total_connected,
      SUM(CASE WHEN disposed_at IS NOT NULL
            AND (disposition IN ('Customer Agreed to Accept', 'Product Issue / Exchange') OR new_order_id IS NOT NULL)
            AND (${mode} IS NULL OR payment_mode = ${mode})
            AND (${brandFilter} IS NULL OR IF(UPPER(order_id) LIKE 'HYP%', 'Hyphen', 'mCaffeine') = ${brandFilter})
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
  const { dateFrom, dateTo, paymentMode, brand } = query || {};
  const [stats, hourly, partnerBreakdown, rtoReasonBreakdown, partnerReasonBreakdown] = await Promise.all([
    getCallingOverviewStats(dateFrom, dateTo),
    getCallingHourlyStats(dateFrom, dateTo),
    getCallingPartnerBreakdown(dateFrom, dateTo),
    getCallingRtoReasonBreakdown(dateFrom, dateTo, paymentMode, brand),
    getCallingPartnerReasonBreakdown(dateFrom, dateTo, paymentMode, brand),
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
//
// CORRECTED COMMENT (this used to claim the per-team isolation here was a cache-slot trick
// rather than a real filter - it was wrong, and the code matched the wrong claim: the fetcher
// was never parameterized by team, so every "per-team" cache slot held the IDENTICAL global
// payload of every live lead's AWB and timestamps. TL-B could read TL-A's whole desk through it.
//
// ndr_lead_assignments has no team column (see the design spec's "Deliberately NOT changed"
// section), but it DOES carry `email` - who currently owns the live cycle - and that email is
// exactly what THIS caller's team roster (getCallingProcessAgents(processKey, teamId)) already
// knows how to scope. So the real fix is a row-level filter: keep only rows whose email is in
// the caller's team roster. `allowedEmails === undefined` means "no filter" - the unfiltered
// path for a full admin, or for any process with fewer than two active teams (release-1
// softening, same as everywhere else in this feature) - and still returns the whole table.
//
// The underlying table read stays a SINGLE globally-cached query (cachedRead below, one key, no
// team tag) with the per-team filter applied to the cached result afterward. Per-team cache
// slots (the old teamCacheKey usage here) bought nothing once the filter is real: they only
// multiplied memory and query counts by the number of teams for an identical underlying read.
function getAllNdrLeadDates(allowedEmails) {
  return cachedRead('calling:ndrLeadDates', fetchAllNdrLeadDates).then((rows) => {
    // Lowercased on both sides of the membership check, matching the case-insensitive email
    // comparison every other identity check in this file already uses (resolveCallerTeam,
    // isCallingProcessAdmin, getCallingProcessAgents' own byEmail join) - not strictly provable
    // necessary here since both sides trace back to the same users.email column, but relying on
    // that instead of this file's own established convention is exactly the kind of assumption
    // that quietly breaks the day someone's email gets re-invited with different casing.
    const allowed = allowedEmails === undefined
      ? null
      : new Set(allowedEmails.map((e) => String(e).toLowerCase()));
    const out = {};
    // email is stripped here unconditionally, filtered or not - it exists in the cached rows only
    // to drive the membership check above, never as part of the response shape this handed back
    // to a route (api/auth/[action].js's handleLeadDates ships this object straight to the
    // client as `leadDates`, so leaving email in would newly leak every agent's address into a
    // response that never carried PII before this feature).
    for (const awb of Object.keys(rows)) {
      if (allowed && !allowed.has(String(rows[awb].email).toLowerCase())) continue;
      out[awb] = { assignedAt: rows[awb].assignedAt, disposedAt: rows[awb].disposedAt };
    }
    return out;
  });
}

async function fetchAllNdrLeadDates() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT awb_number, email, assigned_at, disposed_at FROM ndr_lead_assignments WHERE reassigned_away_at IS NULL
  `;
  const out = {};
  // email is carried in this cached shape purely so getAllNdrLeadDates can filter by team
  // membership above - it is never the response shape handed to a route.
  for (const r of rows) out[r.awb_number] = { assignedAt: r.assigned_at, disposedAt: r.disposed_at, email: r.email };
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

// Which of these AWBs the courier has already delivered, as a Set of AWB strings.
//
// mcaff_prod.lmd_courier_tracking is the logistics pipeline's own AWB-keyed table (PRIMARY KEY
// awb_number, ~2.86M rows) - a DIFFERENT SCHEMA on the same RDS instance as PEP_CLS, which is why
// the name is spelled out in full: the pool's own `database` stays PEP_CLS and is never switched.
// scripts/auto_dispose_de_categories.py reads the same table from Python for the same reason.
//
// This is a primary-key lookup per AWB, not a scan, and it is a single batched round trip per
// chunk with no per-row network call of its own - which is what makes it safe to run inside a
// browser request, unlike the RTO upload's GoKwik check (see api/rto/upload-start.js for why THAT
// one needed a background worker). A full 5000-row upload costs 5 queries.
//
// The comparison is left to MySQL, whose default collation is case-insensitive, so a column
// holding 'DELIVERED' or 'delivered' matches too - the same tolerance
// scripts/auto_dispose_de_categories.py relies on for uni_Shipping_Package_Status.
async function getDeliveredAwbNumbers(awbNumbers) {
  const unique = [...new Set((awbNumbers || []).filter(Boolean).map(String))];
  if (!unique.length) return new Set();
  const p = await getPool();
  const delivered = new Set();
  // Chunked, and sequential rather than Promise.all: the pool holds 5 connections total for the
  // whole container, so firing every chunk at once would starve any other query this same request
  // still has to make.
  const CHUNK = 1000;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const [rows] = await p.execute(
      `SELECT awb_number FROM mcaff_prod.lmd_courier_tracking
        WHERE awb_number IN (${chunk.map(() => '?').join(',')})
          AND courier_final_status = 'Delivered'`,
      chunk,
    );
    rows.forEach((r) => delivered.add(String(r.awb_number)));
  }
  return delivered;
}

module.exports = {
  sql, ensureSchema, CARD_KEYS, CARD_LABELS,
  getUserByEmail, getUserById, getUserPermissions, getUserTabPermissions, setTabPermissions,
  bootstrapAdminIfNeeded, logAccess, logEvent, deleteUser, upsertAgentPresence,
  getAllAgentPresence, getAgentPresenceLogSummary, getAllLeadDates, getAllNdrLeadDates, getRecentLeadAssignments, recordLeadDisposition,
  claimRtoLead, getRtoAgentQuota, getRtoAgentAvailability, getAgentPresenceRow,
  getRtoOnlineSpecializations,
  getCallingCallTrend, getCallingTrendData,
  getCallingTimeOfDay, getCallingTimeOfDayData,
  shouldOpenNewCycle,
  createRtoCsvUploadJob, getRtoCsvUploadJob, updateRtoCsvUploadJob,
  createOrderPunchJob, getOrderPunchJob, failOrderPunchJob, setOrderPunchJobStopRequested,
  getOrderPunchJobRowsForExport, getOrderPunchSettings, upsertOrderPunchSetting,
  getCallingOverviewStats, getCallingHourlyStats, getCallingOverviewData,
  BUSINESS_HOUR_DAYS, getCallingBusinessHours, setCallingBusinessHours,
  CALLING_STATUSES, getCallingProcessAgents, setCallingProcessAgent,
  isCallingProcessAdmin, getAdministeredProcesses,
  listCallingTeams, getCallingTeam, createCallingTeam, updateCallingTeam, resolveCallerTeam,
  getProcessDispositions, addProcessDisposition, updateProcessDisposition,
  deleteProcessDisposition, reorderProcessDispositions,
  claimNdrLead, disposeNdrLead, getLiveNdrLeadEmail, getDeliveredAwbNumbers,
  disposeDeliveryEscalationTicket,
  getDeliveryEscalationPage, getDeliveryEscalationStats, getDeliveryEscalationAgents,
  getDeliveryEscalationExport, DELIVERY_ESCALATION_MAX_EXPORT, getDeliveryEscalationRepeatStats,
  getDeliveryEscalationDaywiseStats, getDeliveryEscalationAwbHistory,
  getDeliveryEscalationGeoCategoryStats,
  claimDeliveryEscalationTicketById, disposeDeliveryEscalationTicketById,
  bulkDisposeDeliveryEscalationByAwb,
  REFUND_EXPORT_MAX_ROWS, REFUND_EXPORT_BASE_COLUMNS, REFUND_EXPORT_PII_COLUMNS,
  getRefundExportCount, getRefundExportRows,
  // Exported for api/_lib/db.cache.test.js, db.refundExport.test.js and
  // db.deliveryEscalation.test.js only - nothing in the app calls these directly.
  deWhere, DE_DAYWISE_BUCKET_SQL, DE_DAYWISE_BUCKETS,
  cachedRead, invalidateCache, CACHE_TTL_MS,
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
