const { pool } = require('./db');
const levels = require('./levels');

// The ONLY writer of XP, points and badges. One transaction; the UNIQUE
// constraints on xp_events/points_events/user_badges make every award
// idempotent, so a double click or a retried request can never pay twice.
async function awardXp(client, userId, amount, sourceType, sourceId) {
  const cap = await client.query("SELECT value FROM platform_settings WHERE key = 'xp'");
  const dailyCap = (cap.rows[0] && cap.rows[0].value && cap.rows[0].value.daily_cap) || 5000;
  const today = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM xp_events
     WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
    [userId]
  );
  const earnedToday = Number(today.rows[0].total);
  const allowed = Math.max(0, Math.min(amount, dailyCap - earnedToday));
  if (allowed <= 0) return { awarded: 0, capped: true };
  const prev = await client.query('SELECT COALESCE(SUM(amount),0) AS xp FROM xp_events WHERE user_id = $1', [userId]);
  const beforeXp = Number(prev.rows[0].xp);
  const ins = await client.query(
    `INSERT INTO xp_events (user_id, amount, source_type, source_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_type, source_id, user_id) DO NOTHING
     RETURNING amount`,
    [userId, allowed, sourceType, sourceId]
  );
  if (!ins.rows.length) return { awarded: 0, capped: false };
  await levels.maybeLevelUp(client, userId, beforeXp, beforeXp + allowed);
  return { awarded: allowed, capped: allowed < amount };
}

async function awardPoints(client, userId, amount, sourceType, sourceId) {
  if (!amount) return { awarded: 0 };
  const sys = await client.query("SELECT id FROM points_systems WHERE key = 'global' LIMIT 1");
  if (!sys.rows.length) return { awarded: 0 };
  const ins = await client.query(
    `INSERT INTO points_events (system_id, user_id, amount, source_type, source_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_type, source_id, user_id, system_id) DO NOTHING
     RETURNING amount`,
    [sys.rows[0].id, userId, amount, sourceType, sourceId]
  );
  return { awarded: ins.rows.length ? amount : 0 };
}

async function awardBadge(client, userId, badgeId, sourceType, sourceId) {
  if (!badgeId) return false;
  const ins = await client.query(
    `INSERT INTO user_badges (user_id, badge_id, source_type, source_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, badge_id) DO NOTHING
     RETURNING badge_id`,
    [userId, badgeId, sourceType, sourceId]
  );
  if (ins.rows.length) {
    const b = await client.query('SELECT name FROM badges WHERE id = $1', [badgeId]);
    await client.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'badge_earned', $2, $3)`,
      [userId, 'Badge unlocked', b.rows[0] ? b.rows[0].name : '']
    );
  }
  return ins.rows.length > 0;
}

// Complete a quest for a user if every required task is verified. Returns
// { completed, xp, points, badge } and is safe to call repeatedly.
async function completeQuest(questId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query('SELECT * FROM quests WHERE id = $1', [questId]);
    if (!q.rows.length) { await client.query('ROLLBACK'); return { completed: false, reason: 'not_found' }; }
    const quest = q.rows[0];

    const existing = await client.query(
      'SELECT id FROM quest_completions WHERE quest_id = $1 AND user_id = $2', [questId, userId]);
    if (existing.rows.length) { await client.query('ROLLBACK'); return { completed: false, reason: 'already_completed' }; }

    // Condition: every required task must have a verified submission.
    const reqTasks = await client.query(
      'SELECT id, type FROM quest_tasks WHERE quest_id = $1 ORDER BY sort_order', [questId]);
    for (const t of reqTasks.rows) {
      const sub = await client.query(
        `SELECT status FROM task_submissions
         WHERE task_id = $1 AND user_id = $2 AND status = 'verified'
         ORDER BY created_at DESC LIMIT 1`, [t.id, userId]);
      if (!sub.rows.length) { await client.query('ROLLBACK'); return { completed: false, reason: 'tasks_incomplete' }; }
    }

    const camp = await client.query(
      'SELECT xp_multiplier FROM campaigns WHERE id = $1', [quest.campaign_id]);
    const mult = camp.rows[0] ? Number(camp.rows[0].xp_multiplier) : 1;
    const xp = Math.round(quest.xp_reward * mult);

    await client.query(
      `INSERT INTO quest_completions (quest_id, user_id, status, xp_awarded)
       VALUES ($1, $2, 'completed', $3)`,
      [questId, userId, xp]
    );
    const xpRes = await awardXp(client, userId, xp, 'quest', questId);
    const ptsRes = await awardPoints(client, userId, quest.points_reward, 'quest', questId);

    // Quest-level badge reward, configured as quest.badge_reward via rewards
    // rows (kind = badge, quest_id set).
    const badgeRew = await client.query(
      `SELECT r.config->>'badge_id' AS badge_id FROM rewards r
       WHERE r.quest_id = $1 AND r.kind = 'badge' LIMIT 1`, [questId]);
    let badge = false;
    if (badgeRew.rows[0] && badgeRew.rows[0].badge_id) {
      badge = await awardBadge(client, userId, Number(badgeRew.rows[0].badge_id), 'quest', questId);
    }

    await client.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'quest_completed', $2, $3)`,
      [userId, 'Quest completed', `${quest.title} verified. +${xpRes.awarded} XP.`]
    );

    // Campaign completion: all required quests done -> notify.
    const campQuests = await client.query(
      `SELECT id FROM quests WHERE campaign_id = $1 AND is_required = TRUE`, [quest.campaign_id]);
    const done = await client.query(
      `SELECT COUNT(*)::int AS n FROM quest_completions
       WHERE user_id = $1 AND quest_id = ANY($2)`, [userId, campQuests.rows.map(r => r.id)]);
    if (campQuests.rows.length && done.rows[0].n >= campQuests.rows.length) {
      const already = await client.query(
        `SELECT 1 FROM xp_events WHERE user_id = $1 AND source_type = 'campaign' AND source_id = $2`,
        [userId, quest.campaign_id]);
      if (!already.rows.length) {
        await client.query(
          `INSERT INTO notifications (user_id, type, title, body)
           VALUES ($1, 'campaign_completed', $2, $3)`,
          [userId, 'Campaign completed', 'You finished every required quest. Nice work.']
        );
      }
    }

    await client.query('COMMIT');
    return { completed: true, xp: xpRes.awarded, points: ptsRes.awarded, badge };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { awardXp, awardPoints, awardBadge, completeQuest };
