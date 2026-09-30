const { pool } = require('./db');
const { slugify, randomId } = require('./util');

// Teams (Phase 3): one team per user. Creating joins it, and joining
// another is refused until you leave yours. Owners cannot leave; they
// disband instead, which removes the team and its memberships.

async function myTeam(userId) {
  const { rows } = await pool.query(
    `SELECT t.* FROM teams t JOIN team_members m ON m.team_id = t.id
     WHERE m.user_id = $1 LIMIT 1`, [userId]);
  return rows[0] || null;
}

async function detail(teamId) {
  const t = await pool.query(
    `SELECT t.*, u.username AS owner_username FROM teams t
     JOIN users u ON u.id = t.owner_user_id WHERE t.id = $1`, [teamId]);
  if (!t.rows.length) return null;
  const members = await pool.query(
    `SELECT u.username, u.display_name, u.avatar_url, m.role, m.joined_at,
            COALESCE((SELECT SUM(amount) FROM xp_events x WHERE x.user_id = u.id), 0) AS xp
     FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = $1
     ORDER BY 6 DESC, m.joined_at`, [teamId]);
  return { team: t.rows[0], members: members.rows.map(r => ({ ...r, xp: Number(r.xp) })) };
}

async function create(userId, name, tagline) {
  const clean = String(name || '').trim();
  if (!clean) return { error: 'A team name is required' };
  if (await myTeam(userId)) return { error: 'You are already in a team. Leave it before creating another.' };
  let slug = slugify(clean) || randomId(8);
  const dup = await pool.query('SELECT 1 FROM teams WHERE slug = $1', [slug]);
  if (dup.rows.length) slug = slug + '-' + randomId(4);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query(
      `INSERT INTO teams (slug, name, tagline, owner_user_id, join_code)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [slug, clean.slice(0, 255), tagline ? String(tagline).slice(0, 500) : null, userId, randomId(8)]);
    await client.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [t.rows[0].id, userId]);
    await client.query('COMMIT');
    return { team: t.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    return { error: 'Could not create the team' };
  } finally {
    client.release();
  }
}

async function join(userId, code) {
  const value = String(code || '').trim();
  if (!value) return { error: 'A join code is required' };
  if (await myTeam(userId)) return { error: 'You are already in a team. Leave it before joining another.' };
  const t = await pool.query('SELECT id FROM teams WHERE join_code = $1', [value]);
  if (!t.rows.length) return { error: 'This join code is not valid' };
  const ins = await pool.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')
     ON CONFLICT (team_id, user_id) DO NOTHING RETURNING user_id`, [t.rows[0].id, userId]);
  if (!ins.rows.length) return { error: 'You are already in a team. Leave it before joining another.' };
  return { joined: true, team_id: t.rows[0].id };
}

async function leave(userId) {
  const team = await myTeam(userId);
  if (!team) return { error: 'You are not in a team' };
  if (team.owner_user_id === userId) return { error: 'Owners cannot leave. Disband the team instead.' };
  await pool.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [team.id, userId]);
  return { left: true };
}

async function disband(userId) {
  const team = await myTeam(userId);
  if (!team) return { error: 'You are not in a team' };
  if (team.owner_user_id !== userId) return { error: 'Only the team owner can disband' };
  await pool.query('DELETE FROM teams WHERE id = $1', [team.id]);
  return { disbanded: true };
}

// All-team standings ranked by the total XP of their members.
async function board() {
  const { rows } = await pool.query(
    `SELECT t.id, t.slug, t.name, t.tagline,
            COUNT(m.user_id)::int AS members,
            COALESCE(SUM(x.xp), 0) AS xp
     FROM teams t
     JOIN team_members m ON m.team_id = t.id
     LEFT JOIN LATERAL (SELECT SUM(amount) AS xp FROM xp_events WHERE user_id = m.user_id) x ON TRUE
     GROUP BY t.id ORDER BY 6 DESC, t.created_at LIMIT 50`);
  return rows.map(r => ({ ...r, xp: Number(r.xp) }));
}

module.exports = { myTeam, detail, create, join, leave, disband, board };