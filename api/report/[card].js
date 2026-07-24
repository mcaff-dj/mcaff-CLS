// Gated report server: GET /api/report/mcaffeine|hyphen|productkyc
// The actual HTML lives in S3 (uploaded by the GitHub Actions refresh job, NOT bundled
// with this Lambda's code - report files can be tens of MB, well over what Lambda/API
// Gateway can return directly), so this function only ever makes the allow/deny
// decision and hands back a short-lived link - the browser fetches the file straight
// from S3 after that, never through Lambda.
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3Client, REPORTS_BUCKET } = require('../_lib/s3');
const { getSession } = require('../_lib/session');
const { CARD_KEYS, logAccess } = require('../_lib/db');

module.exports = async (req, res) => {
  const card = (req.query && req.query.card) || '';
  if (!CARD_KEYS.includes(card)) {
    res.status(404).send('Not found');
    return;
  }

  const session = getSession(req);
  if (!session) {
    res.writeHead(302, { Location: `/login.html?next=${encodeURIComponent('/api/report/' + card)}` });
    res.end();
    return;
  }
  if (!(session.perms || []).includes(card)) {
    res.status(403).send('You do not have access to this report. Contact your admin to request access.');
    return;
  }

  try {
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: REPORTS_BUCKET, Key: `reports/${card}.html` }),
      { expiresIn: 60 }
    );
    res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
    res.end();
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
    logAccess(session.uid, session.email, card, ip).catch(() => {});
  } catch (e) {
    res.status(500).send('Could not load report: ' + (e.message || String(e)));
  }
};
