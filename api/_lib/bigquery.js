// BigQuery transport for the request path. Reads and writes only - all ingest is Python
// (scripts/bq_lib.py), so there is deliberately no load-job support here.
//
// Not @google-cloud/bigquery: that client pulls in a large dependency tree, and this Lambda
// bundle already runs close to the 6MB payload ceiling. The pattern here matches api/rto/sheet.js
// and api/ndr/sheet.js - a google-auth-library JWT plus plain fetch.
//
// The tables are created by scripts/escalation_bq_schema.py and nowhere else. Nothing in this
// module issues DDL, so the two languages cannot drift on table definitions.
const { JWT } = require('google-auth-library');

const API = 'https://bigquery.googleapis.com/bigquery/v2';

function projectId() {
  const id = process.env.BQ_PROJECT_ID;
  if (!id) throw new Error('Missing BQ_PROJECT_ID env var');
  return id;
}
function datasetId() {
  return process.env.BQ_DATASET || 'escalation';
}

let _client = null;
function getClient() {
  if (_client) return _client;
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY env vars');
  // Same service account the Sheets access uses, with the bigquery scope added. It needs the
  // BigQuery Data Editor and BigQuery Job User roles on BQ_PROJECT_ID.
  _client = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/bigquery'] });
  return _client;
}

let _authHeader = async () => {
  const { token } = await getClient().getAccessToken();
  return { Authorization: `Bearer ${token}` };
};
// Test seam: the self-check stubs fetch, but minting a real JWT would still need a real key.
function _setAuthHeaderForTests(fn) { _authHeader = fn; }

// Only STRING scalars and arrays of all-STRING structs - all this desk needs.
function strParam(name, value) {
  return {
    name,
    parameterType: { type: 'STRING' },
    parameterValue: { value: value == null ? null : String(value) },
  };
}

function structArrayParam(name, fields, rows) {
  return {
    name,
    parameterType: {
      type: 'ARRAY',
      arrayType: { type: 'STRUCT', structTypes: fields.map((f) => ({ name: f, type: { type: 'STRING' } })) },
    },
    parameterValue: {
      arrayValues: rows.map((r) => ({
        structValues: Object.fromEntries(
          fields.map((f) => [f, { value: r[f] == null ? null : String(r[f]) }])
        ),
      })),
    },
  };
}

// BigQuery returns rows positionally against a separate schema; callers want plain objects.
function rowsOf(data) {
  const fields = (data.schema && data.schema.fields) || [];
  return (data.rows || []).map((row) => {
    const obj = {};
    fields.forEach((field, i) => { obj[field.name] = row.f[i] ? row.f[i].v : null; });
    return obj;
  });
}

async function query(sql, params = [], { useQueryCache = true } = {}) {
  const res = await fetch(`${API}/projects/${projectId()}/queries`, {
    method: 'POST',
    headers: { ...(await _authHeader()), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      useQueryCache,
      parameterMode: 'NAMED',
      queryParameters: params,
      timeoutMs: 60000,
      defaultDataset: { projectId: projectId(), datasetId: datasetId() },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `BigQuery query failed (${res.status})`);
  if (data.errors && data.errors.length) throw new Error(data.errors[0].message);
  return { rows: rowsOf(data), affectedRows: Number(data.numDmlAffectedRows || 0) };
}

module.exports = { query, strParam, structArrayParam, projectId, datasetId, _setAuthHeaderForTests };
