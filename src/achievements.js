const { pool } = require('./db');

// Auto-unlocking achievements (Phase 3). criteria JSON is { metric, value };
// the evaluator runs inside the same reward transaction that changes the
// underlying counts, so an unlock lands exactly when it becomes true. The
// catalogue itself is platform content seeded by migrate().
const METRICS = ['quests_completed', 'xp_earned', 'badges_earned', 'referrals_qualified'];

// Pure so the criteria check is unit-testable without a database.
function meets(criteria, metrics) {
  const c = criteria && typeof criteria === 'object' ? criteria : {};
  if (!METRICS.includes(c.metric)) return false;
  const target = Number(c.value);
  if (!Number.isFinite(target)) return false;
  return Number(metrics[c.metric] || 0) >= target;
}

async function evaluate(client, userId) {
  const c = client || pool;
  const [ach, m] = await Promise.all([
    c.query('SELECT id, key, name, criteria FROM achievements'),
    c.query(
      `SELECT
         (SELECT COUNT(*)::int FROM quest_completions WHERE user_id = $1) AS quests_completed,
         (SELECT COALESCE(SUM(amount), 0)::int FROM xp_events WHERE user_id = $1) AS xp_earned,
         (SELECT COUNT(*)::int FROM user_badges WHERE user_id = $1) AS badges_earned,
         (SELECT COUNT(*)::int FROM referrals WHERE referrer_user_id = $1 AND status = 'qualified') AS referrals_qualified`,
      [userId]),
  ]);
  const metrics = m.rows[0];
  const unlocked = [];
  for (const a of ach.rows) {
    if (!meets(a.criteria, metrics)) continue;
    const ins = await c.query(
      `INSERT INTO user_achievements (user_id, achievement_id, source_type, source_id)
       VALUES ($1, $2, 'criteria', NULL)
       ON CONFLICT (user_id, achievement_id) DO NOTHING
       RETURNING achievement_id`, [userId, a.id]);
    if (ins.rows.length) {
      unlocked.push({ key: a.key, name: a.name });
      await c.query(
        `INSERT INTO notifications (user_id, type, title, body, dedupe_key)
         VALUES ($1, 'achievement_unlocked', $2, $3, $4)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [userId, 'Achievement unlocked', `${a.name} is now on your profile.`,
          'achievement:' + a.id + ':' + userId]);
    }
  }
  return { unlocked };
}

// Every achievement with this user's unlock state, for the profile tab.
async function forUser(userId) {
  const { rows } = await pool.query(
    `SELECT a.key, a.name, a.description, a.criteria, ua.unlocked_at
     FROM achievements a
     LEFT JOIN user_achievements ua ON ua.achievement_id = a.id AND ua.user_id = $1
     ORDER BY a.id`, [userId]);
  return rows;
}

module.exports = { METRICS, meets, evaluate, forUser };