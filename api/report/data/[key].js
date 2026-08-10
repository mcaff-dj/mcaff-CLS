// Consolidated JSON-data routes for the Next.js report pages that read either a
// data/*.json file or a live Postgres query (rather than a pre-rendered HTML file,
// which api/report/[card].js still serves) - one dynamic-route file per the same
// reasoning api/auth/[action].js and api/admin/[action].js already use: each new
// report's data endpoint would otherwise be its own file, and this repo is already at
// the Vercel Hobby plan's 12-serverless-function cap. req.query.key selects which
// data source/permission-card this request is for.
const { getSession } = require('../../_lib/session');
const { logAccess, getCallingOverviewData } = require('../../_lib/db');
const { signedReportUrl } = require('../../_lib/reportUrls');

const DATA_ROUTES = {
  // redirect: true for every file-backed route below (not just trend-digest, which is where
  // this started - see its own reasoning: a single shared artifact every Org Overview viewer
  // re-requests belongs on the CDN, not re-buffered through Lambda per request). The other
  // four are typically fetched by ~one viewer's own request rather than every viewer on every
  // load, but they buffer straight into Lambda's response body with no size guard at all, and
  // Lambda hard-caps a response payload at 6MB - a file that quietly crosses that (csat/
  // agent-activity scale with ticket volume) would turn into an opaque 500 with no warning.
  // The redirect costs nothing extra either way, so it's the default for a file-backed route
  // rather than something to revisit per file as each one grows.
  productkyc: { file: 'productkyc_data.json', card: 'productkyc', page: '/productkyc', redirect: true },
  'agent-shift-status': { file: 'agent_shift_status.json', card: 'deepdive', page: '/deepdive', redirect: true },
  csat: { file: 'csat_dashboard_data.json', card: 'deepdive', page: '/deepdive', redirect: true },
  'agent-activity': { file: 'agent_activity_data.json', card: 'deepdive', page: '/deepdive', redirect: true },
  'calling-overview': { card: 'calling', tab: 'overview', page: '/calling-overview', query: getCallingOverviewData },
  'trend-digest': { file: 'trend_digest.json', card: 'orgoverview', page: '/orgoverview', redirect: true },
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
    if (route.redirect) {
      // Same pattern as api/report/[card].js: sign a short-lived CloudFront URL and hand
      // back only the path+query so the browser's fetch stays same-origin (Amplify's own
      // /reports/<*> rewrite proxies it through to CloudFront server-side).
      const url = await signedReportUrl(`reports/${route.file}`);
      const { pathname, search } = new URL(url);
      res.writeHead(302, { Location: pathname + search, 'Cache-Control': 'no-store' });
      res.end();
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
      logAccess(session.uid, session.email, route.card, ip).catch(() => {});
      return;
    }

    // Every route reaching here has `query` - every file-backed route above has
    // redirect: true instead (see DATA_ROUTES's comment), so nothing left buffers a
    // data/*.json file through this Lambda directly.
    const payload = await route.query(req.query);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
    logAccess(session.uid, session.email, route.card, ip).catch(() => {});
  } catch (e) {
    res.status(500).json({ error: `Could not load data for "${key}": ` + (e.message || String(e)) });
  }
};
