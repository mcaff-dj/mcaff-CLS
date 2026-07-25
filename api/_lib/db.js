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
// its own Postgres (Neon) database, separate from the MySQL PEP_CLS schema above -
// scripts/assign_leads.py and scripts/sync_lead_assignments_to_mysql.py already talk
// to this same Postgres directly via psycopg; only this file's schema bootstrap and
// the handful of functions below need a Postgres connection of their own.
// @vercel/postgres's `sql` specifically reads process.env.POSTGRES_URL - but Vercel
// storage integrations name their connection string var all sorts of things
// (sometimes with a custom prefix, e.g. this project's Neon integration uses
// "auth_POSTGRES_URL" etc.), so search broadly for it rather than requiring an exact
// name.
if (!process.env.POSTGRES_URL) {
  const candidateNames = Object.keys(process.env).filter((k) =>
    /(^|_)(POSTGRES_URL|DATABASE_URL)$/.test(k) && !/_UNPOOLING|NON_POOLING|UNPOOLED|NO_SSL|PRISMA/.test(k)
  );
  const preferred = candidateNames.find((k) => k.endsWith('POSTGRES_URL')) || candidateNames.find((k) => k.endsWith('DATABASE_URL'));
  if (preferred) {
    process.env.POSTGRES_URL = process.env[preferred];
  }
}
const { sql: pgSql } = require('@vercel/postgres');

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

// Idempotent - safe to call on every cold start. Only runs the DDL once per warm instance.
// This is a fresh schema (PEP_CLS), so unlike the Postgres version, there's no historical
// ALTER/rename migrations to carry forward - just the final desired shape.
async function ensureSchema() {
  if (schemaReady) return;
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

// RTO CRM operational tables - separate Postgres database (see the pgSql setup
// above), separate idempotent-once-per-warm-instance flag from the MySQL schema.
async function ensurePgSchema() {
  if (pgSchemaReady) return;
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
  await pgSql`
    CREATE TABLE IF NOT EXISTS lead_assignments (
      order_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
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
  await pgSql`ALTER TABLE lead_assignments ADD COLUMN IF NOT EXISTS awb_code TEXT`;
  await pgSql`CREATE UNIQUE INDEX IF NOT EXISTS lead_assignments_awb_code_key ON lead_assignments (awb_code)`;
  pgSchemaReady = true;
}

const CARD_KEYS = ['mcaffeine', 'hyphen', 'productkyc', 'mom', 'calling', 'onboarding', 'deepdive'];
const CARD_LABELS = {
  mcaffeine: 'mCaffeine', hyphen: 'Hyphen', productkyc: 'Product Calling KYC',
  mom: 'MOM', calling: 'Calling Team', onboarding: 'Onboarding Test', deepdive: 'Deep Dive',
};

async function getUserByEmail(email) {
  await ensureSchema();
  const { rows } = await sql`SELECT id, email, name, is_admin FROM users WHERE email = ${email}`;
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
async function logEvent(userId, email, cardKey, action, detail, ip) {
  await ensureSchema();
  await sql`INSERT INTO audit_log (user_id, email, card_key, action, detail, ip) VALUES (${userId}, ${email}, ${cardKey}, ${action}, ${detail}, ${ip})`;
}

async function logAccess(userId, email, cardKey, ip) {
  return logEvent(userId, email, cardKey, 'view', null, ip);
}

// status: 'Online' | 'Busy' | 'Offline'. email/name always come from the caller's own
// session, never from client-supplied data, so an agent can only ever set their own
// presence - not spoof anyone else's (the gap that made the old Supabase anon-key
// design insecure).
async function upsertAgentPresence(email, name, status) {
  await ensurePgSchema();
  await pgSql`
    INSERT INTO agent_presence (email, name, status, updated_at)
    VALUES (${email}, ${name}, ${status}, now())
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now()
  `;
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

// Returns { orderId: assignedAtIso } for assignments newer than sinceHours - the
// reset button only needs "was this assigned recently", so callers keep the payload
// small by asking for a window just past their own grace period, not the whole table.
async function getRecentLeadAssignments(sinceHours) {
  await ensurePgSchema();
  const { rows } = await pgSql`
    SELECT order_id, assigned_at FROM lead_assignments
    WHERE assigned_at >= now() - make_interval(hours => ${sinceHours})
  `;
  const out = {};
  for (const r of rows) out[r.order_id] = r.assigned_at;
  return out;
}

// Upserts the disposal side of a lead's lifecycle. If assign_leads.py never recorded
// this order_id (assigned before lead_assignments existed, or assigned manually
// straight in the sheet), the INSERT branch creates the row now with the disposing
// agent's own email as assigned_at's best-available attribution, rather than dropping
// the disposal details on the floor.
//
// awbCode uses COALESCE on conflict rather than overwriting, so a disposal call
// without it (e.g. an older cached client) never clobbers the awb_code
// assign_leads.py already stamped for this order_id.
async function recordLeadDisposition(orderId, email, awbCode, details) {
  await ensurePgSchema();
  const { disposition, agentRemarks, connected, attempt, refundAmount } = details || {};
  await pgSql`
    INSERT INTO lead_assignments (order_id, email, assigned_at, disposed_at, disposition, agent_remarks, connected, attempt, refund_amount, awb_code)
    VALUES (${orderId}, ${email}, now(), now(), ${disposition || null}, ${agentRemarks || null}, ${connected || null}, ${attempt || null}, ${refundAmount || null}, ${awbCode || null})
    ON CONFLICT (order_id) DO UPDATE SET
      disposed_at = now(),
      disposition = EXCLUDED.disposition,
      agent_remarks = EXCLUDED.agent_remarks,
      connected = EXCLUDED.connected,
      attempt = EXCLUDED.attempt,
      refund_amount = EXCLUDED.refund_amount,
      awb_code = COALESCE(EXCLUDED.awb_code, lead_assignments.awb_code)
  `;
}

module.exports = {
  sql, ensureSchema, CARD_KEYS, CARD_LABELS,
  getUserByEmail, getUserPermissions, getUserTabPermissions, setTabPermissions,
  bootstrapAdminIfNeeded, logAccess, logEvent, deleteUser, upsertAgentPresence,
  getAllAgentPresence, getRecentLeadAssignments, recordLeadDisposition,
};
