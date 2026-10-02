const { pool } = require('./db');
const levels = require('./levels');
const seasons = require('./seasons');
const reputation = require('./reputation');
const achievements = require('./achievements');
const risk = require('./risk');

// The ONLY writer of XP, points and badges. One transaction; the UNIQUE
// constraints on xp_events/points_events/user_badges make every award
// idempotent, so a double click or a retried request can never pay twice.
async function awardXp(client, userId, amount, sourceType, sourceId, scope) {
  // Seasonal multiplier (Phase 3): the active season boosts every XP
  // source, and the ledger row is stamped with the season so seasonal
  // leaderboards are a plain filter on xp_events.
  const season = await seasons.current(client);
  const effective = Math.max(0, Math.round(amount * seasons.multiplierOf(season)));
  const cap = await client.query("SELECT value FROM platform_settings WHERE key = 'xp'");
  const dailyCap = (cap.rows[0] && cap.rows[0].value && cap.rows[0].value.daily_cap) || 5000;
  const today = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM xp_events
     WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
    [userId]
  );
  const earnedToday = Number(today.rows[0].total);
  const allowed = Math.max(0, Math.min(effective, dailyCap - earnedToday));
  if (allowed <= 0) return { awarded: 0, capped: true };
  const prev = await client.query('SELECT COALESCE(SUM(amount),0) AS xp FROM xp_events WHERE user_id = $1', [userId]);
  const beforeXp = Number(prev.rows[0].xp);
  scope = scope || {};
  // A caller may also pin an idempotency key (task XP), so the partial unique
  // index on xp_events.idempotency_key guards it a second time alongside the
  // (source_type, source_id, user_id) constraint.
  const ins = await client.query(
    `INSERT INTO xp_events (user_id, amount, source_type, source_id, season_id, project_id, campaign_id, quest_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_type, source_id, user_id) DO NOTHING
     RETURNING amount`,
    [userId, allowed, sourceType, sourceId, season ? season.id : null,
      scope.project_id || null, scope.campaign_id || null, scope.quest_id || null,
      scope.idempotency_key || null]
  );
  if (!ins.rows.length) return { awarded: 0, capped: false };
  await levels.maybeLevelUp(client, userId, beforeXp, beforeXp + allowed);
  return { awarded: allowed, capped: allowed < amount };
}

// One points row per award, tagged with its scope. The scope FKs are the
// thing leaderboards filter on, so there is no second 'global' row to
// double-count once a project leaderboard sums by project_id.
async function awardPoints(client, userId, amount, sourceType, sourceId, scope) {
  if (!amount) return { awarded: 0 };
  scope = scope || {};
  // Prefer the project's own points system when one exists (Phase 2 named
  // ledger); fall back to the legacy global system so an award never drops.
  let systemId = null;
  if (scope.project_id) {
    const sys = await client.query(
      'SELECT id FROM points_systems WHERE project_id = $1 ORDER BY id LIMIT 1', [scope.project_id]);
    systemId = sys.rows.length ? sys.rows[0].id : null;
  }
  if (!systemId) {
    const sys = await client.query("SELECT id FROM points_systems WHERE key = 'global' LIMIT 1");
    if (!sys.rows.length) return { awarded: 0 };
    systemId = sys.rows[0].id;
  }
  const ins = await client.query(
    `INSERT INTO points_events (system_id, user_id, amount, source_type, source_id, project_id, campaign_id, quest_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (source_type, source_id, user_id, system_id) DO NOTHING
     RETURNING amount`,
    [systemId, userId, amount, sourceType, sourceId,
      scope.project_id || null, scope.campaign_id || null, scope.quest_id || null]
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
      `INSERT INTO notifications (user_id, type, title, body, dedupe_key)
       VALUES ($1, 'badge_earned', $2, $3, $4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [userId, 'Badge unlocked', b.rows[0] ? b.rows[0].name : '', 'badge:' + badgeId + ':' + userId]
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
      'SELECT xp_multiplier, project_id FROM campaigns WHERE id = $1', [quest.campaign_id]);
    const mult = camp.rows[0] ? Number(camp.rows[0].xp_multiplier) : 1;
    const xp = Math.round(quest.xp_reward * mult);
    const scope = {
      project_id: camp.rows[0] ? camp.rows[0].project_id : null,
      campaign_id: quest.campaign_id,
      quest_id: questId,
    };

    await client.query(
      `INSERT INTO quest_completions (quest_id, user_id, project_id, campaign_id, status, xp_awarded)
       VALUES ($1, $2, $3, $4, 'completed', $5)`,
      [questId, userId, scope.project_id, scope.campaign_id, xp]
    );
    const xpRes = await awardXp(client, userId, xp, 'quest', questId, scope);
    // One points row, scoped to the project / campaign / quest. Project and
    // campaign leaderboards are sums over these scope columns.
    const ptsRes = await awardPoints(client, userId, quest.points_reward, 'quest', questId, scope);

    // Quest-level badge reward, configured as quest.badge_reward via rewards
    // rows (kind = badge, quest_id set).
    const badgeRew = await client.query(
      `SELECT r.config->>'badge_id' AS badge_id FROM rewards r
       WHERE r.quest_id = $1 AND r.kind = 'badge' LIMIT 1`, [questId]);
    let badge = false;
    if (badgeRew.rows[0] && badgeRew.rows[0].badge_id) {
      badge = await awardBadge(client, userId, Number(badgeRew.rows[0].badge_id), 'quest', questId);
    }

    // Credential rewards (Phase 2): a rewards row of kind 'credential' issues
    // one credential per completion, whose public id is the UUID page id.
    let credentialId = null;
    const credRew = await client.query(
      `SELECT r.config->>'title' AS title FROM rewards r
       WHERE r.quest_id = $1 AND r.kind = 'credential' LIMIT 1`, [questId]);
    if (credRew.rows[0] && credRew.rows[0].title) {
      const cr = await client.query(
        `INSERT INTO credentials (issuer_project_id, recipient_user_id, title, criteria)
         VALUES ((SELECT project_id FROM campaigns WHERE id = $1), $2, $3, $4)
         RETURNING id`,
        [quest.campaign_id, userId, String(credRew.rows[0].title).slice(0, 255),
          JSON.stringify({ quest_id: questId, quest_title: quest.title })]
      );
      credentialId = cr.rows[0].id;
      await client.query(
        `INSERT INTO notifications (user_id, type, title, body, link, dedupe_key)
         VALUES ($1, 'credential_earned', 'Credential issued', $2, $3, $4)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [userId, `${credRew.rows[0].title} is on your profile.`, '/credentials/' + credentialId,
          'credential:' + credentialId]
      );
    }

    await client.query(
      `INSERT INTO notifications (user_id, type, title, body, dedupe_key)
       VALUES ($1, 'quest_completed', $2, $3, $4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [userId, 'Quest completed', `${quest.title} verified. +${xpRes.awarded} XP.`, 'quest:' + questId + ':' + userId]
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
          `INSERT INTO notifications (user_id, type, title, body, dedupe_key)
           VALUES ($1, 'campaign_completed', $2, $3, $4)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [userId, 'Campaign completed', 'You finished every required quest. Nice work.',
            'campaign:' + quest.campaign_id + ':' + userId]
        );
      }
    }

    // Referral qualification (Phase 2): does this completion push the
    // referee past the invite threshold?
    const referrals = require('./referrals');
    const referral = await referrals.checkQualification(client, userId);

    // Reputation (Phase 3): a transparent per-category record on the
    // profile, written on the same transaction as the reward.
    await reputation.record(client, userId, 'quest_completed', 'quest', questId);

    // Achievements (Phase 3): criteria are evaluated on the same
    // transaction, so an unlock lands exactly when it becomes true.
    const ach = await achievements.evaluate(client, userId);

    // Risk engine (Phase 3): velocity, duplicate-proof and referral-graph
    // heuristics run after the rewards are booked and can escalate the
    // account's risk_state inside this same transaction.
    const riskRes = await risk.evaluateUser(client, userId);

    await client.query('COMMIT');
    return { completed: true, xp: xpRes.awarded, points: ptsRes.awarded, badge, credential_id: credentialId, referral, achievements: ach.unlocked, risk_state: riskRes.state };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Task-level completion: the program's "completion" record and task XP. One
// task cannot pay twice: the idempotency key is UNIQUE on task_completions and
// the same key is stamped on the xp_events row. Task XP is a distinct source
// from quest XP, so a quest still completes and pays its own XP only once
// every task is verified (completeQuest below is unchanged).
//
// Accepted as an options object, or the positional signature from the spec
// (taskId, versionId, userId, walletAddress, chainId, method, evidence,
// completionPeriod, idempotencyKey).
async function completeTask(optsOrId, versionId, userId, walletAddress, chainId, method, evidence, completionPeriod, idempotencyKey, xpReward) {
  const o = (optsOrId && typeof optsOrId === 'object')
    ? optsOrId
    : { taskId: optsOrId, versionId, userId, walletAddress, chainId, method, evidence, completionPeriod, idempotencyKey, xpReward };
  const taskId = o.taskId;

  // Resolve project/campaign scope server-side, never from the caller.
  let scope;
  if (o.task && o.task.project_id) {
    scope = { project_id: o.task.project_id, campaign_id: o.task.campaign_id, quest_id: o.task.quest_id };
  } else {
    const r = await pool.query(
      `SELECT t.quest_id, q.campaign_id, c.project_id
       FROM quest_tasks t JOIN quests q ON q.id = t.quest_id
       JOIN campaigns c ON c.id = q.campaign_id WHERE t.id = $1`, [taskId]);
    if (!r.rows.length) return { completed: false, reason: 'task_not_found' };
    scope = r.rows[0];
  }
  const period = o.completionPeriod || 'once';
  const key = o.idempotencyKey || `user:${o.userId}:task:${taskId}:${period}`;
  const xp = Math.max(0, parseInt(o.xpReward === undefined ? (o.task && o.task.xp_reward) : o.xpReward, 10) || 0);

  const client = await pool.connect();
  let inserted = false;
  let awarded = 0;
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO task_completions
         (task_id, task_version_id, user_id, project_id, campaign_id, quest_id, wallet_address,
          chain_id, method, evidence, completion_period, idempotency_key, xp_awarded, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, 'completed')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [taskId, o.versionId || null, o.userId, scope.project_id || null, scope.campaign_id || null,
        scope.quest_id || null, o.walletAddress || null, o.chainId === undefined ? null : o.chainId,
        o.method || null, o.evidence ? JSON.stringify(o.evidence) : null, period, key]
    );
    if (ins.rows.length) {
      inserted = true;
      // Task XP uses the same key as a second guard and the task scope, so a
      // project/campaign/quest leaderboard counts it once.
      const res = await awardXp(client, o.userId, xp, 'task', taskId, {
        project_id: scope.project_id, campaign_id: scope.campaign_id, quest_id: scope.quest_id,
        idempotency_key: key,
      });
      awarded = res.awarded;
      await client.query('UPDATE task_completions SET xp_awarded = $2 WHERE id = $1', [ins.rows[0].id, awarded]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  if (!inserted) return { completed: false, reason: 'duplicate', xp: 0 };

  // The quest still completes (and pays quest XP) only when every task is
  // verified; completeQuest owns that rule and its own idempotency.
  const quest = await completeQuest(scope.quest_id, o.userId);
  return { completed: true, xp: awarded, completion_id: key, quest };
}

module.exports = { awardXp, awardPoints, awardBadge, completeQuest, completeTask };
