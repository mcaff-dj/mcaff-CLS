// The single entry point Lambda actually runs. Every api/*.js file below is still the
// exact same Vercel-style handler - (req, res) => {...} - untouched by this file except
// for the two dynamic-segment routes (auth/[action].js, report/[card].js), which read
// their dynamic piece off req.query today (Vercel's file-based routing convention), so
// this just copies Express's req.params value into req.query before calling them.
//
// Static assets (index.html, admin.html, generated reports, etc.) are NOT served from
// here - those come from S3 via CloudFront directly. This app only ever handles /api/*.
const express = require('express');

const app = express();
app.use(express.json());

function mount(method, path, handlerPath, paramName) {
  app[method](path, async (req, res) => {
    if (paramName) req.query[paramName] = req.params[paramName];
    try {
      await require(handlerPath)(req, res);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ error: e.message || String(e) });
      }
    }
  });
}

mount('all', '/api/auth/:action', '../auth/[action].js', 'action');

mount('get', '/api/admin/users', '../admin/users.js');
mount('post', '/api/admin/users', '../admin/users.js');
mount('delete', '/api/admin/users', '../admin/users.js');

mount('post', '/api/admin/permissions', '../admin/permissions.js');
mount('delete', '/api/admin/permissions', '../admin/permissions.js');
mount('put', '/api/admin/permissions', '../admin/permissions.js');

mount('get', '/api/admin/audit', '../admin/audit.js');

mount('post', '/api/log-export', '../log-export.js');
mount('post', '/api/onboarding/submit', '../onboarding/submit.js');
mount('post', '/api/refresh', '../refresh.js');
mount('get', '/api/refresh-status', '../refresh-status.js');
mount('post', '/api/refund/gokwik-initiate', '../refund/gokwik-initiate.js');

// Registered before the dynamic /api/report/:card route below - Express matches routes
// in registration order, so this literal path has to win the match before "raw" is ever
// tried as a :card value.
mount('get', '/api/report/raw', '../report/raw.js');
mount('get', '/api/report/:card', '../report/[card].js', 'card');

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

module.exports = app;
