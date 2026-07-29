// Consolidated JSON-data routes for the Next.js report pages that read either a
// data/*.json file or a live Postgres query (rather than a pre-rendered HTML file,
// which api/report/[card].js still serves) - one dynamic-route file per the same
// reasoning api/auth/[action].js and api/admin/[action].js already use: each new
// report's data endpoint would otherwise be its own file, and this repo is already at
// the Vercel Hobby plan's 12-serverless-function cap. req.query.key selects which
// data source/permission-card this request is for.
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, REPORTS_BUCKET } = require('../../_lib/s3');
const { getSession } = require('../../_lib/session');
const { logAccess, getCallingOverviewData } = require('../../_lib/db');

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const DATA_ROUTES = {
  productkyc: { file: 'productkyc_data.json', card: 'productkyc', page: '/productkyc' },
  'agent-shift-status': { file: 'agent_shift_status.json', card: 'deepdive', page: '/deepdive' },
  csat: { file: 'csat_dashboard_data.json', card: 'deepdive', page: '/deepdive' },
  'agent-activity': { file: 'agent_activity_data.json', card: 'deepdive', page: '/deepdive' },
  'calling-overview': { card: 'calling', tab: 'overview', page: '/calling-overview', query: getCallingOverviewData },
};

module.exports = async (req, res) => {
  const key = req.query && req.query.key;
  const route = DATA_ROUTES[key];
  if (!route) {
    res.status(404).json({ error: 'Unknown report data key' });
    return;
  }

  const session = await getSession(req);
  if (!session) {
    res.writeHead(302, { Location: `/login?next=${encodeURIComponent(route.page)}` });
    res.end();
    return;
  }
  if (!(session.perms || []).includes(route.card)) {
    res.status(403).json({ error: 'You do not have access to this report. Contact your admin to request access.' });
    return;
  }
  if (route.tab) {
    const tabs = session.tabPerms && session.tabPerms[route.card];
    if (Array.isArray(tabs) && tabs.length && !tabs.includes(route.tab)) {
      res.status(403).json({ error: 'You do not have access to this report. Contact your admin to request access.' });
      return;
    }
  }

  try {
    let payload;
    if (route.query) {
      payload = await route.query(req.query);
    } else {
      // These small JSON files are refreshed by refresh-deepdive.yml/similar and
      // uploaded to S3 (same reports/ prefix the big HTML reports already use) rather
      // than bundled into the Lambda's own deployment package - deploy.yml only
      // packages api/ + node_modules, and doesn't even trigger on data/** changes, so a
      // file living only in the Lambda's local filesystem would never actually reach
      // production regardless of how often it's regenerated.
      let body;
      try {
        const obj = await s3Client.send(new GetObjectCommand({ Bucket: REPORTS_BUCKET, Key: `reports/${route.file}` }));
        body = await streamToString(obj.Body);
      } catch (e) {
        // Any failure to fetch (missing key, or an access-denied that S3 returns instead
        // of a clean NoSuchKey when the caller also lacks s3:ListBucket on the bucket) is
        // reported the same user-facing way - a raw AWS SDK error/ARN has no actionable
        // meaning for someone looking at the dashboard, and logging it server-side is
        // what CloudWatch is for.
        console.error(`Failed to fetch reports/${route.file} from S3:`, e);
        res.status(404).json({ error: `Data for "${key}" has not been generated yet.` });
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(body);
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
      logAccess(session.uid, session.email, route.card, ip).catch(() => {});
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
    logAccess(session.uid, session.email, route.card, ip).catch(() => {});
  } catch (e) {
    res.status(500).json({ error: `Could not load data for "${key}": ` + (e.message || String(e)) });
  }
};
