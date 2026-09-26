const express = require('express');
const { pool } = require('../db');
const rbac = require('../rbac');
const { audit } = require('../audit');
const { slugify, randomId, validUrl } = require('../util');

const router = express.Router();

const TASK_SCHEMAS = {
  wallet_connect: { required: [], optional: [] },
  social: {
    required: ['url'],
    validate: (c) => {
      if (!validUrl(c.url)) return 'The target link must start with http or https';
      if (!['visit', 'join', 'follow'].includes(c.action || 'visit')) return 'Unknown social action';
      return null;
    },
  },
  url_proof: {
    required: ['placeholder'],
    validate: () => null,
  },
  quiz: {
    required: ['questions'],
    validate: (c) => {
      const qs = c.questions;
      if (!Array.isArray(qs) || qs.length < 1) return 'At least one question is required';
      for (const q of qs) {
        if (!q.q || !Array.isArray(q.options) || q.options.length < 2) return 'Each question needs text and at least two options';
        if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) return 'Each question needs a correct answer';
      }
      if (c.pass_score !== undefined && (typeof c.pass_score !== 'number' || c.pass_score < 1 || c.pass_score > 100)) return 'Pass score must be between 1 and 100';
      return null;
    },
  },
  manual: { required: [], optional: [] },
};

function validateTaskConfig(type, config) {
  const schema = TASK_SCHEMAS[type];
  if (!schema) return `Unknown task type: ${type}`;
  for (const k of schema.required || []) {
    if (config[k] === undefined || config[k] === null || config[k] === '') return `Missing "${k}"`;
  }
  return schema.validate ? schema.validate(config) : null;
}

function userId(req) {
  return req.user ? req.user.db_id : null;
}

// ---- projects ----
router.post('/projects', async (req, res) => {
  const { name, description, logo_url, website, social_links } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'A project name is required' });
  if (website && !validUrl(website)) return res.status(400).json({ error: 'The website must start with http or https' });
  const owner = userId(req);
  let slug = slugify(name) || randomId(8);
  const exists = await pool.query('SELECT 1 FROM projects WHERE slug = $1', [slug]);
  if (exists.rows.length) slug = slug + '-' + randomId(4);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query(
      `INSERT INTO projects (slug, owner_user_id, name, description, logo_url, website, social_links)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [slug, owner, String(name).trim(), description || null, logo_url || null, website || null,
        social_links && typeof social_links === 'object' ? social_links : {}]
    );
    await client.query(
      'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
      [p.rows[0].id, owner, 'owner']
    );
    await client.query('COMMIT');
    res.json({ project: p.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not create the project' });
  } finally {
    client.release();
  }
});

router.get('/projects', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS members
     FROM projects p WHERE p.owner_user_id = $1 ORDER BY p.created_at DESC`, [userId(req)]);
  res.json({ projects: rows });
});

async function loadProject(idOrSlug) {
  if (!isNaN(Number(idOrSlug))) {
    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [Number(idOrSlug)]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await pool.query('SELECT * FROM projects WHERE slug = $1', [idOrSlug]);
  return rows[0] || null;
}

router.get('/projects/:id', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const campaigns = await pool.query(
    `SELECT c.*, (SELECT COUNT(*) FROM quests q WHERE q.campaign_id = c.id) AS quest_count
     FROM campaigns c WHERE c.project_id = $1 ORDER BY c.created_at DESC`, [p.id]);
  res.json({ project: p, campaigns: campaigns.rows });
});

// Owner/project-admin updates: status + role edits are audited.
router.patch('/projects/:id', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.can(p.id, userId(req), 'manage'))) {
    return res.status(403).json({ error: 'You do not have permission to edit this project' });
  }
  const allowed = {};
  if (req.body.name) allowed.name = String(req.body.name).slice(0, 255);
  if (req.body.description !== undefined) allowed.description = req.body.description;
  if (req.body.logo_url !== undefined) allowed.logo_url = req.body.logo_url;
  if (req.body.website !== undefined) {
    if (req.body.website && !validUrl(req.body.website)) return res.status(400).json({ error: 'The website must start with http or https' });
    allowed.website = req.body.website;
  }
  if (req.body.status && ['active', 'paused', 'archived'].includes(req.body.status)) allowed.status = req.body.status;
  const sets = Object.keys(allowed);
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  const { rows } = await pool.query(
    `UPDATE projects SET ${sets.map((s, i) => `${s} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [p.id, ...sets.map(s => allowed[s])]
  );
  await audit(userId(req), 'project.update', 'project', p.id, p, rows[0], req.body.reason || null);
  res.json({ project: rows[0] });
});

// ---- campaigns ----
const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'live', 'paused', 'ended', 'archived'];

router.post('/projects/:id/campaigns', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.can(p.id, userId(req), 'edit'))) {
    return res.status(403).json({ error: 'You do not have permission to create campaigns here' });
  }
  const { name, description, banner_url, category, chains, starts_at, ends_at, status, featured } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'A campaign name is required' });
  const st = status && CAMPAIGN_STATUSES.includes(status) ? status : 'draft';
  let slug = slugify(name) || randomId(8);
  const dup = await pool.query('SELECT 1 FROM campaigns WHERE project_id = $1 AND slug = $2', [p.id, slug]);
  if (dup.rows.length) slug = slug + '-' + randomId(4);
  const { rows } = await pool.query(
    `INSERT INTO campaigns (project_id, slug, name, description, banner_url, category, chains, starts_at, ends_at, status, featured)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [p.id, slug, String(name).trim(), description || null, banner_url || null, category || null,
      Array.isArray(chains) ? chains : [],
      starts_at || null, ends_at || null, st, !!featured]
  );
  res.json({ campaign: rows[0] });
});

router.get('/campaigns/:id', async (req, res) => {
  const isNum = !isNaN(Number(req.params.id));
  const { rows } = await pool.query(
    `SELECT c.*, p.name AS project_name, p.slug AS project_slug, p.logo_url AS project_logo
     FROM campaigns c JOIN projects p ON p.id = c.project_id
     WHERE ${isNum ? 'c.id = $1' : '(c.slug = $1 AND c.id = (SELECT MIN(c2.id) FROM campaigns c2 WHERE c2.slug = $1))'} LIMIT 1`,
    [isNum ? Number(req.params.id) : req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = rows[0];
  const quests = await pool.query(
    `SELECT q.*, (SELECT COUNT(*) FROM quest_tasks t WHERE t.quest_id = q.id) AS task_count
     FROM quests q WHERE q.campaign_id = $1 ORDER BY q.sort_order`, [campaign.id]);
  const parts = await pool.query(
    `SELECT COUNT(DISTINCT user_id)::int AS n FROM quest_completions qc
     JOIN quests q ON q.id = qc.quest_id WHERE q.campaign_id = $1`, [campaign.id]);
  const totals = await pool.query(
    `SELECT COALESCE(SUM(xp_reward), 0) AS xp, COALESCE(SUM(points_reward), 0) AS points
     FROM quests WHERE campaign_id = $1`, [campaign.id]);
  res.json({
    campaign,
    quests: quests.rows,
    participants: parts.rows[0].n,
    total_xp: Number(totals.rows[0].xp),
    total_points: Number(totals.rows[0].points),
  });
});

router.patch('/campaigns/:id', async (req, res) => {
  const c = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (!c.rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = c.rows[0];
  if (!(await rbac.can(campaign.project_id, userId(req), 'edit'))) {
    return res.status(403).json({ error: 'You do not have permission to edit this campaign' });
  }
  const allowed = {};
  for (const k of ['name', 'description', 'banner_url', 'category', 'starts_at', 'ends_at', 'featured']) {
    if (req.body[k] !== undefined) allowed[k] = req.body[k];
  }
  if (req.body.chains !== undefined) allowed.chains = Array.isArray(req.body.chains) ? req.body.chains : [];
  if (req.body.status !== undefined) {
    if (!CAMPAIGN_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Unknown status' });
    allowed.status = req.body.status;
  }
  if (req.body.xp_multiplier !== undefined) {
    const m = Number(req.body.xp_multiplier);
    if (!(m >= 0.1 && m <= 10)) return res.status(400).json({ error: 'XP multiplier must be between 0.1 and 10' });
    allowed.xp_multiplier = m;
  }
  const sets = Object.keys(allowed);
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  const { rows } = await pool.query(
    `UPDATE campaigns SET ${sets.map((s, i) => `${s} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [campaign.id, ...sets.map(s => allowed[s])]
  );
  await audit(userId(req), 'campaign.update', 'campaign', campaign.id, campaign, rows[0], req.body.reason || null);
  res.json({ campaign: rows[0] });
});

// ---- quests + tasks (the quest builder API) ----
router.post('/campaigns/:id/quests', async (req, res) => {
  const c = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (!c.rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = c.rows[0];
  if (!(await rbac.can(campaign.project_id, userId(req), 'edit'))) {
    return res.status(403).json({ error: 'You do not have permission to add quests here' });
  }
  const { title, description, instructions, is_required, xp_reward, points_reward, tasks, badge_id } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'A quest title is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ord = await client.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM quests WHERE campaign_id = $1', [campaign.id]);
    const q = await client.query(
      `INSERT INTO quests (campaign_id, title, description, instructions, sort_order, is_required, xp_reward, points_reward)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [campaign.id, String(title).trim(), description || null, instructions || null,
        ord.rows[0].n, is_required === undefined ? true : !!is_required,
        Math.max(0, parseInt(xp_reward, 10) || 0), Math.max(0, parseInt(points_reward, 10) || 0)]
    );
    const questId = q.rows[0].id;
    for (let i = 0; i < (tasks || []).length; i++) {
      const t = tasks[i];
      const cfgErr = validateTaskConfig(t.type, t.config || {});
      if (cfgErr) { await client.query('ROLLBACK'); return res.status(400).json({ error: cfgErr }); }
      const verification = t.type === 'quiz' ? 'automatic' : t.type === 'wallet_connect' ? 'automatic' : 'manual';
      await client.query(
        `INSERT INTO quest_tasks (quest_id, type, title, config, sort_order, verification_type, proof_required)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [questId, t.type, t.title || 'Task', JSON.stringify(t.config || {}), i, verification,
          ['url_proof', 'manual', 'social'].includes(t.type)]
      );
    }
    if (!tasks || !tasks.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A quest needs at least one task' }); }
    if (badge_id) {
      await client.query(
        `INSERT INTO rewards (quest_id, kind, config) VALUES ($1, 'badge', $2)`,
        [questId, JSON.stringify({ badge_id: Number(badge_id) })]
      );
    }
    await client.query(`INSERT INTO quest_conditions (quest_id, operator, config) VALUES ($1, 'all', '{}')`, [questId]);
    await client.query('COMMIT');
    res.json({ quest: q.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not create the quest' });
  } finally {
    client.release();
  }
});

router.patch('/quests/:id', async (req, res) => {
  const q = await pool.query(
    `SELECT q.*, c.project_id FROM quests q JOIN campaigns c ON c.id = q.campaign_id WHERE q.id = $1`, [req.params.id]);
  if (!q.rows.length) return res.status(404).json({ error: 'Quest not found' });
  if (!(await rbac.can(q.rows[0].project_id, userId(req), 'edit'))) {
    return res.status(403).json({ error: 'You do not have permission to edit this quest' });
  }
  const allowed = {};
  for (const k of ['title', 'description', 'instructions']) {
    if (req.body[k] !== undefined) allowed[k] = req.body[k];
  }
  if (req.body.is_required !== undefined) allowed.is_required = !!req.body.is_required;
  if (req.body.xp_reward !== undefined) allowed.xp_reward = Math.max(0, parseInt(req.body.xp_reward, 10) || 0);
  if (req.body.points_reward !== undefined) allowed.points_reward = Math.max(0, parseInt(req.body.points_reward, 10) || 0);
  if (req.body.status && ['draft', 'published', 'paused'].includes(req.body.status)) allowed.status = req.body.status;
  if (req.body.sort_order !== undefined) allowed.sort_order = parseInt(req.body.sort_order, 10) || 0;
  const sets = Object.keys(allowed);
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  const { rows } = await pool.query(
    `UPDATE quests SET ${sets.map((s, i) => `${s} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [q.rows[0].id, ...sets.map(s => allowed[s])]
  );
  await audit(userId(req), 'quest.update', 'quest', q.rows[0].id, q.rows[0], rows[0], req.body.reason || null);
  res.json({ quest: rows[0] });
});

// ---- review queue ----
router.get('/projects/:id/review', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.can(p.id, userId(req), 'review'))) {
    return res.status(403).json({ error: 'Reviewer access required' });
  }
  const { rows } = await pool.query(
    `SELECT s.*, t.title AS task_title, t.type AS task_type, q.title AS quest_title,
            u.username
     FROM task_submissions s
     JOIN quest_tasks t ON t.id = s.task_id
     JOIN quests q ON q.id = s.quest_id
     JOIN users u ON u.id = s.user_id
     WHERE q.campaign_id IN (SELECT id FROM campaigns WHERE project_id = $1) AND s.status = 'pending'
     ORDER BY s.created_at`, [p.id]);
  res.json({ submissions: rows });
});

router.post('/submissions/:id/review', async (req, res) => {
  const s = await pool.query('SELECT * FROM task_submissions WHERE id = $1', [req.params.id]);
  if (!s.rows.length) return res.status(404).json({ error: 'Submission not found' });
  const sub = s.rows[0];
  const q = await pool.query(
    `SELECT c.project_id FROM quests q JOIN campaigns c ON c.id = q.campaign_id WHERE q.id = $1`, [sub.quest_id]);
  if (!q.rows.length || !(await rbac.can(q.rows[0].project_id, userId(req), 'review'))) {
    return res.status(403).json({ error: 'Reviewer access required' });
  }
  const { decision, reason } = req.body || {};
  if (!['verified', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Decision must be verified or rejected' });
  if (decision === 'rejected' && !String(reason || '').trim()) {
    return res.status(400).json({ error: 'A reason is required when rejecting' });
  }
  const { rows } = await pool.query(
    `UPDATE task_submissions SET status = $2, reviewer_id = $3, review_note = $4, reviewed_at = NOW()
     WHERE id = $1 RETURNING *`,
    [sub.id, decision, userId(req), decision === 'rejected' ? String(reason).trim() : null]
  );
  await pool.query(
    `INSERT INTO verification_events (submission_id, verifier, result, detail)
     VALUES ($1, 'manual', $2, $3)`,
    [sub.id, decision, JSON.stringify({ reviewer: req.user.username, reason: reason || null })]
  );
  if (decision === 'rejected') {
    const quest = await pool.query('SELECT title FROM quests WHERE id = $1', [sub.quest_id]);
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, link)
       VALUES ($1, 'submission_rejected', $2, $3, $4)`,
      [sub.user_id, 'Submission rejected',
        quest.rows[0] ? `Your submission for "${quest.rows[0].title}" was rejected. ${reason}` : 'Your submission was rejected.',
        '/quest/' + sub.quest_id]
    );
  } else {
    const reward = require('../reward');
    await reward.completeQuest(sub.quest_id, sub.user_id);
  }
  await audit(userId(req), 'submission.review', 'submission', sub.id, sub, rows[0], reason || null);
  res.json({ submission: rows[0] });
});

// ---- project analytics (creator view) ----
router.get('/projects/:id/analytics', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.can(p.id, userId(req), 'view_analytics'))) {
    return res.status(403).json({ error: 'Analyst access required' });
  }
  const perQuest = await pool.query(
    `SELECT q.id, q.title, q.xp_reward,
            (SELECT COUNT(*)::int FROM quest_completions qc WHERE qc.quest_id = q.id) AS completions,
            (SELECT COUNT(*)::int FROM task_submissions s WHERE s.quest_id = q.id) AS submissions
     FROM quests q JOIN campaigns c ON c.id = q.campaign_id
     WHERE c.project_id = $1 ORDER BY q.id`, [p.id]);
  const xp = await pool.query(
    `SELECT COALESCE(SUM(x.amount), 0) AS total FROM xp_events x
     WHERE x.source_type = 'quest' AND x.source_id IN
       (SELECT q.id FROM quests q JOIN campaigns c ON c.id = q.campaign_id WHERE c.project_id = $1)`, [p.id]);
  const participants = await pool.query(
    `SELECT COUNT(DISTINCT qc.user_id)::int AS n FROM quest_completions qc
     JOIN quests q ON q.id = qc.quest_id JOIN campaigns c ON c.id = q.campaign_id WHERE c.project_id = $1`, [p.id]);
  res.json({
    quests: perQuest.rows,
    xp_distributed: Number(xp.rows[0].total),
    participants: participants.rows[0].n,
  });
});

router.validateTaskConfig = validateTaskConfig;
module.exports = router;
