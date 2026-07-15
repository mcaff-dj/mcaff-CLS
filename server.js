const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;
  
  // CORS Headers for local development ease
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 1. Mock API Endpoints
  
  // Auth Check Endpoint
  if (pathname === '/api/auth/me') {
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
    res.end(JSON.stringify({
      authenticated: true,
      email: "developer@local",
      name: "Local Developer",
      isAdmin: true,
      cards: [
        { key: "mcaffeine", label: "mCaffeine" },
        { key: "hyphen", label: "Hyphen" },
        { key: "productkyc", label: "Product Calling KYC" }
      ]
    }));
    return;
  }

  // Mock Login redirect
  if (pathname === '/api/auth/login') {
    const next = parsedUrl.query.next || '/dashboard.html';
    res.writeHead(302, { 'Location': next });
    res.end();
    return;
  }

  // Mock Logout redirect
  if (pathname === '/api/auth/logout') {
    res.writeHead(302, { 'Location': '/index.html' });
    res.end();
    return;
  }

  // Gated Reports serve logic (reads from api/_reports/)
  if (pathname.startsWith('/api/report/')) {
    const card = pathname.replace('/api/report/', '');
    
    // Raw CSV downloads handler
    if (card === 'raw') {
      const targetCard = parsedUrl.query.card;
      const tab = parsedUrl.query.tab;
      const filePath = path.join(__dirname, 'api', '_reports', `${targetCard}_raw_${tab}.csv.gz`);
      
      if (fs.existsSync(filePath)) {
        try {
          const compressed = fs.readFileSync(filePath);
          const decompressed = zlib.gunzipSync(compressed);
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${targetCard}_${tab}_raw.csv"`,
            'Cache-Control': 'no-store'
          });
          res.end(decompressed);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error decompressing CSV: ' + e.message);
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Raw CSV export not found.');
      }
      return;
    }

    // Serving HTML reports
    const filePath = path.join(__dirname, 'api', '_reports', `${card}.html`);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Report file not found.');
    }
    return;
  }

  // Mock Admin Users List
  if (pathname === '/api/admin/users') {
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
    res.end(JSON.stringify({
      cardKeys: ["mcaffeine", "hyphen", "productkyc"],
      users: [
        { id: 1, email: "developer@local", name: "Local Developer", is_admin: true, permissions: ["mcaffeine", "hyphen", "productkyc"], created_at: new Date().toISOString() },
        { id: 2, email: "manager@local", name: "Report Manager", is_admin: false, permissions: ["mcaffeine", "hyphen"], created_at: new Date().toISOString() }
      ]
    }));
    return;
  }

  // Mock Admin Audit logs
  if (pathname === '/api/admin/audit') {
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
    res.end(JSON.stringify({
      entries: [
        { email: "developer@local", card_key: "mcaffeine", cardLabel: "mCaffeine", accessed_at: new Date().toISOString(), ip: "127.0.0.1" },
        { email: "developer@local", card_key: "hyphen", cardLabel: "Hyphen", accessed_at: new Date().toISOString(), ip: "127.0.0.1" }
      ]
    }));
    return;
  }

  // Mock Admin Permissions update
  if (pathname === '/api/admin/permissions') {
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Mock Data Refresh Triggers
  if (pathname === '/api/refresh') {
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
    res.end(JSON.stringify({ status: "started", message: "Refresh started (Mock Action succeeded)." }));
    return;
  }

  if (pathname === '/api/refresh-status') {
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] });
    res.end(JSON.stringify({
      status: "completed",
      conclusion: "success",
      updated_at: new Date().toISOString(),
      run_url: "#"
    }));
    return;
  }

  // Stub Vercel insights
  if (pathname.includes('/_vercel/insights/')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end('// Mock Vercel Insights');
    return;
  }

  // 2. Static File Server Routing
  
  // Normalize directories & extensions
  if (pathname === '/') pathname = '/index.html';
  
  // Support clean URLs for .html
  let ext = path.extname(pathname);
  let filePath = path.join(__dirname, pathname);
  
  if (!ext) {
    if (fs.existsSync(filePath + '.html')) {
      filePath += '.html';
      ext = '.html';
    } else if (fs.existsSync(path.join(filePath, 'index.html'))) {
      filePath = path.join(filePath, 'index.html');
      ext = '.html';
    }
  }

  // Check file existence and serve
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>404 Not Found</h1><p>The requested file could not be found locally.</p>');
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Local Mock Server running at http://localhost:${PORT}`);
  console.log(`📊 Unified Dashboard accessible at http://localhost:${PORT}/dashboard`);
  console.log(`Press Ctrl+C to terminate the server.\n`);
});
