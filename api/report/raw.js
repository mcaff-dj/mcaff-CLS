// Gated raw-data CSV server: GET /api/report/raw?card=mcaffeine&tab=delivery
// The CSVs live in S3 now (same reasoning as [card].js - uploaded by the refresh job,
// not bundled with this Lambda), so downloading one still goes through the same
// session + permission check as viewing the report itself, then redirects to a
// short-lived S3 link instead of streaming the file through Lambda. Only mcaffeine/
// hyphen have raw exports (productkyc is a separate standalone report with no
// ticket-level export built for it).
const { HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3Client, REPORTS_BUCKET } = require('../_lib/s3');
const { getSession } = require('../_lib/session');
const { CARD_KEYS, logEvent } = require('../_lib/db');

const RAW_CARD_KEYS = CARD_KEYS.filter((k) => k !== 'productkyc');
const VALID_TABS = new Set(['overview', 'delivery', 'warehouse', 'technical', 'packaging', 'product', 'suggestion', 'prodpkg']);

module.exports = async (req, res) => {
  const card = (req.query && req.query.card) || '';
  const tab = (req.query && req.query.tab) || '';
  if (!RAW_CARD_KEYS.includes(card) || !VALID_TABS.has(tab)) {
    res.status(404).send('Not found');
    return;
  }

  const session = getSession(req);
  if (!session) {
    res.writeHead(302, { Location: `/login.html?next=${encodeURIComponent('/api/report/raw?card=' + card + '&tab=' + tab)}` });
    res.end();
    return;
  }
  if (!(session.perms || []).includes(card)) {
    res.status(403).send('You do not have access to this report. Contact your admin to request access.');
    return;
  }

  const key = `reports/${card}_raw_${tab}.csv.gz`;
  try {
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
        ResponseContentEncoding: 'gzip',
      }),
      { expiresIn: 60 }
    );
    res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
    res.end();
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
    logEvent(session.uid, session.email, card, 'raw_download', tab, ip).catch(() => {});
  } catch (e) {
    res.status(404).send('Raw data not available for this tab yet.');
  }
};
