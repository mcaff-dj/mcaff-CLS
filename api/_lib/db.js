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
function getPgPool() {
  if (pgPool) return pgPool;
  const conn = process.env.POSTGRES_URL;
  if (!conn) throw new Error('Missing POSTGRES_URL env var');
  pgPool = new PgPool({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  return pgPool;
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
  const { rows } = await getPgPool().query(text, values);
  return { rows };
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

// Upserts the disposal side of a lead's lifecycle. If assign_leads.py never recorded
// this order_id (assigned before lead_assignments existed, or assigned manually
// straight in the sheet), the INSERT branch creates the row now with the disposing
// agent's own email as assigned_at's best-available attribution, rather than dropping
// the disposal details on the floor.
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
    ON CONFLICT (order_id) DO UPDATE SET
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
async function getCallingOverviewStats(dateFrom, dateTo) {
  await ensurePgSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const { rows } = await pgSql`
    SELECT
      count(*) FILTER (
        WHERE (${from}::timestamptz IS NULL OR assigned_at >= ${from}) AND (${to}::timestamptz IS NULL OR assigned_at <= ${to})
      )::int AS total_assigned,
      count(*) FILTER (
        WHERE disposed_at IS NOT NULL AND (${from}::timestamptz IS NULL OR disposed_at >= ${from}) AND (${to}::timestamptz IS NULL OR disposed_at <= ${to})
      )::int AS total_disposed,
      count(*) FILTER (
        WHERE disposed_at IS NULL AND (${from}::timestamptz IS NULL OR assigned_at >= ${from}) AND (${to}::timestamptz IS NULL OR assigned_at <= ${to})
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
async function getCallingHourlyStats(dateFrom, dateTo) {
  await ensurePgSchema();
  const { from, to } = dateBounds(dateFrom, dateTo);
  const [assignedRows, disposedRows] = await Promise.all([
    pgSql`
      SELECT extract(hour FROM assigned_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, count(*)::int AS n
      FROM lead_assignments
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
const CALLING_STATUSES = ['Online', 'Busy', 'Offline'];

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
  const { rows: members } = await sql`
    SELECT u.id, u.email, u.name, u.is_admin
    FROM users u
    LEFT JOIN report_tab_permissions rtp
      ON rtp.user_id = u.id AND rtp.card_key = 'calling' AND rtp.tab_key = ${processKey}
    LEFT JOIN permissions p
      ON p.user_id = u.id AND p.card_key = 'calling'
    WHERE rtp.tab_key IS NOT NULL OR u.is_admin = 1
    GROUP BY u.id, u.email, u.name, u.is_admin
    ORDER BY u.is_admin DESC, u.name ASC
  `;
  const { rows: state } = await pgSql`
    SELECT email, status, max_quota, updated_at, updated_by
    FROM calling_agent_process WHERE process_key = ${processKey}
  `;
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
      updatedAt: (s && s.updated_at) || null,
      updatedBy: (s && s.updated_by) || null,
    };
  });
}

// Upserts one agent's status and/or quota for one process. Either field may be omitted, so an
// agent flipping their own status can't accidentally reset a quota an admin set.
async function setCallingProcessAgent(processKey, email, { status, maxQuota } = {}, updatedBy) {
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
  // COALESCE(EXCLUDED.x, table.x) so an omitted field keeps its stored value instead of being
  // overwritten with null.
  await pgSql`
    INSERT INTO calling_agent_process (email, process_key, status, max_quota, updated_at, updated_by)
    VALUES (${key}, ${processKey}, ${status || 'Offline'}, ${quota}, now(), ${updatedBy || null})
    ON CONFLICT (email, process_key) DO UPDATE
      SET status = COALESCE(${status || null}, calling_agent_process.status),
          max_quota = COALESCE(${quota}, calling_agent_process.max_quota),
          updated_at = now(),
          updated_by = ${updatedBy || null}
  `;
  return getCallingProcessAgents(processKey);
}

// Per-partner disposition breakdown (delivery_partner, derived from awb_code - see
// ensurePgSchema). Surfaces "Customer Agreed to Accept" specifically alongside the total,
// so it directly answers "which partner is most of our Customer Agreed to Accept coming
// from" rather than just a generic disposed count - sorted by that count descending.
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
    FROM lead_assignments
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

module.exports = {
  sql, ensureSchema, CARD_KEYS, CARD_LABELS,
  getUserByEmail, getUserById, getUserPermissions, getUserTabPermissions, setTabPermissions,
  bootstrapAdminIfNeeded, logAccess, logEvent, deleteUser, upsertAgentPresence,
  getAllAgentPresence, getRecentLeadAssignments, recordLeadDisposition,
  getCallingOverviewStats, getCallingHourlyStats, getCallingOverviewData,
  BUSINESS_HOUR_DAYS, getCallingBusinessHours, setCallingBusinessHours,
  CALLING_STATUSES, getCallingProcessAgents, setCallingProcessAgent,
};
