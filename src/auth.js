const jwt = require('jsonwebtoken');
const { ensureUser } = require('./users-ensure');

const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// In-loop development only: an RSA keypair the platform does not inject.
// Ships disabled in production, where the real key is always present.
const DEV_JWT_PUBLIC_KEY = (process.env.USERNODE_DEV_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');
const DEV_AUDIENCE = 'usernode:app:999';


function verifyToken(token) {
  if (!token) return null;
  try {
    if (JWT_PUBLIC_KEY && APP_AUDIENCE) {
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      return claims && claims.pur === 'iframe' ? claims : null;
    }
    if (DEV_JWT_PUBLIC_KEY) {
      const claims = jwt.verify(token, DEV_JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: DEV_AUDIENCE,
      });
      return claims && claims.pur === 'iframe' ? claims : null;
    }
  } catch { return null; }
  return null;
}

// Verifies the platform-issued JWT if one was passed, then enforces auth on
// anything not explicitly marked public. The iframe adds `?token=` on load;
// the frontend forwards the token via `x-usernode-token` on fetches.
function authMiddleware(PUBLIC_API_PATHS) {
  return async (req, res, next) => {
    const token = req.query.token || req.headers['x-usernode-token'];
    const claims = verifyToken(token);
    if (claims) {
      req.user = claims;
      try {
        req.user = await ensureUser(claims);
      } catch (err) {
        console.warn('user upsert failed: ' + err.message);
      }
    }
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      if (PUBLIC_API_PATHS.has(req.path)) return next();
      if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
  };
}

module.exports = { authMiddleware, verifyToken };
