// Self-check for the NDR interactive top-up's two pure pieces (api/ndr/next-lead.js):
// buildCandidateList (one pass over the sheet producing this agent's open load AND the leads they
// may receive, oldest first) and planFillRound (which of a round's targets a racing writer took).
// Pure/offline: no sheet, no DB, no network. Run with `node api/ndr/next-lead.test.js`.
//
// The dangerous failure modes, each guarded below:
//   (a) disposed leads counted as open load, which caps an agent at zero forever once they finish
//       a batch - the exact bug already fixed once in scripts/assign_ndr_leads.py
//   (b) another agent's lead counted as this agent's load, or taken from them
//   (c) a lead offered that this agent's filters exclude
//   (d) an undated lead jumping the oldest-first queue
//   (e) an AWB-less row handed out, which cannot be mirrored into ndr_lead_assignments
//   (f) a row already claimed between the read and the write being written anyway
const assert = require('assert');
const { buildCandidateList, planFillRound } = require('./next-lead');
const { normalizeAgentFilters } = require('../_lib/ndrAssignment');

const ME = 'rasika.sawant@mcaffeine.com';

// A sheet row wide enough to reach Connected (index 19), with only the columns this endpoint
// reads populated. Indices match assign_ndr_leads.py's COL_* constants.
function row({ orderId = 'MC1', awb = 'AWB1', paymentMode = 'COD', attempts = '', date = '', reason = '', agent = '', connected = '', courier = '' } = {}) {
  const r = new Array(20).fill('');
  r[0] = orderId; r[4] = awb; r[5] = courier; r[11] = paymentMode; r[14] = attempts;
  r[15] = date; r[16] = reason; r[18] = agent; r[19] = connected;
  return r;
}

const unrestricted = normalizeAgentFilters({ email: ME });

// --- load counting ---------------------------------------------------------------------------
{
  const rows = [
    row({ awb: 'A1', agent: ME }),                       // mine, undisposed -> load
    row({ awb: 'A2', agent: ME, connected: 'Yes' }),      // (a) mine but DISPOSED -> not load
    row({ awb: 'A3', agent: 'someone.else@x.com' }),      // (b) not mine -> not load
    row({ awb: 'A4', agent: ME.toUpperCase() }),          // case drift in the sheet is real
    row({ awb: 'A5' }),                                   // unassigned -> a candidate, not load
  ];
  const { load, candidates } = buildCandidateList(rows, ME, unrestricted);
  assert.strictEqual(load, 2, `(a)/(b) only my OPEN leads count as load - got ${load}`);
  assert.deepStrictEqual(candidates.map((c) => c.awb), ['A5'],
    '(b) a lead already assigned to anyone - me included - is never handed out again');
}

// --- row numbers must be sheet rows, not array indices ---------------------------------------
{
  const { candidates } = buildCandidateList([row({ awb: 'A1' }), row({ awb: 'A2' })], ME, unrestricted);
  assert.deepStrictEqual(candidates.map((c) => c.row), [2, 3],
    'the read starts at A2, so index 0 is sheet row 2 - an off-by-one here writes over the wrong lead');
}

// --- (e) an AWB-less row is not assignable ---------------------------------------------------
{
  const { candidates } = buildCandidateList([row({ awb: '' }), row({ awb: '   ' }), row({ awb: 'A1' })], ME, unrestricted);
  assert.deepStrictEqual(candidates.map((c) => c.awb), ['A1'],
    '(e) AWB is the ndr_lead_assignments key - a row without one cannot be mirrored, so it is skipped');
}

// --- (d) oldest first, undated last ----------------------------------------------------------
{
  const rows = [
    row({ awb: 'NEW', date: '03-09-2026' }),
    row({ awb: 'UNDATED', date: '' }),
    row({ awb: 'OLD', date: '01-09-2026' }),
    row({ awb: 'MID', date: '02-09-2026' }),
  ];
  const { candidates } = buildCandidateList(rows, ME, unrestricted);
  assert.deepStrictEqual(candidates.map((c) => c.awb), ['OLD', 'MID', 'NEW', 'UNDATED'],
    '(d) longest-waiting first; an undated lead must sort LAST, never jump the queue');
}

// --- ties break by row, so two concurrent callers walk the sheet in the same order -----------
{
  const rows = [row({ awb: 'A1', date: '01-09-2026' }), row({ awb: 'A2', date: '01-09-2026' })];
  const { candidates } = buildCandidateList(rows, ME, unrestricted);
  assert.deepStrictEqual(candidates.map((c) => c.awb), ['A1', 'A2'], 'same date -> lower row first, deterministically');
}

// --- (c) filters are honoured, using Rasika's real 2026-09-04 configuration ------------------
{
  const attempt3 = normalizeAgentFilters({ email: ME, attemptCountFilter: '3' });
  const rows = [
    row({ awb: 'AT1', attempts: '1' }),
    row({ awb: 'AT3', attempts: '3' }),
    row({ awb: 'AT9', attempts: '9' }),
    row({ awb: 'ATBLANK', attempts: '' }),
  ];
  const { candidates } = buildCandidateList(rows, ME, attempt3);
  assert.deepStrictEqual(candidates.map((c) => c.awb).sort(), ['AT3', 'ATBLANK'],
    '(c) exactly bucket 3, plus the blank that fails open - 1 and "More than 3" are excluded');
}

// --- brand comes from the Order ID prefix, there being no Brand column -----------------------
{
  const hyphenOnly = normalizeAgentFilters({ email: ME, ndrBrandFilter: 'Hyphen' });
  const rows = [row({ awb: 'H1', orderId: 'HYP900' }), row({ awb: 'M1', orderId: 'MC900' })];
  const { candidates } = buildCandidateList(rows, ME, hyphenOnly);
  assert.deepStrictEqual(candidates.map((c) => c.awb), ['H1']);
}

// --- courier (Courier Company, column F) is carried onto the candidate -----------------------
{
  const rows = [row({ awb: 'C1', courier: 'Delhivery' })];
  const { candidates } = buildCandidateList(rows, ME, unrestricted);
  assert.strictEqual(candidates[0].courier, 'Delhivery');
}

// --- ragged rows: Sheets truncates trailing empty cells, so short arrays are normal ----------
{
  const { load, candidates } = buildCandidateList([['MC1', '', '', '', 'A1'], [], ['MC2']], ME, unrestricted);
  assert.strictEqual(load, 0, 'a row too short to have an Agent Name must not throw or count');
  assert.deepStrictEqual(candidates.map((c) => c.awb), ['A1'],
    'the 5-cell row is a real unassigned candidate; the empty and AWB-less rows are skipped');
}

// --- (f) planFillRound: only cells still blank get written ------------------------------------
{
  const target = [{ row: 2, awb: 'A1' }, { row: 3, awb: 'A2' }, { row: 4, awb: 'A3' }];
  const { free, taken } = planFillRound(target, [
    { values: [['']] },                       // still free
    { values: [['other.agent@x.com']] },      // (f) raced - someone claimed it
    {},                                        // Sheets omits values entirely for a blank cell
  ]);
  assert.deepStrictEqual(free.map((c) => c.awb), ['A1', 'A3'],
    'an omitted valueRange means the cell is blank - treating it as taken would stall every fill');
  assert.deepStrictEqual(taken.map((c) => c.awb), ['A2'], '(f) a claimed row must never be overwritten');
}
{
  // Whitespace-only is blank; anything else is a real holder. NDR has no 'Unassigned' sentinel -
  // unlike the RTO sheet - so a literal "Unassigned" here would be a genuine (if odd) holder.
  const { free, taken } = planFillRound([{ row: 2 }, { row: 3 }], [{ values: [['  ']] }, { values: [['x']] }]);
  assert.strictEqual(free.length, 1);
  assert.strictEqual(taken.length, 1);
}

console.log('api/ndr/next-lead.test.js: all assertions passed');
