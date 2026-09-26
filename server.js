const express = require('express');
const path = require('path');
const { pool, migrate, IS_STAGING } = require('./src/db');
const { authMiddleware } = require('./src/auth');
const usersEnsure = require('./src/users-ensure');
const rbac = require('./src/rbac');
const { seed } = require('./src/seed');

const app = express();
const port = process.env.PORT || 3000;
const IS_DEV = !process.env.USERNODE_PLATFORM_ORIGIN;

// The platform signs user-identity tokens with an RSA private key it never
// shares; this app only verifies them (see src/auth.js).
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());
usersEnsure.setPool(pool);
rbac.setPool(pool);

// Centrally hosted platform files, by relative path, never vendored. In
// production/staging the edge answers before this process; this handler
// covers a plain `node server.js`.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) {
      // Plain local run without the platform edge: a minimal no-op bridge
      // keeps the app functional; the real files are served on the platform.
      if (req.path.startsWith('/usernode-bridge/')) {
        return res.type('application/javascript').send('window.usernode = window.usernode || {};');
      }
      return res.sendStatus(503);
    }
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// JWT verify + user upsert, then deny-by-default on the API and non-GETs.
app.use(authMiddleware(PUBLIC_API_PATHS));

app.get('/health', (_req, res) => {
  if (global.__shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  res.json({ status: 'ok' });
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Versioned API.
app.use('/api/v1/wallets', require('./src/routes/wallets'));
app.use('/api/v1', require('./src/routes/creator'));
app.use('/api/v1', require('./src/routes/quests'));
app.use('/api/v1', require('./src/routes/misc'));

// Template-era endpoints are gone; any client that still calls them gets a
// clean pointer to the real API.
app.use('/api', (req, res) => res.status(404).json({ error: 'Use /api/v1' }));

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: authenticated visits get the app; unauthenticated top-level
// document visits redirect to the platform's chromeless view so share
// links land on the shared screen.
app.get('*', (req, res) => {
  if (!req.user) {
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/questora-f5ec70/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits are not authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/questora-f5ec70/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await migrate();
  await seed();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));

  // Graceful shutdown per platform convention: stop accepting, drain ~3s,
  // close the pool, exit. Idempotent across SIGTERM + SIGINT.
  let shuttingDown = false;
  global.__shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    global.__shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining`);
    server.close(() => {});
    server.closeIdleConnections && server.closeIdleConnections();
    const t = setTimeout(() => server.closeAllConnections && server.closeAllConnections(), 3000);
    t.unref && t.unref();
    try { await pool.end(); } catch (e) { console.error('[shutdown] pool.end failed', e.message); }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
