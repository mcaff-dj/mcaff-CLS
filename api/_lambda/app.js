// The single entry point Lambda actually runs. Every api/*.js file below is still the
// exact same Vercel-style handler - (req, res) => {...} - untouched by this file except
// for the two dynamic-segment routes (auth/[action].js, report/[card].js), which read
// their dynamic piece off req.query today (Vercel's file-based routing convention), so
// this just copies Express's req.params value into req.query before calling them.
//
// Static assets (index.html, admin.html, generated reports, etc.) are NOT served from
// here - those come from S3 via CloudFront directly. This app only ever handles /api/*.
const express = require('express');
const compression = require('compression');
const { ensureAppSecretsLoaded } = require('../_lib/secrets');

const app = express();

// gzip, and it is load-bearing rather than a nicety. API Gateway hard-fails any Lambda response
// over 6 MB, and that ceiling counts the JSON-ESCAPED envelope, not the raw body - escaping the
// quotes in a JSON payload adds ~14%. On 2026-08-19 the RTO sheet read crossed it (5.64 MB raw =
// 6.43 MB escaped) and the CRM died with opaque 500s: agents could not see their leads, could not
// dispose them, so their load never fell below quota and lead assignment stalled behind it.
//
// Measured on that exact payload (5.03 MB of sheet JSON), the response envelope becomes:
//   uncompressed  5.71 MB   (~4% under the ceiling - one busy week from failing again)
//   gzip level 1  1.88 MB   60 ms
//   gzip level 6  1.65 MB   121 ms
//
// Level 1 deliberately, not the level-6 default: it captures ~75% of the reduction for half the
// CPU, and CPU is the scarce resource here - this Lambda is memory-throttled, so every extra
// millisecond of compression lands on every request. The remaining 0.23 MB buys nothing against a
// 6 MB ceiling we are now 3x clear of.
//
// A real browser offers brotli, so most responses take compression's brotli path rather than the
// gzip one; `level` above only governs gzip/deflate. That is fine and slightly better (1.11 MB in
// 90 ms on the same payload) ONLY because compression pins BROTLI_PARAM_QUALITY to 4 itself.
// Do NOT pass a `brotli` option here without setting that quality explicitly: node's own default
// is 11, and quality 11 on this payload measured **12.4 seconds** - it would exceed the function
// timeout on every large read and take the CRM down exactly the way the 6 MB ceiling did.
//
// Safe by construction on both ends. serverless-http sets isBase64Encoded automatically whenever
// content-encoding is gzip/deflate/br (see its lib/provider/aws/is-binary.js), and this API is an
// API Gateway *HTTP* API (v2 - confirmed by the apigw-requestid response header; a REST API would
// send x-amzn-RequestId), which base64-decodes such responses automatically with no
// binaryMediaTypes configuration. And if Accept-Encoding never reaches the Lambda, compression
// simply no-ops back to today's behaviour rather than breaking.
//
// All of that is pinned by api/_lambda/compression.test.js - run it if you touch these options.
//
// Mounted FIRST so it wraps every response, including error paths.
app.use(compression({ level: 1 }));

app.use(async (req, res, next) => {
  try {
    await ensureAppSecretsLoaded();
    next();
  } catch (e) {
    res.status(500).json({ error: 'Server not configured: could not load app secrets - ' + (e.message || String(e)) });
  }
});
// 5mb, not the 100kb default: the Escalation desk's `import` action takes a whole pasted CSV
// as a JSON string body (see api/escalation/[action].js, whose own Vercel-side `config` export
// sets the same figure). Every other route here sends small JSON and is unaffected.
app.use(express.json({ limit: '5mb' }));

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

mount('all', '/api/admin/:action', '../admin/[action].js', 'action');

mount('post', '/api/log-export', '../log-export.js');
mount('post', '/api/onboarding/submit', '../onboarding/submit.js');
mount('post', '/api/refresh', '../refresh.js');
mount('get', '/api/refresh-status', '../refresh-status.js');
mount('post', '/api/refresh-deepdive', '../refresh-deepdive.js');
mount('get', '/api/refresh-deepdive-status', '../refresh-deepdive-status.js');
mount('post', '/api/refund/gokwik-initiate', '../refund/gokwik-initiate.js');
mount('get', '/api/refund-export', '../refund-export.js');
mount('get', '/api/nps-product-export', '../nps-product-export.js');
mount('post', '/api/order-punch/start', '../order-punch/start.js');
mount('get', '/api/order-punch/status', '../order-punch/status.js');
mount('post', '/api/order-punch/stop', '../order-punch/stop.js');
mount('get', '/api/order-punch/results', '../order-punch/results.js');
mount('all', '/api/order-punch/settings', '../order-punch/settings.js');
mount('all', '/api/rto/sheet', '../rto/sheet.js');
mount('post', '/api/rto/claim', '../rto/claim.js');
mount('post', '/api/rto/next-lead', '../rto/next-lead.js');
mount('post', '/api/rto/upload-start', '../rto/upload-start.js');
mount('get', '/api/rto/upload-status', '../rto/upload-status.js');
mount('all', '/api/ndr/sheet', '../ndr/sheet.js');
mount('post', '/api/ndr/lead-assignment', '../ndr/lead-assignment.js');
mount('post', '/api/ndr/upload', '../ndr/upload.js');
mount('post', '/api/ndr/next-lead', '../ndr/next-lead.js');
mount('all', '/api/delivery-escalation/sheet', '../delivery-escalation/sheet.js');
mount('all', '/api/delivery-escalation/record', '../delivery-escalation/record.js');
mount('get', '/api/delivery-escalation/fresh-export', '../delivery-escalation/fresh-export.js');
mount('all', '/api/delivery-escalation/sales-pincode-import', '../delivery-escalation/sales-pincode-import.js');
mount('all', '/api/nps-admin/surveys', '../nps-admin/surveys.js');
mount('all', '/api/nps-admin/recipients', '../nps-admin/recipients.js');
mount('post', '/api/nps-admin/send', '../nps-admin/send.js');
mount('get', '/api/nps-admin/preview-link', '../nps-admin/preview-link.js');
mount('get', '/api/nps-admin/dashboard', '../nps-admin/dashboard.js');
mount('all', '/api/nps/public/:token', '../nps/public/[token].js', 'token');
mount('all', '/api/mom/:action', '../mom/[action].js', 'action');

// The Escalation desk's whole API surface - one dynamic-segment handler, same shape as the
// two :action mounts above (agents/orders/assign/tag/update/bulk-update/import/export/sample).
mount('all', '/api/escalation/:action', '../escalation/[action].js', 'action');

// Private per-cell report comments (list/save) - see docs/superpowers/specs/
// 2026-08-19-report-cell-comments-design.md.
mount('all', '/api/report-comments/:action', '../report-comments/[action].js', 'action');

// Registered before the dynamic /api/report/:card route below - Express matches routes
// in registration order, so these more specific paths have to win the match before
// "raw"/"data" are ever tried as a :card value.
mount('get', '/api/report/raw', '../report/raw.js');
mount('get', '/api/report/data/:key', '../report/data/[key].js', 'key');
mount('get', '/api/report/:card', '../report/[card].js', 'card');

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Manual deploy trigger touch (2026-08-12) - no functional change.
module.exports = app;
