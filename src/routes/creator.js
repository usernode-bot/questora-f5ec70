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
  // Phase 1 has no RPC-backed chain adapter, so an on-chain task can never
  // be published: validation fails with the creator-facing message below
  // rather than accepting a task nobody could verify.
  on_chain: {
    required: [],
    validate: () => 'This on-chain verification method is not currently supported.',
  },
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

// Only the project owner (or a platform admin) may hand out the one ability
// the role model withholds by default, so a project admin cannot
// self-escalate to delete.
function canManageDelete(req, project) {
  return rbac.isAdmin(req) || rbac.isOwner(project, userId(req));
}

// Normalize a per-member permissions payload down to known boolean actions.
function sanitizePermissions(input) {
  if (input === undefined || input === null) return { value: {} };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'Permissions must be an object' };
  const value = {};
  for (const a of rbac.PROJECT_ACTIONS) {
    if (input[a] !== undefined) value[a] = !!input[a];
  }
  return { value };
}

// Scoped leaderboards: metric picks the ledger table, period bounds the
// window. All three scopes are a plain filtered sum, so a project board can
// never include another project's rows.
const METRICS = { xp: 'xp_events', points: 'points_events' };
const SCOPE_COLUMNS = { project: 'project_id', campaign: 'campaign_id', quest: 'quest_id' };

function periodBounds(period, campaign) {
  if (period === 'weekly') return { since: new Date(Date.now() - 7 * 864e5) };
  if (period === 'monthly') return { since: new Date(Date.now() - 30 * 864e5) };
  if (period === 'campaign' && campaign) {
    return { since: campaign.starts_at || null, until: campaign.ends_at || null };
  }
  return {};
}

async function scopedLeaderboard(scope, scopeId, opts) {
  const metric = METRICS[opts.metric] ? opts.metric : 'xp';
  const table = METRICS[metric];
  const col = SCOPE_COLUMNS[scope];
  const bounds = periodBounds(opts.period, opts.campaign);
  const params = [scopeId];
  let where = `e.${col} = $1`;
  if (bounds.since) { params.push(bounds.since); where += ` AND e.created_at >= $${params.length}`; }
  if (bounds.until) { params.push(bounds.until); where += ` AND e.created_at <= $${params.length}`; }
  params.push(opts.limit || 50);
  const { rows } = await pool.query(
    `SELECT u.username, u.display_name, u.avatar_url, SUM(e.amount) AS score
     FROM ${table} e JOIN users u ON u.id = e.user_id
     WHERE ${where}
     GROUP BY u.id ORDER BY score DESC LIMIT $${params.length}`,
    params);
  return rows.map(r => ({ ...r, score: Number(r.score) }));
}

// Quest type is a display taxonomy, derived from its tasks when not set.
async function questTypeLabel(questId, explicit) {
  if (explicit) return explicit;
  const { rows } = await pool.query(
    'SELECT DISTINCT type FROM quest_tasks WHERE quest_id = $1', [questId]);
  return questTypeLabelFromTasks(rows.map(r => ({ type: r.type })));
}

// Pure helper: one task type -> its label, several -> Mixed.
function questTypeLabelFromTasks(tasks) {
  const types = [...new Set((tasks || []).map(t => t.type))];
  if (types.length > 1) return 'Mixed';
  const map = { social: 'Social', quiz: 'Quiz', wallet_connect: 'Wallet', url_proof: 'Submission', manual: 'Submission', on_chain: 'Submission' };
  return map[types[0]] || 'Submission';
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
      `INSERT INTO projects (slug, owner_user_id, name, description, logo_url, website, social_links, visibility, banner_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [slug, owner, String(name).trim(), description || null, logo_url || null, website || null,
        social_links && typeof social_links === 'object' ? social_links : {},
        req.body.visibility === 'unlisted' ? 'unlisted' : 'public', req.body.banner_url || null]
    );
    await client.query(
      'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
      [p.rows[0].id, owner, 'owner']
    );
    // Every project gets its own points system (Phase 2), so its quests
    // feed a project leaderboard as well as the global one.
    await client.query(
      `INSERT INTO points_systems (project_id, key, name) VALUES ($1, 'default', $2)`,
      [p.rows[0].id, String(name).trim().slice(0, 240) + ' points']
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
     FROM projects p
     WHERE p.owner_user_id = $1
        OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1)
     ORDER BY p.created_at DESC`, [userId(req)]);
  res.json({ projects: rows });
});

// Public project directory: every active project, with the counts the
// /projects page shows. Readable without a project role.
router.get('/projects/directory', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.slug, p.name, p.description, p.logo_url, p.website, p.status,
            (SELECT COUNT(*)::int FROM campaigns c WHERE c.project_id = p.id AND c.status = 'active') AS campaign_count,
            (SELECT COUNT(*)::int FROM quests q JOIN campaigns c ON c.id = q.campaign_id
              WHERE c.project_id = p.id AND q.status = 'active') AS quest_count,
            (SELECT COUNT(DISTINCT qc.user_id)::int FROM quest_completions qc
              JOIN quests q ON q.id = qc.quest_id JOIN campaigns c ON c.id = q.campaign_id
              WHERE c.project_id = p.id) AS participants,
            (SELECT COALESCE(SUM(x.amount), 0)::int FROM xp_events x WHERE x.project_id = p.id) AS total_xp
     FROM projects p WHERE p.status = 'active' AND p.deleted_at IS NULL
     ORDER BY total_xp DESC, p.created_at DESC LIMIT 100`);
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

// Project overview payload: the project, its campaigns (each with the quests
// a viewer may see) and whether this viewer can manage it. Readable without a
// project role; the management surface is the dashboard, which is gated.
router.get('/projects/:id', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const uid = userId(req);
  const canManage = rbac.isAdmin(req) || (await rbac.can(p.id, uid, 'manage', req));
  // An archived/soft-deleted project is not publicly reachable: only a
  // manager (or platform admin) can still open it.
  if ((p.status !== 'active' || p.deleted_at) && !canManage) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const campaigns = await pool.query(
    `SELECT c.*,
            (SELECT COUNT(*)::int FROM quests q WHERE q.campaign_id = c.id) AS quest_count,
            (SELECT COUNT(DISTINCT qc.user_id)::int FROM quest_completions qc
              JOIN quests q ON q.id = qc.quest_id WHERE q.campaign_id = c.id) AS participants
     FROM campaigns c
     WHERE c.project_id = $1 AND (c.status <> 'draft' OR $2 = TRUE)
     ORDER BY c.created_at DESC`, [p.id, canManage]);
  const quests = await pool.query(
    `SELECT q.id, q.campaign_id, q.slug, q.title, q.quest_type, q.xp_reward, q.points_reward,
            q.status, q.sort_order, q.starts_at, q.ends_at, q.is_required,
            (SELECT COUNT(DISTINCT qc.user_id)::int FROM quest_completions qc WHERE qc.quest_id = q.id) AS participants
     FROM quests q JOIN campaigns c ON c.id = q.campaign_id
     WHERE c.project_id = $1 AND (q.status = 'active' OR $2 = TRUE)
     ORDER BY q.sort_order`, [p.id, canManage]);
  const byCampaign = {};
  for (const q of quests.rows) (byCampaign[q.campaign_id] = byCampaign[q.campaign_id] || []).push(q);
  res.json({
    project: p,
    can_manage: canManage,
    // Drives the dashboard's danger zone: only a delete_project holder sees it.
    can_delete: rbac.isAdmin(req) || (await rbac.can(p.id, uid, 'delete_project', req)),
    is_owner: rbac.isOwner(p, uid),
    campaigns: campaigns.rows.map(c => ({ ...c, quests: byCampaign[c.id] || [] })),
  });
});

// Project management members. Only a project manager (or platform admin) can
// read or change the roster; a project owner holds the manage role.
router.get('/projects/:id/members', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectAction(req, res, p.id, 'manage'))) return;
  const { rows } = await pool.query(
    `SELECT pm.user_id, pm.role, pm.permissions, u.username, u.display_name, u.avatar_url
     FROM project_members pm JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = $1 ORDER BY pm.role, u.username`, [p.id]);
  res.json({ members: rows });
});

// Add a member by username. The handle is resolved against the local users
// table (a member has to have opened Questora at least once); an unknown
// handle is refused rather than fabricated.
router.post('/projects/:id/members', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectAction(req, res, p.id, 'manage'))) return;
  const username = String((req.body || {}).username || '').trim();
  const role = String((req.body || {}).role || 'editor');
  if (!username) return res.status(400).json({ error: 'A username is required' });
  if (!rbac.PROJECT_ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
  const perms = sanitizePermissions((req.body || {}).permissions);
  if (perms.error) return res.status(400).json({ error: perms.error });
  if (perms.value.delete_project === true && !canManageDelete(req, p)) {
    return res.status(403).json({ error: 'Only the project owner can grant delete permission' });
  }
  const u = await pool.query('SELECT id, username FROM users WHERE lower(username) = lower($1)', [username]);
  if (!u.rows.length) return res.status(404).json({ error: 'No Questora account with that username yet' });
  await pool.query(
    `INSERT INTO project_members (project_id, user_id, role, permissions) VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions`,
    [p.id, u.rows[0].id, role, JSON.stringify(perms.value)]);
  await audit(userId(req), 'project.member.add', 'project', p.id, null, { username, role, permissions: perms.value }, null);
  res.json({ ok: true });
});

router.patch('/projects/:id/members/:userId', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectAction(req, res, p.id, 'manage'))) return;
  const role = String((req.body || {}).role || '');
  if (!rbac.PROJECT_ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
  const perms = sanitizePermissions((req.body || {}).permissions);
  if (perms.error) return res.status(400).json({ error: perms.error });
  if (perms.value.delete_project === true && !canManageDelete(req, p)) {
    return res.status(403).json({ error: 'Only the project owner can grant delete permission' });
  }
  const before = await pool.query('SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2', [p.id, req.params.userId]);
  if (!before.rows.length) return res.status(404).json({ error: 'That user is not a member of this project' });
  if (before.rows[0].role === 'owner' && role !== 'owner') {
    return res.status(400).json({ error: 'The project owner keeps their role.' });
  }
  if (Number(req.params.userId) === p.owner_user_id && perms.value.delete_project === false) {
    return res.status(400).json({ error: 'The project owner always keeps delete permission.' });
  }
  const nextPerms = (req.body || {}).permissions === undefined
    ? (before.rows[0].permissions || {}) : perms.value;
  await pool.query('UPDATE project_members SET role = $3, permissions = $4 WHERE project_id = $1 AND user_id = $2',
    [p.id, req.params.userId, role, JSON.stringify(nextPerms)]);
  await audit(userId(req), 'project.member.update', 'project', p.id, before.rows[0], { role, permissions: nextPerms }, null);
  res.json({ ok: true });
});

router.delete('/projects/:id/members/:userId', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectAction(req, res, p.id, 'manage'))) return;
  const row = await pool.query('SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2', [p.id, req.params.userId]);
  if (!row.rows.length) return res.status(404).json({ error: 'That user is not a member of this project' });
  if (row.rows[0].role === 'owner' || Number(req.params.userId) === p.owner_user_id) {
    return res.status(400).json({ error: 'The project owner cannot be removed.' });
  }
  await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [p.id, req.params.userId]);
  await audit(userId(req), 'project.member.remove', 'project', p.id, row.rows[0], null, null);
  res.json({ ok: true });
});

// Project settings: name, description, branding, links, visibility and
// lifecycle status (publish / unpublish / archive / restore). A platform
// admin passes the same shared guard as everyone else.
router.patch('/projects/:id', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectAction(req, res, p.id, 'edit'))) return;
  const allowed = {};
  if (req.body.name) allowed.name = String(req.body.name).slice(0, 255);
  if (req.body.description !== undefined) allowed.description = req.body.description;
  if (req.body.logo_url !== undefined) allowed.logo_url = req.body.logo_url;
  if (req.body.banner_url !== undefined) allowed.banner_url = req.body.banner_url;
  if (req.body.social_links !== undefined) {
    if (req.body.social_links && typeof req.body.social_links === 'object') allowed.social_links = req.body.social_links;
  }
  if (req.body.website !== undefined) {
    if (req.body.website && !validUrl(req.body.website)) return res.status(400).json({ error: 'The website must start with http or https' });
    allowed.website = req.body.website;
  }
  if (req.body.visibility !== undefined) {
    if (!['public', 'unlisted'].includes(req.body.visibility)) return res.status(400).json({ error: 'Unknown visibility' });
    allowed.visibility = req.body.visibility;
  }
  if (req.body.status !== undefined) {
    if (!['active', 'paused', 'archived'].includes(req.body.status)) return res.status(400).json({ error: 'Unknown status' });
    allowed.status = req.body.status;
    // Restoring an archived project clears its soft-delete mark.
    if (req.body.status === 'active' && p.deleted_at) allowed.deleted_at = null;
  }
  const sets = Object.keys(allowed);
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  const { rows } = await pool.query(
    `UPDATE projects SET ${sets.map((s, i) => `${s} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [p.id, ...sets.map(s => allowed[s])]
  );
  await audit(userId(req), 'project.update', 'project', p.id, p, rows[0], req.body.reason || null);
  res.json({ project: rows[0] });
});

// The counts the two-step delete confirmation shows before anyone commits:
// exactly what a hard delete would take with it.
router.get('/projects/:id/deletion-preview', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectAction(req, res, p.id, 'delete_project'))) return;
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM campaigns c WHERE c.project_id = $1) AS campaigns,
       (SELECT COUNT(*)::int FROM quests q JOIN campaigns c ON c.id = q.campaign_id WHERE c.project_id = $1) AS quests,
       (SELECT COUNT(*)::int FROM quest_tasks t JOIN quests q ON q.id = t.quest_id
          JOIN campaigns c ON c.id = q.campaign_id WHERE c.project_id = $1) AS tasks,
       (SELECT COUNT(*)::int FROM rewards r LEFT JOIN quests q ON q.id = r.quest_id
          LEFT JOIN campaigns c2 ON c2.id = r.campaign_id
          WHERE q.campaign_id IN (SELECT id FROM campaigns WHERE project_id = $1)
             OR c2.project_id = $1) AS rewards,
       (SELECT COUNT(*)::int FROM quest_completions qc JOIN quests q ON q.id = qc.quest_id
          JOIN campaigns c ON c.id = q.campaign_id WHERE c.project_id = $1) AS completions,
       (SELECT COUNT(*)::int FROM xp_events x WHERE x.project_id = $1) AS xp_events,
       (SELECT COUNT(*)::int FROM points_events e WHERE e.project_id = $1) AS points_events`,
    [p.id]);
  res.json({ project: { id: p.id, name: p.name, slug: p.slug, status: p.status, deleted_at: p.deleted_at }, counts: rows[0] });
});

// Two-step destructive delete: soft (archive + deleted_at) by default, so a
// confirm click cannot irreversibly wipe participant history. The permanent
// path needs ?mode=hard and the same delete_project ability. Both are
// audited; a soft delete stays restorable via PATCH status='active'.
router.delete('/projects/:id', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectAction(req, res, p.id, 'delete_project'))) return;
  const mode = req.query.mode === 'hard' ? 'hard' : 'soft';
  if (mode === 'hard') {
    await pool.query('DELETE FROM projects WHERE id = $1', [p.id]);
    await audit(userId(req), 'project.delete', 'project', p.id, p, null, req.body && req.body.reason ? String(req.body.reason) : null);
    return res.json({ deleted: true, mode: 'hard' });
  }
  const { rows } = await pool.query(
    `UPDATE projects SET status = 'archived', deleted_at = NOW() WHERE id = $1 RETURNING *`, [p.id]);
  await audit(userId(req), 'project.archive', 'project', p.id, p, rows[0], (req.body && req.body.reason) || null);
  res.json({ project: rows[0], archived: true, mode: 'soft',
    reason: 'The project was archived. Its participant history is kept and it can be restored.' });
});

// ---- campaigns ----
const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'active', 'paused', 'ended', 'archived'];

// Status transitions are the server's decision, not the client's. A
// campaign moves forward through this map; platform admins may pause or
// archive from anywhere (the admin panel's Pause/Archive buttons).
const CAMPAIGN_TRANSITIONS = {
  draft: ['scheduled', 'active', 'archived'],
  scheduled: ['active', 'draft', 'archived'],
  active: ['paused', 'ended'],
  paused: ['active', 'ended'],
  ended: ['archived'],
  archived: [],
};

const QUEST_STATUSES = ['draft', 'scheduled', 'active', 'paused', 'ended', 'archived'];
// A quest follows the same forward-only lifecycle as its campaign.
const QUEST_TRANSITIONS = {
  draft: ['scheduled', 'active', 'archived'],
  scheduled: ['active', 'draft', 'archived'],
  active: ['paused', 'ended', 'archived'],
  paused: ['active', 'ended', 'archived'],
  ended: ['archived'],
  archived: [],
};

router.post('/projects/:id/campaigns', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectAction(req, res, p.id, 'edit'))) return;
  const { name, description, banner_url, category, chains, starts_at, ends_at, status, featured,
    visibility, rules, leaderboard_config } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'A campaign name is required' });
  // A new campaign starts its life as a draft, a scheduled one, or goes
  // straight live on publish. Everything else is a transition (PATCH).
  const st = ['draft', 'scheduled', 'active'].includes(status) ? status : 'draft';
  let slug = slugify(name) || randomId(8);
  const dup = await pool.query('SELECT 1 FROM campaigns WHERE project_id = $1 AND slug = $2', [p.id, slug]);
  if (dup.rows.length) slug = slug + '-' + randomId(4);
  const { rows } = await pool.query(
    `INSERT INTO campaigns (project_id, slug, name, description, banner_url, category, chains, starts_at,
                            ends_at, status, featured, visibility, rules, leaderboard_config)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [p.id, slug, String(name).trim(), description || null, banner_url || null, category || null,
      Array.isArray(chains) ? chains : [],
      starts_at || null, ends_at || null, st, !!featured,
      visibility === 'unlisted' ? 'unlisted' : 'public', rules || null,
      leaderboard_config && typeof leaderboard_config === 'object' ? leaderboard_config : {}]
  );
  res.json({ campaign: rows[0] });
});

// GET /campaigns/:id lives in misc.js: it is the viewer route (per-user
// completed/locked state, published quests only) and must not be shadowed by
// a creator-shaped duplicate mounted earlier. This router keeps the writes.
router.patch('/campaigns/:id', async (req, res) => {
  const c = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (!c.rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = c.rows[0];
  // Project RBAC, or a platform admin acting through the admin panel.
  if (!(await rbac.requireProjectAction(req, res, campaign.project_id, 'edit'))) return;
  const allowed = {};
  for (const k of ['name', 'description', 'banner_url', 'category', 'starts_at', 'ends_at', 'featured', 'rules']) {
    if (req.body[k] !== undefined) allowed[k] = req.body[k];
  }
  if (req.body.visibility !== undefined) allowed.visibility = req.body.visibility === 'unlisted' ? 'unlisted' : 'public';
  if (req.body.leaderboard_config !== undefined && typeof req.body.leaderboard_config === 'object') {
    allowed.leaderboard_config = req.body.leaderboard_config;
  }
  if (req.body.chains !== undefined) allowed.chains = Array.isArray(req.body.chains) ? req.body.chains : [];
  if (req.body.status !== undefined) {
    if (!CAMPAIGN_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Unknown status' });
    const legal = CAMPAIGN_TRANSITIONS[campaign.status] || [];
    const isPlatformAdmin = rbac.isAdmin(req);
    if (req.body.status !== campaign.status && !legal.includes(req.body.status) && !isPlatformAdmin) {
      return res.status(400).json({
        error: `A ${campaign.status} campaign cannot move to ${req.body.status}.`,
      });
    }
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

// Duplicate a campaign and its quests as a fresh draft. The copy keeps the
// same project, so it can never land in another project's list.
router.post('/campaigns/:id/duplicate', async (req, res) => {
  const c = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (!c.rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = c.rows[0];
  if (!(await rbac.requireProjectAction(req, res, campaign.project_id, 'edit'))) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let slug = slugify(campaign.name + ' copy') || randomId(8);
    const dup = await client.query('SELECT 1 FROM campaigns WHERE project_id = $1 AND slug = $2', [campaign.project_id, slug]);
    if (dup.rows.length) slug = slug + '-' + randomId(4);
    const cp = await client.query(
      `INSERT INTO campaigns (project_id, slug, name, description, banner_url, category, chains, starts_at,
                              ends_at, status, featured, visibility, rules, leaderboard_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', FALSE, $10, $11, $12) RETURNING *`,
      [campaign.project_id, slug, campaign.name + ' (copy)', campaign.description, campaign.banner_url,
        campaign.category, campaign.chains, campaign.starts_at, campaign.ends_at,
        campaign.visibility, campaign.rules, campaign.leaderboard_config]);
    const newId = cp.rows[0].id;
    const quests = await client.query('SELECT * FROM quests WHERE campaign_id = $1 ORDER BY sort_order', [campaign.id]);
    for (const q of quests.rows) {
      let qslug = q.slug ? q.slug + '-copy' : (slugify(q.title) || 'quest') + '-copy';
      const clash = await client.query('SELECT 1 FROM quests WHERE campaign_id = $1 AND slug = $2', [newId, qslug]);
      if (clash.rows.length) qslug = qslug + '-' + randomId(4);
      const nq = await client.query(
        `INSERT INTO quests (campaign_id, slug, title, description, instructions, image_url, quest_type,
                             sort_order, is_required, xp_reward, points_reward, starts_at, ends_at, status,
                             visibility, max_participants, completion_limit, max_completions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft', $14, $15, $16, $17)
         RETURNING id`,
        [newId, qslug, q.title, q.description, q.instructions, q.image_url, q.quest_type,
          q.sort_order, q.is_required, q.xp_reward, q.points_reward, q.starts_at, q.ends_at,
          q.visibility, q.max_participants, q.completion_limit, q.max_completions]);
      const tasks = await client.query('SELECT * FROM quest_tasks WHERE quest_id = $1 ORDER BY sort_order', [q.id]);
      for (const t of tasks.rows) {
        await client.query(
          `INSERT INTO quest_tasks (quest_id, type, title, config, sort_order, verification_type, proof_required)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [nq.rows[0].id, t.type, t.title, JSON.stringify(t.config || {}), t.sort_order, t.verification_type, t.proof_required]);
      }
    }
    await client.query('COMMIT');
    await audit(userId(req), 'campaign.duplicate', 'campaign', newId, null, cp.rows[0], null);
    res.json({ campaign: cp.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not duplicate the campaign' });
  } finally {
    client.release();
  }
});

// Delete a campaign, unless it already produced completions: those are a
// participant's earned history, so the campaign is archived instead.
router.delete('/campaigns/:id', async (req, res) => {
  const c = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (!c.rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = c.rows[0];
  if (!(await rbac.requireProjectAction(req, res, campaign.project_id, 'manage'))) return;
  const done = await pool.query(
    `SELECT COUNT(*)::int AS n FROM quest_completions qc
     JOIN quests q ON q.id = qc.quest_id WHERE q.campaign_id = $1`, [campaign.id]);
  if (done.rows[0].n > 0) {
    const { rows } = await pool.query(
      `UPDATE campaigns SET status = 'archived' WHERE id = $1 RETURNING *`, [campaign.id]);
    await audit(userId(req), 'campaign.archive', 'campaign', campaign.id, campaign, rows[0], req.body.reason || 'Had completions');
    return res.json({ campaign: rows[0], archived: true, reason: 'This campaign has participant completions, so it was archived instead of deleted.' });
  }
  await pool.query('DELETE FROM campaigns WHERE id = $1', [campaign.id]);
  await audit(userId(req), 'campaign.delete', 'campaign', campaign.id, campaign, null, req.body.reason || null);
  res.json({ deleted: true });
});

// ---- quests + tasks (the quest builder API) ----
router.post('/campaigns/:id/quests', async (req, res) => {
  const c = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (!c.rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = c.rows[0];
  if (!(await rbac.requireProjectAction(req, res, campaign.project_id, 'edit'))) return;
  const { title, description, instructions, is_required, xp_reward, points_reward, tasks, badge_id } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'A quest title is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ord = await client.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM quests WHERE campaign_id = $1', [campaign.id]);
    let slug = slugify(title) || randomId(8);
    const slugClash = await client.query('SELECT 1 FROM quests WHERE campaign_id = $1 AND slug = $2', [campaign.id, slug]);
    if (slugClash.rows.length) slug = slug + '-' + randomId(4);
    const st = QUEST_STATUSES.includes(req.body.status) ? req.body.status : 'active';
    const q = await client.query(
      `INSERT INTO quests (campaign_id, slug, title, description, instructions, image_url, quest_type,
                           sort_order, is_required, xp_reward, points_reward, starts_at, ends_at, status,
                           visibility, max_participants, completion_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [campaign.id, slug, String(title).trim(), description || null, instructions || null,
        req.body.image_url || null, req.body.quest_type || null,
        ord.rows[0].n, is_required === undefined ? true : !!is_required,
        Math.max(0, parseInt(xp_reward, 10) || 0), Math.max(0, parseInt(points_reward, 10) || 0),
        req.body.starts_at || null, req.body.ends_at || null, st,
        req.body.visibility === 'unlisted' ? 'unlisted' : 'public',
        req.body.max_participants ? Math.max(1, parseInt(req.body.max_participants, 10) || 1) : null,
        Math.max(1, parseInt(req.body.completion_limit, 10) || 1)]
    );
    const questId = q.rows[0].id;
    if (!q.rows[0].quest_type) {
      await client.query('UPDATE quests SET quest_type = $2 WHERE id = $1', [questId, await questTypeLabelFromTasks(tasks)]);
    }
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
    if (req.body.credential_title && String(req.body.credential_title).trim()) {
      await client.query(
        `INSERT INTO rewards (quest_id, kind, config) VALUES ($1, 'credential', $2)`,
        [questId, JSON.stringify({ title: String(req.body.credential_title).trim().slice(0, 255) })]
      );
    }
    await client.query(`INSERT INTO quest_conditions (quest_id, operator, config) VALUES ($1, 'all', '{}')`, [questId]);
    // Locking (optional): prerequisite quests that must be completed first.
    // Stored as quest_conditions config; the lock is evaluated server-side.
    const prereqs = (req.body.requires_quests || [])
      .map(Number).filter(Number.isFinite);
    if (prereqs.length) {
      const operator = req.body.require_all === false ? 'any' : 'all';
      await client.query(
        `UPDATE quest_conditions SET operator = $2, config = $3 WHERE quest_id = $1`,
        [questId, operator, JSON.stringify({ requires_quests: prereqs })]);
    }
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
  if (!(await rbac.requireProjectAction(req, res, q.rows[0].project_id, 'edit'))) return;
  const allowed = {};
  for (const k of ['title', 'description', 'instructions', 'image_url', 'quest_type', 'starts_at', 'ends_at']) {
    if (req.body[k] !== undefined) allowed[k] = req.body[k];
  }
  if (req.body.is_required !== undefined) allowed.is_required = !!req.body.is_required;
  if (req.body.xp_reward !== undefined) allowed.xp_reward = Math.max(0, parseInt(req.body.xp_reward, 10) || 0);
  if (req.body.points_reward !== undefined) allowed.points_reward = Math.max(0, parseInt(req.body.points_reward, 10) || 0);
  if (req.body.visibility !== undefined) allowed.visibility = req.body.visibility === 'unlisted' ? 'unlisted' : 'public';
  if (req.body.max_participants !== undefined) {
    allowed.max_participants = req.body.max_participants ? Math.max(1, parseInt(req.body.max_participants, 10) || 1) : null;
  }
  if (req.body.completion_limit !== undefined) allowed.completion_limit = Math.max(1, parseInt(req.body.completion_limit, 10) || 1);
  if (req.body.status !== undefined) {
    if (!QUEST_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Unknown status' });
    const legal = QUEST_TRANSITIONS[q.rows[0].status] || [];
    if (req.body.status !== q.rows[0].status && !legal.includes(req.body.status) && !rbac.isAdmin(req)) {
      return res.status(400).json({ error: `A ${q.rows[0].status} quest cannot move to ${req.body.status}.` });
    }
    allowed.status = req.body.status;
  }
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

// Duplicate a quest as a draft at the end of its own campaign.
router.post('/quests/:id/duplicate', async (req, res) => {
  const q = await pool.query(
    `SELECT q.*, c.project_id FROM quests q JOIN campaigns c ON c.id = q.campaign_id WHERE q.id = $1`, [req.params.id]);
  if (!q.rows.length) return res.status(404).json({ error: 'Quest not found' });
  if (!(await rbac.requireProjectAction(req, res, q.rows[0].project_id, 'edit'))) return;
  const quest = q.rows[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let slug = (quest.slug ? quest.slug : (slugify(quest.title) || 'quest')) + '-copy';
    const clash = await client.query('SELECT 1 FROM quests WHERE campaign_id = $1 AND slug = $2', [quest.campaign_id, slug]);
    if (clash.rows.length) slug = slug + '-' + randomId(4);
    const ord = await client.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM quests WHERE campaign_id = $1', [quest.campaign_id]);
    const nq = await client.query(
      `INSERT INTO quests (campaign_id, slug, title, description, instructions, image_url, quest_type,
                           sort_order, is_required, xp_reward, points_reward, starts_at, ends_at, status,
                           visibility, max_participants, completion_limit, max_completions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft', $14, $15, $16, $17)
       RETURNING *`,
      [quest.campaign_id, slug, quest.title + ' (copy)', quest.description, quest.instructions,
        quest.image_url, quest.quest_type, ord.rows[0].n, quest.is_required, quest.xp_reward,
        quest.points_reward, quest.starts_at, quest.ends_at, quest.visibility, quest.max_participants,
        quest.completion_limit, quest.max_completions]);
    const tasks = await client.query('SELECT * FROM quest_tasks WHERE quest_id = $1 ORDER BY sort_order', [quest.id]);
    for (const t of tasks.rows) {
      await client.query(
        `INSERT INTO quest_tasks (quest_id, type, title, config, sort_order, verification_type, proof_required)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [nq.rows[0].id, t.type, t.title, JSON.stringify(t.config || {}), t.sort_order, t.verification_type, t.proof_required]);
    }
    await client.query('COMMIT');
    await audit(userId(req), 'quest.duplicate', 'quest', nq.rows[0].id, null, nq.rows[0], null);
    res.json({ quest: nq.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not duplicate the quest' });
  } finally {
    client.release();
  }
});

// Delete a quest unless it has completions; otherwise archive it.
router.delete('/quests/:id', async (req, res) => {
  const q = await pool.query(
    `SELECT q.*, c.project_id FROM quests q JOIN campaigns c ON c.id = q.campaign_id WHERE q.id = $1`, [req.params.id]);
  if (!q.rows.length) return res.status(404).json({ error: 'Quest not found' });
  const quest = q.rows[0];
  if (!(await rbac.requireProjectAction(req, res, quest.project_id, 'manage'))) return;
  const done = await pool.query('SELECT COUNT(*)::int AS n FROM quest_completions WHERE quest_id = $1', [quest.id]);
  if (done.rows[0].n > 0) {
    const { rows } = await pool.query(`UPDATE quests SET status = 'archived' WHERE id = $1 RETURNING *`, [quest.id]);
    await audit(userId(req), 'quest.archive', 'quest', quest.id, quest, rows[0], req.body.reason || 'Had completions');
    return res.json({ quest: rows[0], archived: true, reason: 'This quest has participant completions, so it was archived instead of deleted.' });
  }
  await pool.query('DELETE FROM quests WHERE id = $1', [quest.id]);
  await audit(userId(req), 'quest.delete', 'quest', quest.id, quest, null, req.body.reason || null);
  res.json({ deleted: true });
});

// Reorder a campaign's quests: the body is the full ordered id list.
router.post('/campaigns/:id/quests/reorder', async (req, res) => {
  const c = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (!c.rows.length) return res.status(404).json({ error: 'Campaign not found' });
  if (!(await rbac.requireProjectAction(req, res, c.rows[0].project_id, 'edit'))) return;
  const order = Array.isArray(req.body.order) ? req.body.order.map(Number).filter(Number.isFinite) : [];
  if (!order.length) return res.status(400).json({ error: 'An ordered list of quest ids is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query(
        'UPDATE quests SET sort_order = $2 WHERE id = $1 AND campaign_id = $3',
        [order[i], i, c.rows[0].id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ---- review queue ----
router.get('/projects/:id/review', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectAction(req, res, p.id, 'review'))) return;
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
  if (!q.rows.length) return res.status(404).json({ error: 'Quest not found' });
  if (!(await rbac.requireProjectAction(req, res, q.rows[0].project_id, 'review'))) return;
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
    // Reputation (Phase 3): rejections are visible on the profile's
    // itemized reputation panel; idempotent per submission.
    const reputation = require('../reputation');
    await reputation.record(pool, sub.user_id, 'quest_rejected', 'submission', sub.id, reason);
  } else {
    const reward = require('../reward');
    await reward.completeQuest(sub.quest_id, sub.user_id);
  }
  await audit(userId(req), 'submission.review', 'submission', sub.id, sub, rows[0], reason || null);
  res.json({ submission: rows[0] });
});

// ---- scoped leaderboards ----
// A board is a filtered sum over one scope column. Project isolation is a
// property of the query: rows tagged with another project can never appear.
// Public within the app: a project page shows its board to anyone who can
// open the project.
router.get('/projects/:id/leaderboard', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const metric = req.query.metric === 'points' ? 'points' : 'xp';
  const period = ['all', 'weekly', 'monthly'].includes(req.query.period) ? req.query.period : 'all';
  const campaignId = Number(req.query.campaign) || null;
  let scopeId = p.id;
  let campaign = null;
  if (campaignId) {
    // A narrowing filter must belong to THIS project, or it would leak
    // another project's ranking through this project's board.
    const c = await pool.query('SELECT * FROM campaigns WHERE id = $1 AND project_id = $2', [campaignId, p.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Campaign not found in this project' });
    scopeId = c.rows[0].id;
  }
  const entries = await scopedLeaderboard(campaignId ? 'campaign' : 'project', scopeId, { metric, period, campaign });
  res.json({ metric, period, scope: campaignId ? 'campaign' : 'project', entries });
});

router.get('/campaigns/:id/leaderboard', async (req, res) => {
  const c = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (!c.rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const metric = req.query.metric === 'points' ? 'points' : 'xp';
  const period = ['all', 'weekly', 'monthly', 'campaign'].includes(req.query.period) ? req.query.period : 'all';
  const entries = await scopedLeaderboard('campaign', c.rows[0].id, { metric, period, campaign: c.rows[0] });
  res.json({ metric, period, scope: 'campaign', entries });
});

router.get('/quests/:id/leaderboard', async (req, res) => {
  const q = await pool.query('SELECT id FROM quests WHERE id = $1', [req.params.id]);
  if (!q.rows.length) return res.status(404).json({ error: 'Quest not found' });
  const metric = req.query.metric === 'points' ? 'points' : 'xp';
  const period = ['all', 'weekly', 'monthly'].includes(req.query.period) ? req.query.period : 'all';
  const entries = await scopedLeaderboard('quest', q.rows[0].id, { metric, period });
  res.json({ metric, period, scope: 'quest', entries });
});

// ---- dashboard overview ----
router.get('/projects/:id/overview', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectAction(req, res, p.id, 'view_analytics'))) return;
  const stats = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM campaigns c WHERE c.project_id = $1 AND c.status = 'active') AS active_campaigns,
       (SELECT COUNT(*)::int FROM campaigns c WHERE c.project_id = $1) AS campaigns,
       (SELECT COUNT(*)::int FROM quests q JOIN campaigns c ON c.id = q.campaign_id WHERE c.project_id = $1) AS quests,
       (SELECT COUNT(*)::int FROM quests q JOIN campaigns c ON c.id = q.campaign_id WHERE c.project_id = $1 AND q.status = 'active') AS active_quests,
       (SELECT COUNT(DISTINCT qc.user_id)::int FROM quest_completions qc
          JOIN quests q ON q.id = qc.quest_id JOIN campaigns c ON c.id = q.campaign_id WHERE c.project_id = $1) AS participants,
       (SELECT COUNT(*)::int FROM quest_completions qc
          JOIN quests q ON q.id = qc.quest_id JOIN campaigns c ON c.id = q.campaign_id WHERE c.project_id = $1) AS completions,
       (SELECT COALESCE(SUM(x.amount), 0)::int FROM xp_events x WHERE x.project_id = $1) AS xp_distributed,
       (SELECT COUNT(*)::int FROM task_submissions s
          JOIN quests q ON q.id = s.quest_id JOIN campaigns c ON c.id = q.campaign_id
          WHERE c.project_id = $1 AND s.status = 'pending') AS pending_review`,
    [p.id]);
  const activity = await pool.query(
    `SELECT qc.completed_at, u.username, q.title, c.name AS campaign_name
     FROM quest_completions qc
     JOIN users u ON u.id = qc.user_id
     JOIN quests q ON q.id = qc.quest_id
     JOIN campaigns c ON c.id = q.campaign_id
     WHERE c.project_id = $1
     ORDER BY qc.completed_at DESC LIMIT 8`, [p.id]);
  res.json({ project: p, stats: stats.rows[0], recent_activity: activity.rows });
});


router.get('/projects/:id/analytics', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectAction(req, res, p.id, 'view_analytics'))) return;
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
// Exposed for tests: the legal campaign state transitions.
router.CAMPAIGN_TRANSITIONS = CAMPAIGN_TRANSITIONS;
module.exports = router;
