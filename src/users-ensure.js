// Keeps `users` mirroring the platform JWT identity. Called once per
// authenticated request (single idempotent upsert).
let pool = null;
function setPool(p) { pool = p; }

// Admin status is configuration, never an accident of registration order:
// it comes from the ADMIN_USERNAMES secret (comma-separated Homeroom
// usernames, case-insensitive) declared in dapp.json. Nobody becomes an
// admin any other way; the role is re-synced on every request so a
// username removed from the list loses the role on their next visit.
function adminUsernames() {
  return String(process.env.ADMIN_USERNAMES || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function isAdminUsername(username) {
  return adminUsernames().includes(String(username || '').toLowerCase());
}

async function ensureUser(claims) {
  if (!pool || !claims || !claims.id) return claims;
  const role = isAdminUsername(claims.username) ? 'admin' : 'user';
  let rows;
  try {
    ({ rows } = await upsert(claims.id, claims.username, role));
  } catch (err) {
    if (err.code !== '23505') throw err;
    // This platform id already has a row: the name the JWT carries is
    // contested. Whoever the mirror already gave it to keeps it; this user
    // keeps their row's current handle rather than stealing it back on
    // every visit.
    const mine = await pool.query(
      'SELECT id, username, role FROM users WHERE usernode_id = $1',
      [String(claims.id)]);
    if (mine.rows.length) {
      return {
        ...claims,
        username: mine.rows[0].username,
        role,
        db_id: mine.rows[0].id,
      };
    }
    // First contact under this platform id: the JWT is authoritative, this
    // id owns the username NOW. A row holding it under a different
    // usernode_id is stale (the platform user renamed). Rename the stale
    // row aside and retry, so the current holder of the name is never
    // bricked by a leftover mirror row.
    await pool.query(
      `UPDATE users SET username = username || '-stale-' || id || '-' || $1
       WHERE lower(username) = lower($2) AND usernode_id <> $1`,
      [String(claims.id), claims.username]);
    ({ rows } = await upsert(claims.id, claims.username, role));
  }
  return { ...claims, db_id: rows[0].id, role: rows[0].role };
}

function upsert(usernodeId, username, role) {
  return pool.query(
    `INSERT INTO users (usernode_id, username, display_name, role)
     VALUES ($1, $2, $2, $3)
     ON CONFLICT (usernode_id) DO UPDATE SET
       username = EXCLUDED.username, role = EXCLUDED.role
     RETURNING id, role`,
    [usernodeId, username, role]
  );
}

module.exports = { setPool, ensureUser, isAdminUsername };
