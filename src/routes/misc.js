const express = require('express');
const { pool, IS_STAGING } = require('../db');
const levels = require('../levels');

const router = express.Router();
function userId(req) { return req.user.db_id; }

// ---- discovery ----
router.get('/discover', async (req, res) => {
  const base = `
    SELECT c.id, c.slug, c.name, c.description, c.banner_url, c.category, c.status,
           c.starts_at, c.ends_at, c.featured,
           p.name AS project_name, p.slug AS project_slug, p.logo_url AS project_logo,
           (SELECT COUNT(*) FROM quests q WHERE q.campaign_id = c.id) AS quest_count,
           (SELECT COALESCE(SUM(q.xp_reward), 0) FROM quests q WHERE q.campaign_id = c.id) AS total_xp,
           (SELECT COUNT(DISTINCT qc.user_id) FROM quest_completions qc JOIN quests q ON q.id = qc.quest_id WHERE q.campaign_id = c.id) AS participants
    FROM campaigns c JOIN projects p ON p.id = c.project_id
    WHERE c.status = 'live' AND p.status = 'active'`;
  const [featured, trending, fresh, ending, cats] = await Promise.all([
    pool.query(base + ' AND c.featured = TRUE ORDER BY c.created_at DESC LIMIT 6'),
    pool.query(base + ' ORDER BY participants DESC, c.created_at DESC LIMIT 6'),
    pool.query(base + ' ORDER BY c.created_at DESC LIMIT 6'),
    pool.query(base + ' AND c.ends_at IS NOT NULL ORDER BY c.ends_at ASC LIMIT 6'),
    pool.query(`SELECT DISTINCT category FROM campaigns WHERE status = 'live' AND category IS NOT NULL ORDER BY category`),
  ]);
  const card = r => ({
    id: r.id, slug: r.slug, name: r.name, description: r.description,
    banner_url: r.banner_url, category: r.category, project_name: r.project_name,
    project_slug: r.project_slug, project_logo: r.project_logo,
    quest_count: Number(r.quest_count), total_xp: Number(r.total_xp),
    participants: Number(r.participants), ends_at: r.ends_at,
  });
  const pick = rows => rows.rows.map(card);
  res.json({
    featured: pick(featured), trending: pick(trending), fresh: pick(fresh), ending: pick(ending),
    categories: cats.rows.map(r => r.category),
  });
});

// ---- users / profile ----
router.get('/users/me', async (req, res) => {
  const u = await pool.query('SELECT * FROM users WHERE usernode_id = $1', [req.user.id]);
  if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
  const me = u.rows[0];
  const lvl = await levels.userLevel(me.id);
  const pts = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS p FROM points_events pe
     JOIN points_systems ps ON ps.id = pe.system_id WHERE pe.user_id = $1 AND ps.key = 'global'`, [me.id]);
  const settings = await pool.query('SELECT * FROM user_settings WHERE user_id = $1', [me.id]);
  res.json({
    user: { ...me, xp: lvl.xp, level: lvl.level, next: lvl.next, points: Number(pts.rows[0].p) },
    settings: settings.rows[0] || null,
  });
});

router.patch('/users/me', async (req, res) => {
  const u = await pool.query('SELECT * FROM users WHERE usernode_id = $1', [req.user.id]);
  if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
  const allowed = {};
  if (req.body.display_name !== undefined) allowed.display_name = String(req.body.display_name).slice(0, 255);
  if (req.body.avatar_url !== undefined) allowed.avatar_url = req.body.avatar_url;
  const sets = Object.keys(allowed);
  if (sets.length) {
    await pool.query(`UPDATE users SET ${sets.map((s, i) => `${s} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [u.rows[0].id, ...sets.map(s => allowed[s])]);
  }
  if (req.body.settings) {
    await pool.query(
      `INSERT INTO user_settings (user_id, notify, theme) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET notify = $2, theme = $3, updated_at = NOW()`,
      [u.rows[0].id, JSON.stringify(req.body.settings.notify || {}), req.body.settings.theme || 'dark']);
  }
  const me = await pool.query('SELECT * FROM users WHERE id = $1', [u.rows[0].id]);
  res.json({ user: me.rows[0] });
});

router.get('/users/:username', async (req, res) => {
  const u = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [req.params.username]);
  if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
  const user = u.rows[0];
  const lvl = await levels.userLevel(user.id);
  const [pts, badges, completed, activity, rank] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(pe.amount), 0) AS p FROM points_events pe JOIN points_systems ps ON ps.id = pe.system_id WHERE pe.user_id = $1 AND ps.key = 'global'`, [user.id]),
    pool.query(`SELECT b.id, b.name, b.icon, b.rarity, b.description, ub.awarded_at FROM user_badges ub JOIN badges b ON b.id = ub.badge_id WHERE ub.user_id = $1 ORDER BY ub.awarded_at DESC`, [user.id]),
    pool.query(`SELECT COUNT(*)::int AS n FROM quest_completions WHERE user_id = $1`, [user.id]),
    pool.query(`SELECT qc.completed_at, q.id AS quest_id, q.title, q.xp_reward, c.name AS campaign_name, c.slug AS campaign_slug
                FROM quest_completions qc JOIN quests q ON q.id = qc.quest_id JOIN campaigns c ON c.id = q.campaign_id
                WHERE qc.user_id = $1 ORDER BY qc.completed_at DESC LIMIT 20`, [user.id]),
    pool.query(`WITH totals AS (
      SELECT user_id, SUM(amount) AS xp FROM xp_events GROUP BY user_id
    ) SELECT COUNT(*)::int + 1 AS r FROM totals WHERE xp > $1`, [lvl.xp]),
  ]);
  res.json({
    user: {
      username: user.username, display_name: user.display_name, avatar_url: user.avatar_url,
      role: user.role, created_at: user.created_at,
      xp: lvl.xp, level: lvl.level, next: lvl.next, points: Number(pts.rows[0].p),
    },
    badges: badges.rows,
    completed_quests: completed.rows[0].n,
    activity: activity.rows,
    leaderboard_rank: rank.rows[0].r,
  });
});

// ---- leaderboard ----
router.get('/leaderboard', async (req, res) => {
  const by = req.query.by === 'points' ? 'points' : 'xp';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  if (by === 'points') {
    const { rows } = await pool.query(
      `SELECT u.username, u.display_name, u.avatar_url,
              SUM(pe.amount) AS score
       FROM points_events pe JOIN users u ON u.id = pe.user_id
       JOIN points_systems ps ON ps.id = pe.system_id
       WHERE ps.key = 'global'
       GROUP BY u.id ORDER BY score DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    return res.json({ by, entries: rows.map(r => ({ ...r, score: Number(r.score) })) });
  }
  const { rows } = await pool.query(
    `SELECT u.username, u.display_name, u.avatar_url, SUM(x.amount) AS score
     FROM xp_events x JOIN users u ON u.id = x.user_id
     GROUP BY u.id ORDER BY score DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  res.json({ by, entries: rows.map(r => ({ ...r, score: Number(r.score) })) });
});

// ---- notifications ----
router.get('/notifications', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30', [userId(req)]);
  const unread = await pool.query(
    'SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId(req)]);
  res.json({ notifications: rows, unread: unread.rows[0].n });
});

router.post('/notifications/read', async (req, res) => {
  await pool.query('UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL', [userId(req)]);
  res.json({ ok: true });
});

router.get('/notifications/prefs', async (req, res) => {
  const s = await pool.query('SELECT notify FROM user_settings WHERE user_id = $1', [userId(req)]);
  res.json({ prefs: (s.rows[0] && s.rows[0].notify) || {} });
});

router.patch('/notifications/prefs', async (req, res) => {
  const prefs = req.body && typeof req.body === 'object' ? req.body : {};
  await pool.query(
    `INSERT INTO user_settings (user_id, notify) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET notify = user_settings.notify || $2, updated_at = NOW()`,
    [userId(req), JSON.stringify(prefs)]);
  res.json({ ok: true });
});

// ---- campaign detail (public-in-app view used by SPA) ----
router.get('/campaigns/:id', async (req, res) => {
  const isNum = !isNaN(Number(req.params.id));
  const { rows } = await pool.query(
    `SELECT c.*, p.name AS project_name, p.slug AS project_slug, p.logo_url AS project_logo,
            (SELECT COUNT(DISTINCT qc.user_id) FROM quest_completions qc JOIN quests q ON q.id = qc.quest_id WHERE q.campaign_id = c.id) AS participants
     FROM campaigns c JOIN projects p ON p.id = c.project_id
     WHERE ${isNum ? 'c.id = $1' : 'c.slug = $1'} ORDER BY ${isNum ? 'c.id' : 'p.id'} LIMIT 1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = rows[0];
  const [quests, totals] = await Promise.all([
    pool.query(`SELECT id, title, description, sort_order, is_required, xp_reward, points_reward FROM quests WHERE campaign_id = $1 AND status = 'published' ORDER BY sort_order`, [campaign.id]),
    pool.query(`SELECT COALESCE(SUM(xp_reward),0) AS xp, COALESCE(SUM(points_reward),0) AS points FROM quests WHERE campaign_id = $1`, [campaign.id]),
  ]);
  res.json({
    campaign,
    quests: quests.rows,
    total_xp: Number(totals.rows[0].xp),
    total_points: Number(totals.rows[0].points),
  });
});

router.get('/quests/:id', async (req, res) => {
  const q = await pool.query(
    `SELECT q.*, c.name AS campaign_name, c.slug AS campaign_slug, c.id AS campaign_id,
            c.status AS campaign_status, c.ends_at AS campaign_ends_at,
            p.name AS project_name, p.slug AS project_slug, p.logo_url AS project_logo
     FROM quests q JOIN campaigns c ON c.id = q.campaign_id JOIN projects p ON p.id = c.project_id
     WHERE q.id = $1`, [req.params.id]);
  if (!q.rows.length) return res.status(404).json({ error: 'Quest not found' });
  const quest = q.rows[0];
  const tasks = await pool.query(
    `SELECT id, type, title, sort_order, verification_type, proof_required, config
     FROM quest_tasks WHERE quest_id = $1 ORDER BY sort_order`, [quest.id]);
  const safeTasks = tasks.rows.map(t => {
    if (t.type === 'quiz') {
      return { ...t, config: { ...(t.config || {}), questions: ((t.config || {}).questions || []).map(x => ({ q: x.q, options: x.options })) } };
    }
    return t;
  });
  const participants = await pool.query('SELECT COUNT(*)::int AS n FROM quest_completions WHERE quest_id = $1', [quest.id]);
  res.json({ quest, tasks: safeTasks, participants: participants.rows[0].n });
});

// ---- badges for the create wizard ----
router.get('/badges', async (_req, res) => {
  const { rows } = await pool.query('SELECT id, name, project_id, rarity FROM badges ORDER BY name');
  res.json({ badges: rows });
});

// ---- admin ----
async function requireAdmin(req, res) {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

router.get('/admin/users', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.role, u.risk_state, u.created_at,
            COALESCE(SUM(x.amount), 0) AS xp
     FROM users u LEFT JOIN xp_events x ON x.user_id = u.id
     GROUP BY u.id ORDER BY u.created_at DESC LIMIT 100`);
  res.json({ users: rows.map(r => ({ ...r, xp: Number(r.xp) })) });
});

router.patch('/admin/users/:id', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const u = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
  const allowed = {};
  if (req.body.role && ['user', 'admin'].includes(req.body.role)) allowed.role = req.body.role;
  if (req.body.risk_state && ['normal', 'review', 'suspicious', 'blocked'].includes(req.body.risk_state)) allowed.risk_state = req.body.risk_state;
  const sets = Object.keys(allowed);
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.map((s, i) => `${s} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [u.rows[0].id, ...sets.map(s => allowed[s])]);
  const { audit } = require('../audit');
  await audit(userId(req), 'user.update', 'user', u.rows[0].id, u.rows[0], rows[0], req.body.reason || null);
  res.json({ user: rows[0] });
});

router.get('/admin/projects', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { rows } = await pool.query(
    `SELECT p.*, u.username AS owner_username FROM projects p JOIN users u ON u.id = p.owner_user_id ORDER BY p.created_at DESC`);
  res.json({ projects: rows });
});

router.get('/admin/campaigns', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { rows } = await pool.query(
    `SELECT c.*, p.name AS project_name FROM campaigns c JOIN projects p ON p.id = c.project_id ORDER BY c.created_at DESC`);
  res.json({ campaigns: rows });
});

router.get('/admin/review', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { rows } = await pool.query(
    `SELECT s.*, t.title AS task_title, q.title AS quest_title, u.username
     FROM task_submissions s JOIN quest_tasks t ON t.id = s.task_id
     JOIN quests q ON q.id = s.quest_id JOIN users u ON u.id = s.user_id
     WHERE s.status = 'pending' ORDER BY s.created_at`);
  res.json({ submissions: rows });
});

router.get('/admin/settings', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const [thr, xp] = await Promise.all([
    pool.query('SELECT level, min_xp FROM level_thresholds ORDER BY level'),
    pool.query("SELECT value FROM platform_settings WHERE key = 'xp'"),
  ]);
  res.json({ thresholds: thr.rows, xp: (xp.rows[0] && xp.rows[0].value) || {} });
});

router.patch('/admin/settings', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const before = await pool.query('SELECT level, min_xp FROM level_thresholds ORDER BY level');
  if (Array.isArray(req.body.thresholds)) {
    for (const t of req.body.thresholds) {
      const lvl = parseInt(t.level, 10);
      const min = parseInt(t.min_xp, 10);
      if (!(lvl >= 1) || !(min >= 0)) return res.status(400).json({ error: 'Levels and XP must be positive numbers' });
    }
    for (const t of req.body.thresholds) {
      await pool.query(
        `INSERT INTO level_thresholds (level, min_xp) VALUES ($1, $2)
         ON CONFLICT (level) DO UPDATE SET min_xp = $2`, [parseInt(t.level, 10), parseInt(t.min_xp, 10)]);
    }
  }
  if (req.body.xp && typeof req.body.xp === 'object') {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('xp', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`, [JSON.stringify(req.body.xp)]);
  }
  const after = await pool.query('SELECT level, min_xp FROM level_thresholds ORDER BY level');
  const { audit } = require('../audit');
  await audit(userId(req), 'settings.update', 'platform', 0, before.rows, after.rows, req.body.reason || null);
  res.json({ thresholds: after.rows });
});

router.get('/admin/audit', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { rows } = await pool.query(
    `SELECT a.*, u.username AS actor FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     ORDER BY a.created_at DESC LIMIT 100`);
  res.json({ entries: rows });
});

module.exports = router;
