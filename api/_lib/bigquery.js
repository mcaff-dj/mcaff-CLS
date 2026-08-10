// Read-only BigQuery REST client for the Escalation desk - reuses the same JWT machinery
// api/_lib/escalationSheet.js already has for Sheets, with the BigQuery scope instead. Mirrors
// scripts/bq_lib.py's run_query() shape so the Python and Node sides are easy to compare.
//
// WRITE-FREE ON PURPOSE. The app never writes to BigQuery - see
// docs/superpowers/specs/2026-08-10-escalation-bigquery-postgres-hybrid-design.md. All app
// writes go to Postgres (api/_lib/db.js) and the Sheet (api/_lib/escalationSheet.js). If a
// future change needs a BigQuery write from here, that is a decision to revisit this file's
// whole premise, not a function to bolt on quietly.
const { JWT } = require('google-auth-library');

const BASE = 'https://bigquery.googleapis.com/bigquery/v2';

let _client = null;
function getClient() {
  if (_client) return _client;
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars');
  _client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/bigquery'] });
  return _client;
}

async function authHeader() {
  const { token } = await getClient().getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

// Runs a SQL query, returns every row as an array of {column: value} objects. Polls jobComplete
// and pages through pageToken, same as scripts/bq_lib.py's run_query - a query that doesn't
// finish inside the initial timeout, or returns more rows than one page, still comes back
// complete rather than silently truncated.
async function runQuery(project, sql, params, timeoutMs = 30000) {
  const body = { query: sql, useLegacySql: false, timeoutMs, useQueryCache: true };
  if (params) {
    body.parameterMode = 'NAMED';
    body.queryParameters = Object.entries(params).map(([name, value]) => ({
      name, parameterType: { type: 'STRING' }, parameterValue: { value },
    }));
  }
  const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
  let res = await fetch(`${BASE}/projects/${project}/queries`, { method: 'POST', headers, body: JSON.stringify(body) });
  let data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `BigQuery query failed (${res.status})`);

  const jobId = data.jobReference.jobId;
  const location = data.jobReference.location;

  // Builds the poll/page-fetch URL for this job - `location` is only sometimes present
  // (single-region projects often omit it), so this stays a single well-formed query string
  // either way instead of the string-splicing gymnastics that would otherwise require.
  function pollUrl(extraParams) {
    const params = new URLSearchParams(extraParams || {});
    if (location) params.set('location', location);
    const qs = params.toString();
    return `${BASE}/projects/${project}/queries/${jobId}${qs ? `?${qs}` : ''}`;
  }

  while (!data.jobComplete) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await fetch(pollUrl(), { headers: await authHeader() });
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `BigQuery poll failed (${res.status})`);
  }

  const fields = (data.schema?.fields || []).map((f) => f.name);
  const rows = [];
  const consume = (d) => (d.rows || []).forEach((row) => {
    const obj = {};
    fields.forEach((name, i) => { obj[name] = row.f[i]?.v ?? null; });
    rows.push(obj);
  });
  consume(data);
  let pageToken = data.pageToken;
  while (pageToken) {
    res = await fetch(pollUrl({ pageToken }), { headers: await authHeader() });
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `BigQuery page fetch failed (${res.status})`);
    consume(data);
    pageToken = data.pageToken;
  }
  return rows;
}

module.exports = { runQuery };
