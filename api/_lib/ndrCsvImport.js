// Column configuration for the NDR Calling CSV upload (api/ndr/upload.js). The parse/dedup/map
// engine itself lives in rtoCsvImport.js and is shared unchanged - this file only describes the
// "Latest NDR " sheet and the export that feeds it, so the scientific-notation handling, AWB
// text-forcing and dedup ordering exist in exactly one place for both processes.
//
// WHY THE SHEET COLUMNS HERE ARE TRUSTWORTHY: they are taken from mapNdrRow in
// app/ndr-calling/NdrCallingClient.js, which has been reading this sheet in production all
// along - not guessed. Note the sheet is wider than scripts/assign_ndr_leads.py implies (that
// script only reads out to T because Agent Name/Connected are all it needs).
//
// Columns deliberately NOT written by an upload:
//   C, W-AA        unknown to this codebase - mapNdrRow skips them, and NdrCallingClient's own
//                  comment says they belong to a separate downstream CS process whose taxonomy
//                  we do not understand well enough to touch. K and N were in this list until
//                  the business asked for them explicitly (see NDR_CSV_TO_COLUMN below); nothing
//                  in this codebase reads either, so they are written for the sheet's own readers
//                  and for that same downstream process, not for anything here.
//   R, S, T, U, V, AB  agent/disposition columns (Calling Date, Agent Name, Connected, Outcome,
//                  "Did you receive any call from the delivery agent?", Remarks) - written by
//                  assign_ndr_leads.py and the calling UI, never by an import. A fresh lead must
//                  arrive with these blank, which is exactly what "not yet worked" means here.
const { columnLetterToIndex } = require('./rtoCsvImport');

// CSV header text -> sheet column letter. The CSV is the same fixed Shiprocket export family the
// RTO upload ingests (see rtoCsvImport.js's CSV_TO_COLUMN and commit 86cc843 on why identity is
// fixed here rather than fuzzy-matched against the file's own header row).
const NDR_CSV_TO_COLUMN = {
  'Order ID': 'A',
  'Customer Name': 'B',
  'Customer Mobile': 'D',
  'AWB Code': 'E',
  'Courier Company': 'F',
  'Address Line 1': 'G',
  'Address Pincode': 'H',
  'Address City': 'I',
  'Address State': 'J',
  // K and N are written on explicit business instruction, unlike the columns above which came
  // from mapNdrRow. Neither is read anywhere in this codebase - mapNdrRow skips both - so the
  // only consumers are whoever reads the sheet directly and the downstream CS process. K's live
  // header is "Address quality", which is what this fills it from; the column previously carried
  // "Order Value" and was renamed in the sheet before this mapping was asked for.
  'Address Quality': 'K',
  'Payment Method': 'L',
  'Status': 'M',
  'Is Buyer Response Received': 'N',
  'Attempt Count': 'O',
  'Latest NDR Date': 'P',
  'Latest NDR Reason': 'Q',
};

// Alternative CSV header spellings accepted for the columns above, alias -> canonical. Both
// Shiprocket NDR exports carry the same six fields under different labels: the "NDR Full" export
// (imports_ndr_reports_*_NDR_Full_*.csv) names them on the left, the export NDR_CSV_TO_COLUMN was
// written against on the right. Same data, same source system, different label - so a file that
// was entirely valid used to be refused with "missing required column(s)" and had to have its
// header row edited by hand before every upload, which is also how an AWB column gets opened in
// Excel and rounded to 5.4E+13 in the first place.
//
// Only these six differ; Order ID, AWB Code, Customer Name, Customer Mobile, Status, Attempt
// Count, Latest NDR Date and Latest NDR Reason are spelled identically in both exports and need
// no alias. Matching is case- and punctuation-insensitive, and a canonical header already in the
// file always wins - see applyHeaderAliases in rtoCsvImport.js.
const NDR_CSV_HEADER_ALIASES = {
  Courier: 'Courier Company',
  'Address 1': 'Address Line 1',
  Pincode: 'Address Pincode',
  City: 'Address City',
  State: 'Address State',
  'Payment Mode': 'Payment Method',
};

// The live sheet's own header text at each column above, used ONLY to detect drift before
// writing - never to locate a column. O/L/P/Q/S/T are named outright in
// scripts/assign_ndr_leads.py's column constants; the rest come from mapNdrRow's field names.
// api/ndr/upload.js returns the live header row alongside any mismatch it reports, so a wrong
// expectation here surfaces as a refusal that names the real text rather than as bad data.
const NDR_EXPECTED_SHEET_HEADER = {
  A: 'Order ID',
  B: 'Customer Name',
  D: 'Customer Mobile',
  E: 'AWB',
  // 'Partner name', not 'Partner' - verified against the live header row of both NDR sheets
  // (2026-08-26). The original 'Partner' never matched, so checkSheetLayout failed every NDR
  // upload with "Sheet column layout has changed unexpectedly" from the day this shipped.
  F: 'Partner name',
  G: 'Address',
  H: 'Pincode',
  I: 'City',
  J: 'State',
  // Compared through normalizeHeader, so the live cell's own casing ("Address quality") matches
  // this just as well - see checkSheetLayout in rtoCsvImport.js.
  K: 'Address Quality',
  L: 'Payment Mode',
  M: 'Status',
  N: 'Is Buyer Response Received',
  O: 'Attempt Count',
  P: 'Latest NDR Date',
  Q: 'Latest NDR Reason',
};

// Widest column an upload writes. Narrower than RTO's on purpose: everything past Q either
// belongs to an agent or to the downstream CS process, so a single contiguous A:Q append covers
// every written column without reaching them.
const NDR_LAST_COLUMN_LETTER = 'Q';
const NDR_ROW_WIDTH = columnLetterToIndex(NDR_LAST_COLUMN_LETTER) + 1;

// The two sheet columns whose live values form the dedup key, in the same order as
// dedupExtraCsvHeaders below. api/ndr/upload.js batch-reads exactly these.
const NDR_AWB_COLUMN = 'E';
const NDR_ATTEMPT_COLUMN = 'O';

const NDR_IMPORT = {
  label: 'NDR',
  columnMap: NDR_CSV_TO_COLUMN,
  expectedHeader: NDR_EXPECTED_SHEET_HEADER,
  lastColumn: NDR_LAST_COLUMN_LETTER,
  requiredCsvHeaders: Object.keys(NDR_CSV_TO_COLUMN),
  csvHeaderAliases: NDR_CSV_HEADER_ALIASES,
  awbCsvHeader: 'AWB Code',
  // AWB alone does NOT identify an NDR lead: one shipment gets a new row per failed delivery
  // attempt, and the sheet really does carry the same AWB on many rows (358 such AWBs on
  // 2026-08-25, per scripts/test_assign_ndr_leads.py). Deduping on AWB alone would reject every
  // genuine follow-up attempt, so the attempt count joins the key.
  dedupExtraCsvHeaders: ['Attempt Count'],
  // Truncated at the first "_" like RTO's, on explicit business instruction:
  // "HYP43558080_SP/G3/2627/924677" is written as "HYP43558080". This column was previously
  // written verbatim because it is the brand source for brandOf() in NdrCallingClient.js and
  // brand_of() in scripts/assign_ndr_leads.py - both of which still work, since both test only
  // the "HYP" PREFIX and the truncation keeps everything before the first "_". Rows appended
  // before this keep their full Order ID; nothing in this codebase matches the two forms against
  // each other, so the mixed column is cosmetic.
  orderIdCsvHeader: 'Order ID',
  orderIdColumn: 'A',
  paymentMethodColumn: 'L',
  // Blanks stay genuinely blank here, unlike RTO's literal "NA". NdrCallingClient renders every
  // one of these fields with a `|| '—'` fallback, so an empty cell already displays correctly,
  // and "NA" would additionally corrupt the two columns that are matched as data rather than
  // shown: Payment Mode (L, matched against an agent's Prepaid/COD filter) and Latest NDR Reason
  // (Q, substring-matched against an agent's reason filter).
  blankPlaceholder: '',
  // AWB (E) is written as a real NUMBER here, not as apostrophe-escaped text the way RTO's is.
  // Requested for the "Latest NDR " sheets so column E sorts and matches numerically against the
  // other AWB lists the desk keeps alongside it. See toSheetNumber in rtoCsvImport.js for the two
  // AWB shapes that still stay text (leading zero, >15 digits) and, importantly, for the sheet
  // number-format this depends on.
  //
  // Safe for dedup in both directions: api/ndr/upload.js reads the key columns with
  // valueRenderOption=UNFORMATTED_VALUE, so a numeric cell arrives as a JS number and a legacy
  // apostrophe-text cell as a string, and normalizeAwb stringifies both to the same key. Rows
  // appended before this change are text and stay text - the column is mixed on purpose, since
  // rewriting live history to convert them buys nothing the readers can tell apart.
  awbAsNumber: true,
};

module.exports = {
  NDR_IMPORT,
  NDR_CSV_TO_COLUMN,
  NDR_CSV_HEADER_ALIASES,
  NDR_EXPECTED_SHEET_HEADER,
  NDR_LAST_COLUMN_LETTER,
  NDR_ROW_WIDTH,
  NDR_AWB_COLUMN,
  NDR_ATTEMPT_COLUMN,
};
