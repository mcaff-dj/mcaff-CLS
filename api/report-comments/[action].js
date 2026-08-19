// Private per-cell notes on report pivot tables (mcaffeine.html/hyphen.html and any other
// report reusing scripts/_shell_head.html's shared CSS/JS) - one note per (signed-in user,
// page, cell), never visible to anyone else. Same [action].js convention as
// api/auth/[action].js and api/escalation/[action].js, mounted the same way in
// api/_lambda/app.js.
//
// Actions: list | save
//
// By the time a report renders at all, api/report/[card].js has already required a
// session (see that file's header comment) - so in normal use this route is never
// actually reached signed-out. The 401 path below only matters if the session cookie
// expires while the report tab stays open (see the design doc's Client behavior section
// for how the sign-in link handles that from inside the report's iframe).
const { getSession } = require('../_lib/session');
const { getCellComments, saveCellComment } = require('../_lib/db');

const handler = async (req, res) => {
  const action = (req.query && req.query.action) || '';
  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  try {
    if (action === 'list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const page = (req.query && req.query.page) || '';
      if (!page) return res.status(400).json({ error: 'page is required' });
      const comments = await getCellComments(session.uid, page);
      return res.status(200).json({ comments });
    }

    if (action === 'save') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { page, cellKey, text } = req.body || {};
      if (!page) return res.status(400).json({ error: 'page is required' });
      if (!cellKey) return res.status(400).json({ error: 'cellKey is required' });
      await saveCellComment(session.uid, page, cellKey, text || '');
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Unknown report-comments route' });
  } catch (e) {
    console.error(`api/report-comments/${action} error:`, e);
    return res.status(500).json({ error: e.message || 'Report-comments request failed' });
  }
};

module.exports = handler;
