// Keeps `users` mirroring the platform JWT identity. Called once per
// authenticated request (single idempotent upsert).
let pool = null;
function setPool(p) { pool = p; }

async function ensureUser(claims) {
  if (!pool || !claims || !claims.id) return claims;
  const { rows } = await pool.query(
    `INSERT INTO users (usernode_id, username, display_name)
     VALUES ($1, $2, $2)
     ON CONFLICT (usernode_id) DO UPDATE SET username = EXCLUDED.username
     RETURNING id`,
    [claims.id, claims.username]
  );
  return { ...claims, db_id: rows[0].id };
}

module.exports = { setPool, ensureUser };
