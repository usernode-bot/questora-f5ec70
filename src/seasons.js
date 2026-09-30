const { pool } = require('./db');

// Seasons (Phase 3). The active season applies its xp_multiplier to every
// XP award (see reward.awardXp) and stamps xp_events.season_id, which is
// what seasonal leaderboards filter on. Admins create seasons from the
// admin panel; Season 1 is the standing default seeded by migrate().

// Pure so status and rounding logic is unit-testable without a database.
function statusOf(season, now) {
  if (!season) return 'ended';
  const t = (now || new Date()).getTime();
  if (t < new Date(season.starts_at).getTime()) return 'upcoming';
  if (t >= new Date(season.ends_at).getTime()) return 'ended';
  return 'active';
}

function multiplierOf(season) {
  if (!season) return 1;
  const m = Number(season.xp_multiplier);
  return Number.isFinite(m) && m > 0 ? m : 1;
}

// The season active right now, or null between seasons.
async function current(client) {
  const { rows } = await (client || pool).query(
    `SELECT * FROM seasons WHERE starts_at <= NOW() AND ends_at > NOW()
     ORDER BY starts_at DESC LIMIT 1`);
  return rows[0] || null;
}

// Every season with a computed status, for the leaderboard picker and admin.
async function list(client) {
  const { rows } = await (client || pool).query('SELECT * FROM seasons ORDER BY starts_at DESC');
  return rows.map(s => ({ ...s, status: statusOf(s), xp_multiplier: Number(s.xp_multiplier) }));
}

// Resolve a leaderboard ?season= value: numeric id or slug.
async function find(idOrSlug, client) {
  const c = client || pool;
  if (/^\d+$/.test(String(idOrSlug))) {
    const { rows } = await c.query('SELECT * FROM seasons WHERE id = $1', [Number(idOrSlug)]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await c.query('SELECT * FROM seasons WHERE slug = $1', [String(idOrSlug)]);
  return rows[0] || null;
}

module.exports = { statusOf, multiplierOf, current, list, find };