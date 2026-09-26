const { pool } = require('./db');

// Level thresholds live in `level_thresholds`, never in code. Admins edit
// them from the admin panel; this lookup is the only consumer.
async function thresholds() {
  const { rows } = await pool.query('SELECT level, min_xp FROM level_thresholds ORDER BY min_xp');
  return rows.map(r => ({ level: r.level, min_xp: Number(r.min_xp) }));
}

// Pure helper so the curve logic is unit-testable without a database.
function levelForXp(xp, thresholdRows) {
  let current = thresholdRows.length ? thresholdRows[0].level : 1;
  for (const t of thresholdRows) {
    if (xp >= t.min_xp) current = t.level;
  }
  return current;
}

function nextThreshold(xp, thresholdRows) {
  for (const t of thresholdRows) {
    if (t.min_xp > xp) return t;
  }
  return null;
}

async function userLevel(userId) {
  const [thr, tot] = await Promise.all([
    thresholds(),
    pool.query('SELECT COALESCE(SUM(amount), 0) AS xp FROM xp_events WHERE user_id = $1', [userId]),
  ]);
  const xp = Number(tot.rows[0].xp);
  return { xp, level: levelForXp(xp, thr), next: nextThreshold(xp, thr) };
}

// Returns { leveledUp, level } after an xp write; false when unchanged.
async function maybeLevelUp(client, userId, previousXp, newXp) {
  const thr = await client.query('SELECT level, min_xp FROM level_thresholds ORDER BY min_xp');
  const before = levelForXp(previousXp, thr.rows.map(r => ({ level: r.level, min_xp: Number(r.min_xp) })));
  const after = levelForXp(newXp, thr.rows.map(r => ({ level: r.level, min_xp: Number(r.min_xp) })));
  if (after > before) {
    await client.query(
      `INSERT INTO notifications (user_id, type, title, body, link)
       VALUES ($1, 'level_up', $2, $3, '/u/' || (SELECT username FROM users WHERE id = $1))`,
      [userId, 'Level up!', `You reached level ${after}. Keep questing.`]
    );
  }
  return { leveledUp: after > before, level: after, previous: before };
}

module.exports = { thresholds, levelForXp, nextThreshold, userLevel, maybeLevelUp };
