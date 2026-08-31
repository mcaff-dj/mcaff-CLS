// Gated raw-data CSV server: GET /api/report/raw?card=mcaffeine&tab=delivery[&from=YYYY-MM-DD&to=YYYY-MM-DD]
// The CSVs live in S3 now (same reasoning as [card].js - uploaded by the refresh job,
// not bundled with this Lambda), so downloading one still goes through the same
// session + permission check as viewing the report itself. Only mcaffeine/hyphen have
// raw exports (productkyc is a separate standalone report with no ticket-level export
// built for it).
//
// With no from/to: unchanged - redirects to a short-lived presigned S3 link, Lambda
// never reads the file. With from/to: Lambda downloads the full CSV, filters rows by
// "Created Date" (the sheet's own M/D/YYYY, no leading zeros - see gen_monthly.py's
// _sheet_date_str) falling in the inclusive range, and streams the filtered CSV back
// directly - there's no S3 object to presign for a range picked at request time.
const { HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3Client, REPORTS_BUCKET } = require('../_lib/s3');
const { getSession } = require('../_lib/session');
const { CARD_KEYS, logEvent } = require('../_lib/db');
const { parseCSV, toCSV } = require('../_lib/csv');

const RAW_CARD_KEYS = CARD_KEYS.filter((k) => k !== 'productkyc');
const VALID_TABS = new Set(['overview', 'delivery', 'warehouse', 'technical', 'packaging', 'product', 'suggestion', 'prodpkg']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toIsoDate(mdy) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(mdy || '').trim());
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// Pure filter, exported for an offline test. Rows with an unparseable Created Date are
// dropped rather than guessed at; the header is taken from the unfiltered parse so it
// survives even when the picked range matches zero rows.
function filterRawCsv(csvText, from, to) {
  const rows = parseCSV(csvText);
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const filtered = rows.filter((r) => {
    const iso = toIsoDate(r['Created Date']);
    return iso !== null && iso >= from && iso <= to;
  });
  return toCSV(filtered, headers);
}

module.exports = async (req, res) => {
  const card = (req.query && req.query.card) || '';
  const tab = (req.query && req.query.tab) || '';
  if (!RAW_CARD_KEYS.includes(card) || !VALID_TABS.has(tab)) {
    res.status(404).send('Not found');
    return;
  }

  const from = (req.query && req.query.from) || '';
  const to = (req.query && req.query.to) || '';
  const hasRange = !!(from || to);
  if (hasRange && (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to) || from > to)) {
    res.status(400).send('Invalid date range.');
    return;
  }

  const session = await getSession(req);
  if (!session) {
    const next = `/api/report/raw?card=${card}&tab=${tab}` + (hasRange ? `&from=${from}&to=${to}` : '');
    res.writeHead(302, { Location: `/login?next=${encodeURIComponent(next)}` });
    res.end();
    return;
  }
  if (!(session.perms || []).includes(card)) {
    res.status(403).send('You do not have access to this report. Contact your admin to request access.');
    return;
  }

  const key = `reports/${card}_raw_${tab}.csv`;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  try {
    if (hasRange) {
      const obj = await s3Client.send(new GetObjectCommand({ Bucket: REPORTS_BUCKET, Key: key }));
      const csvText = await obj.Body.transformToString('utf-8');
      const filteredCsv = filterRawCsv(csvText, from, to);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${card}_${tab}_raw_${from}_to_${to}.csv"`,
        'Cache-Control': 'no-store',
      });
      res.end('﻿' + filteredCsv);
      logEvent(session.uid, session.email, card, 'raw_download', `${tab} ${from}..${to}`, ip).catch(() => {});
      return;
    }

    // Confirms the object actually exists first, so a not-yet-built tab returns the
    // same "not available yet" message it always has, instead of a redirect to a link
    // that 404s once the browser follows it.
    await s3Client.send(new HeadObjectCommand({ Bucket: REPORTS_BUCKET, Key: key }));
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: REPORTS_BUCKET,
        Key: key,
        ResponseContentType: 'text/csv; charset=utf-8',
        ResponseContentDisposition: `attachment; filename="${card}_${tab}_raw.csv"`,
      }),
      { expiresIn: 60 }
    );
    res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
    res.end();
    logEvent(session.uid, session.email, card, 'raw_download', tab, ip).catch(() => {});
  } catch (e) {
    res.status(404).send('Raw data not available for this tab yet.');
  }
};

module.exports.filterRawCsv = filterRawCsv;
module.exports.toIsoDate = toIsoDate;
