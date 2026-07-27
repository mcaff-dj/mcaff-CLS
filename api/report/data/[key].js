// Consolidated JSON-data routes for the Next.js report pages that read either a
// data/*.json file or a live Postgres query (rather than a pre-rendered HTML file,
// which api/report/[card].js still serves) - one dynamic-route file per the same
// reasoning api/auth/[action].js and api/admin/[action].js already use: each new
// report's data endpoint would otherwise be its own file, and this repo is already at
// the Vercel Hobby plan's 12-serverless-function cap. req.query.key selects which
// data source/permission-card this request is for.
const fs = require('fs');
const path = require('path');
const { getSession } = require('../../_lib/session');
const { logAccess, getCallingOverviewData } = require('../../_lib/db');

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
      const filePath = path.join(__dirname, '..', '..', '..', 'data', route.file);
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: `Data for "${key}" has not been generated yet.` });
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(fs.readFileSync(filePath, 'utf8'));
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
