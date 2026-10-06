const express = require('express');
const { pool } = require('../db');
const rbac = require('../rbac');
const { audit } = require('../audit');
const { slugify, randomId, validUrl } = require('../util');
const amount = require('../verify/amount');
const { maskUrl } = require('../verify/evm/rpc-pool');
const { adapterFor } = require('../verify/chain-adapter');
const networkPresets = require('../network-presets');

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
    // A proof submission has no builder-side configuration: the participant
    // supplies the URL. The optional placeholder is only hint text for the
    // submission input (seeded tasks set one), so it must never be required.
    required: [],
    optional: ['placeholder'],
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
  // Simple Mode on-chain task (Slice 1). The static shape is validated here so
  // the publish path can reject a task nobody could verify; connectivity and
  // the chain-id match are checked asynchronously (validateOnChainAsync) by
  // the publish route, which is where a real RPC is available.
  on_chain: {
    required: ['network_id', 'method'],
    validate: (c) => {
      if (!['native_balance', 'erc20_balance', 'transaction'].includes(c.method)) {
        return 'Choose a supported verification method';
      }
      if (!Number.isFinite(Number(c.network_id))) return 'Choose a network for this task';
      const req = c.requirement;
      if (req !== undefined && req !== null) {
        if (typeof req !== 'object') return 'The requirement must be an amount and a comparison';
        if (!amount.normalizeOperator(req.operator)) return 'Unknown comparison operator';
        if (req.amount !== undefined && req.amount !== '' && !/^\d+(\.\d+)?$/.test(String(req.amount))) {
          return 'The required amount must be a positive number';
        }
      }
      const wantsToken = c.method === 'erc20_balance' || (c.method === 'transaction' && c.token_id);
      if (wantsToken) {
        const inline = c.token && Number.isInteger(c.token.decimals);
        if (!c.token_id && !inline) {
          return 'Choose a token (with decimals) for a token balance task';
        }
      }
      if (c.method === 'transaction' && c.confirmations !== undefined) {
        const n = Number(c.confirmations);
        if (!Number.isInteger(n) || n < 1) return 'Confirmations must be a whole number of at least 1';
      }
      return null;
    },
  },
};

// Async part of on-chain validation: the network must belong to the project and
// have at least one RPC whose reported chain id matches the configured one.
// Returns a creator-facing message or null.
async function validateOnChainAsync(projectId, config) {
  const n = await pool.query(
    `SELECT id, chain_namespace, chain_id, name FROM task_networks WHERE id = $1 AND project_id = $2`,
    [config.network_id, projectId]);
  if (!n.rows.length) return 'That network does not belong to this project';
  const network = n.rows[0];
  if (network.chain_namespace !== 'eip155') {
    // Non-EVM namespaces have no adapter yet; a task is still publishable but
    // will land in manual review rather than be refused outright.
    return null;
  }
  const rpcs = await pool.query('SELECT COUNT(*)::int AS n FROM task_rpcs WHERE network_id = $1', [network.id]);
  if (!rpcs.rows[0].n) return 'Add at least one RPC endpoint to this network before publishing';
  const test = await testNetworkEndpoints(network);
  if (!test.ok) return test.message;
  return null;
}

// Probe every endpoint of a network, recording health, and confirm the
// reported chain id matches the configured one.
async function testNetworkEndpoints(network) {
  const { rpcPoolFor } = require('../verify/evm/rpc-pool');
  const rpcs = await pool.query(
    `SELECT id, url, is_primary, priority FROM task_rpcs WHERE network_id = $1 ORDER BY is_primary DESC, priority`, [network.id]);
  if (!rpcs.rows.length) return { ok: false, message: 'This network has no RPC endpoints yet' };
  const pool_ = await rpcPoolFor(network.id);
  try {
    const { value } = await pool_.call((provider) => provider.getNetwork());
    const reported = Number(value.chainId);
    if (network.chain_id !== null && network.chain_id !== undefined && Number(network.chain_id) !== reported) {
      return { ok: false, reported_chain_id: reported, message: `The RPC reports chain ${reported}, but this network is configured as chain ${network.chain_id}` };
    }
    for (const r of rpcs.rows) {
      await pool.query(`UPDATE task_rpcs SET health_state = 'healthy', last_checked_at = NOW() WHERE id = $1`, [r.id]);
    }
    return { ok: true, reported_chain_id: reported, rpc_host: maskUrl(rpcs.rows[0].url), message: 'Connection healthy' };
  } catch (err) {
    for (const r of rpcs.rows) {
      await pool.query(`UPDATE task_rpcs SET health_state = 'down', last_checked_at = NOW() WHERE id = $1`, [r.id]);
    }
    return { ok: false, message: 'No RPC endpoint could be reached' };
  }
}

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

// Project membership is Admin or Moderator only. The request accepts either
// case and normalizes to the stored lower-case spelling.
const MEMBER_ROLES = { admin: 'admin', moderator: 'moderator' };
function normalizeMemberRole(input) {
  return MEMBER_ROLES[String(input || '').trim().toLowerCase()] || null;
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

// A client-supplied key that makes a create idempotent: a retried submit with
// the same key returns the row it already created instead of a second one.
function clientKey(req) {
  const raw = req.get('Idempotency-Key') || (req.body && req.body.idempotency_key);
  if (!raw) return null;
  const key = String(raw).trim().slice(0, 200);
  return key || null;
}

// ---- projects ----
router.post('/projects', async (req, res) => {
  const idemKey = clientKey(req);
  if (idemKey) {
    const dup = await pool.query('SELECT * FROM projects WHERE idempotency_key = $1', [idemKey]);
    if (dup.rows.length) return res.json({ project: dup.rows[0], idempotent: true });
  }
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
      `INSERT INTO projects (slug, creator_id, name, description, logo_url, website, social_links, visibility, banner_url, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [slug, owner, String(name).trim(), description || null, logo_url || null, website || null,
        social_links && typeof social_links === 'object' ? social_links : {},
        req.body.visibility === 'unlisted' ? 'unlisted' : 'public', req.body.banner_url || null, idemKey]
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
  // The caller's role on each project travels with the row so a client can
  // label it ("Creator" or the member role) without a second read.
  const { rows } = await pool.query(
    `SELECT p.*, (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS members,
            CASE WHEN p.creator_id = $1 THEN 'creator'
                 ELSE (SELECT pm.role FROM project_members pm
                        WHERE pm.project_id = p.id AND pm.user_id = $1 AND pm.status = 'active' LIMIT 1)
            END AS viewer_role
     FROM projects p
     WHERE p.creator_id = $1
        OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1 AND pm.status = 'active')
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
  const isCreator = rbac.isCreator(p, uid);
  const memberRole = isCreator ? null : await rbac.roleOn(uid, p.id);
  // Every permission this viewer holds, so the dashboard can gate its
  // sections from the payload rather than re-deriving a role.
  const permissions = {};
  for (const perm of rbac.PROJECT_PERMISSIONS) {
    permissions[perm] = rbac.resolvePermission({ isCreator, role: memberRole, permission: perm });
  }
  const canSeePrivate = permissions['project.view_private'];
  // An archived/soft-deleted project is not publicly reachable: only a viewer
  // who can see private project state can still open it.
  if ((p.status !== 'active' || p.deleted_at) && !canSeePrivate) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const campaigns = await pool.query(
    `SELECT c.*,
            (SELECT COUNT(*)::int FROM quests q WHERE q.campaign_id = c.id) AS quest_count,
            (SELECT COUNT(DISTINCT qc.user_id)::int FROM quest_completions qc
              JOIN quests q ON q.id = qc.quest_id WHERE q.campaign_id = c.id) AS participants
     FROM campaigns c
     WHERE c.project_id = $1 AND (c.status <> 'draft' OR $2 = TRUE)
     ORDER BY c.created_at DESC`, [p.id, canSeePrivate]);
  // The management rows read description, dates and a task count as well as
  // the fields the public checklist uses. Every column here is already public
  // on the quest page, so the wider projection leaks nothing.
  const quests = await pool.query(
    `SELECT q.id, q.campaign_id, q.slug, q.title, q.description, q.quest_type, q.xp_reward, q.points_reward,
            q.status, q.sort_order, q.starts_at, q.ends_at, q.is_required, q.created_at, q.updated_at,
            (SELECT COUNT(DISTINCT qc.user_id)::int FROM quest_completions qc WHERE qc.quest_id = q.id) AS participants,
            (SELECT COUNT(*)::int FROM quest_tasks qt WHERE qt.quest_id = q.id) AS task_count
     FROM quests q JOIN campaigns c ON c.id = q.campaign_id
     WHERE c.project_id = $1 AND (q.status = 'active' OR $2 = TRUE)
     ORDER BY q.sort_order`, [p.id, canSeePrivate]);
  const byCampaign = {};
  for (const q of quests.rows) (byCampaign[q.campaign_id] = byCampaign[q.campaign_id] || []).push(q);
  res.json({
    project: p,
    is_creator: isCreator,
    role: memberRole,
    permissions,
    can_manage: permissions['campaign.manage'] || permissions['access.manage'],
    can_delete: permissions['project.delete'],
    campaigns: campaigns.rows.map(c => ({ ...c, quests: byCampaign[c.id] || [] })),
  });
});

// The project's own access history. Only a viewer who can manage access (the
// Creator) may read it.
router.get('/projects/:id/audit', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'audit.view'))) return;
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.actor_user_id, u.username AS actor, a.entity_id,
            a.before, a.after, a.metadata, a.created_at
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.entity_type = 'project' AND a.entity_id = $1
     ORDER BY a.created_at DESC LIMIT 100`, [p.id]);
  res.json({ entries: rows });
});

// Project access. Only the Creator can read or change the roster; an Admin or
// Moderator can never manage members. The Creator is shown from the project
// row (creator_id) and never has a membership row.
router.get('/projects/:id/members', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'access.manage'))) return;
  const creator = await pool.query(
    `SELECT u.id AS user_id, u.username, u.display_name, u.avatar_url
     FROM users u WHERE u.id = $1`, [p.creator_id]);
  const { rows } = await pool.query(
    `SELECT pm.id, pm.user_id, pm.role, pm.status, u.username, u.display_name, u.avatar_url
     FROM project_members pm JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = $1 AND pm.status = 'active'
     ORDER BY pm.role, u.username`, [p.id]);
  res.json({
    creator: creator.rows[0] || null,
    members: rows.filter((m) => Number(m.user_id) !== Number(p.creator_id)),
  });
});

// Add a member by username, as Admin or Moderator. The handle is resolved
// against the local users table; an unknown handle is refused rather than
// fabricated. Re-adding an existing member is refused so a role change goes
// through PATCH.
router.post('/projects/:id/members', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'access.manage'))) return;
  const username = String((req.body || {}).username || '').trim();
  const role = normalizeMemberRole((req.body || {}).role);
  if (!username) return res.status(400).json({ error: 'A username is required' });
  if (!role) return res.status(400).json({ error: 'Choose Admin or Moderator' });
  const u = await pool.query('SELECT id, username FROM users WHERE lower(username) = lower($1)', [username]);
  if (!u.rows.length) return res.status(404).json({ error: 'No Questora account with that username yet' });
  if (Number(u.rows[0].id) === Number(p.creator_id)) {
    return res.status(400).json({ error: 'The Creator already runs this project' });
  }
  const existing = await pool.query(
    "SELECT id FROM project_members WHERE project_id = $1 AND user_id = $2 AND status = 'active'",
    [p.id, u.rows[0].id]);
  if (existing.rows.length) {
    return res.status(409).json({ error: 'That user already helps with this project. Change their role instead.' });
  }
  await pool.query(
    `INSERT INTO project_members (project_id, user_id, role, status, updated_at)
     VALUES ($1, $2, $3, 'active', NOW())
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = NOW()`,
    [p.id, u.rows[0].id, role]);
  await audit(userId(req), role === 'admin' ? 'ADMIN_ADDED' : 'MODERATOR_ADDED', 'project', p.id,
    { role: null }, { role },
    { target_user_id: u.rows[0].id, target_username: u.rows[0].username });
  res.json({ ok: true, role, username: u.rows[0].username });
});

// Change a member between Admin and Moderator. Only the Creator may do this.
router.patch('/projects/:id/members/:userId', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'access.manage'))) return;
  const role = normalizeMemberRole((req.body || {}).role);
  if (!role) return res.status(400).json({ error: 'Choose Admin or Moderator' });
  const target = Number(req.params.userId);
  if (target === Number(p.creator_id)) {
    return res.status(400).json({ error: 'The Creator already runs this project' });
  }
  const before = await pool.query(
    "SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2 AND status = 'active'",
    [p.id, target]);
  if (!before.rows.length) return res.status(404).json({ error: 'That user is not a member of this project' });
  if (before.rows[0].role === role) return res.json({ ok: true, role, unchanged: true });
  await pool.query(
    'UPDATE project_members SET role = $3, updated_at = NOW() WHERE project_id = $1 AND user_id = $2',
    [p.id, target, role]);
  await audit(userId(req), 'ROLE_CHANGED', 'project', p.id,
    { role: before.rows[0].role }, { role },
    { target_user_id: target, previous_role: before.rows[0].role, new_role: role });
  res.json({ ok: true, role });
});

// Remove a member by marking their membership removed. Access is revoked
// immediately while the row is kept for the access history.
router.delete('/projects/:id/members/:userId', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'access.manage'))) return;
  const target = Number(req.params.userId);
  if (target === Number(p.creator_id)) {
    return res.status(400).json({ error: 'The Creator cannot be removed from their own project' });
  }
  const row = await pool.query(
    "SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2 AND status = 'active'",
    [p.id, target]);
  if (!row.rows.length) return res.status(404).json({ error: 'That user is not a member of this project' });
  await pool.query(
    "UPDATE project_members SET status = 'removed', updated_at = NOW() WHERE project_id = $1 AND user_id = $2",
    [p.id, target]);
  await audit(userId(req), row.rows[0].role === 'admin' ? 'ADMIN_REMOVED' : 'MODERATOR_REMOVED', 'project', p.id,
    { role: row.rows[0].role }, null,
    { target_user_id: target, previous_role: row.rows[0].role });
  res.json({ ok: true });
});

// Project settings: name, description, branding, links, visibility and
// lifecycle status (publish / unpublish / archive / restore). A platform
// admin passes the same shared guard as everyone else.
router.patch('/projects/:id', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'project.edit'))) return;
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
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'project.delete'))) return;
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
// path needs ?mode=hard and the same project.delete permission. Both are
// audited; a soft delete stays restorable via PATCH status='active'.
router.delete('/projects/:id', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'project.delete'))) return;
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
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'campaign.manage'))) return;
  const idemKey = clientKey(req);
  if (idemKey) {
    const dup = await pool.query('SELECT * FROM campaigns WHERE idempotency_key = $1', [idemKey]);
    if (dup.rows.length) return res.json({ campaign: dup.rows[0], idempotent: true });
  }
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
                            ends_at, status, featured, visibility, rules, leaderboard_config, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
    [p.id, slug, String(name).trim(), description || null, banner_url || null, category || null,
      Array.isArray(chains) ? chains : [],
      starts_at || null, ends_at || null, st, !!featured,
      visibility === 'unlisted' ? 'unlisted' : 'public', rules || null,
      leaderboard_config && typeof leaderboard_config === 'object' ? leaderboard_config : {}, idemKey]
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
  // Project RBAC only. A platform admin gets no project permission here.
  if (!(await rbac.requireProjectPermission(req, res, campaign.project_id, 'campaign.manage'))) return;
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
    const isCreator = await rbac.can(campaign.project_id, userId(req), 'project.edit');
    if (req.body.status !== campaign.status && !legal.includes(req.body.status) && !isCreator) {
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
  if (!(await rbac.requireProjectPermission(req, res, campaign.project_id, 'campaign.manage'))) return;
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
  if (!(await rbac.requireProjectPermission(req, res, campaign.project_id, 'campaign.manage'))) return;
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
  if (!(await rbac.requireProjectPermission(req, res, campaign.project_id, 'quest.manage'))) return;
  const idemKey = clientKey(req);
  if (idemKey) {
    const dup = await pool.query('SELECT * FROM quests WHERE idempotency_key = $1', [idemKey]);
    if (dup.rows.length) return res.json({ quest: dup.rows[0], idempotent: true });
  }
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
                           visibility, max_participants, completion_limit, idempotency_key, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW()) RETURNING *`,
      [campaign.id, slug, String(title).trim(), description || null, instructions || null,
        req.body.image_url || null, req.body.quest_type || null,
        ord.rows[0].n, is_required === undefined ? true : !!is_required,
        Math.max(0, parseInt(xp_reward, 10) || 0), Math.max(0, parseInt(points_reward, 10) || 0),
        req.body.starts_at || null, req.body.ends_at || null, st,
        req.body.visibility === 'unlisted' ? 'unlisted' : 'public',
        req.body.max_participants ? Math.max(1, parseInt(req.body.max_participants, 10) || 1) : null,
        Math.max(1, parseInt(req.body.completion_limit, 10) || 1), idemKey]
    );
    const questId = q.rows[0].id;
    if (!q.rows[0].quest_type) {
      await client.query('UPDATE quests SET quest_type = $2 WHERE id = $1', [questId, await questTypeLabelFromTasks(tasks)]);
    }
    for (let i = 0; i < (tasks || []).length; i++) {
      const t = tasks[i];
      const cfgErr = validateTaskConfig(t.type, t.config || {});
      if (cfgErr) { await client.query('ROLLBACK'); return res.status(400).json({ error: cfgErr }); }
      const verification = ['quiz', 'wallet_connect', 'on_chain'].includes(t.type) ? 'automatic' : 'manual';
      const taskIns = await client.query(
        `INSERT INTO quest_tasks (quest_id, type, title, config, sort_order, verification_type, proof_required,
                                  project_id, campaign_id, xp_reward)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [questId, t.type, t.title || 'Task', JSON.stringify(t.config || {}), i, verification,
          ['url_proof', 'manual', 'social'].includes(t.type),
          campaign.project_id, campaign.id, Math.max(0, parseInt(t.xp_reward, 10) || 0)]
      );
      // Every task has a v1 version so the engine always reads an active one.
      const ver = await client.query(
        `INSERT INTO task_versions (task_id, version, config, created_by) VALUES ($1, 1, $2, $3) RETURNING id`,
        [taskIns.rows[0].id, JSON.stringify(t.config || {}), userId(req)]);
      await client.query('UPDATE quest_tasks SET current_version_id = $2 WHERE id = $1',
        [taskIns.rows[0].id, ver.rows[0].id]);
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
  if (!(await rbac.requireProjectPermission(req, res, q.rows[0].project_id, 'quest.manage'))) return;
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
    if (req.body.status !== q.rows[0].status && !legal.includes(req.body.status) && !(await rbac.can(q.rows[0].project_id, userId(req), 'project.edit'))) {
      return res.status(400).json({ error: `A ${q.rows[0].status} quest cannot move to ${req.body.status}.` });
    }
    allowed.status = req.body.status;
  }
  if (req.body.sort_order !== undefined) allowed.sort_order = parseInt(req.body.sort_order, 10) || 0;
  const sets = Object.keys(allowed);
  // Rewards and prerequisites are edited alongside the quest columns, so the
  // edit screen has one save. A rewards-only save is legal on its own.
  const managesRewards = req.body.badge_id !== undefined || req.body.credential_title !== undefined;
  const setsPrereqs = req.body.requires_quests !== undefined || req.body.require_all !== undefined;
  if (managesRewards && !(await rbac.can(q.rows[0].project_id, userId(req), 'rewards.manage'))) {
    return res.status(403).json({ error: 'You do not have permission to manage this project' });
  }
  if (!sets.length && !managesRewards && !setsPrereqs) return res.status(400).json({ error: 'Nothing to update' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let updated = q.rows[0];
    if (sets.length) {
      allowed.updated_at = new Date();
      const keys = Object.keys(allowed);
      const { rows } = await client.query(
        `UPDATE quests SET ${keys.map((s, i) => `${s} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
        [q.rows[0].id, ...keys.map(k => allowed[k])]
      );
      updated = rows[0];
    }
    if (managesRewards) {
      // Badge reward: a single badge row keyed by badge_id, replaced or cleared.
      await client.query(`DELETE FROM rewards WHERE quest_id = $1 AND kind = 'badge'`, [q.rows[0].id]);
      if (req.body.badge_id) {
        await client.query(`INSERT INTO rewards (quest_id, kind, config) VALUES ($1, 'badge', $2)`,
          [q.rows[0].id, JSON.stringify({ badge_id: Number(req.body.badge_id) })]);
      }
      await client.query(`DELETE FROM rewards WHERE quest_id = $1 AND kind = 'credential'`, [q.rows[0].id]);
      if (req.body.credential_title && String(req.body.credential_title).trim()) {
        await client.query(`INSERT INTO rewards (quest_id, kind, config) VALUES ($1, 'credential', $2)`,
          [q.rows[0].id, JSON.stringify({ title: String(req.body.credential_title).trim().slice(0, 255) })]);
      }
    }
    if (setsPrereqs) {
      const prereqs = (req.body.requires_quests || []).map(Number).filter(Number.isFinite);
      const operator = req.body.require_all === false ? 'any' : 'all';
      const existing = await client.query('SELECT id FROM quest_conditions WHERE quest_id = $1 LIMIT 1', [q.rows[0].id]);
      if (existing.rows.length) {
        await client.query('UPDATE quest_conditions SET operator = $2, config = $3 WHERE id = $1',
          [existing.rows[0].id, operator, JSON.stringify(prereqs.length ? { requires_quests: prereqs } : {})]);
      } else {
        await client.query(`INSERT INTO quest_conditions (quest_id, operator, config) VALUES ($1, $2, $3)`,
          [q.rows[0].id, operator, JSON.stringify(prereqs.length ? { requires_quests: prereqs } : {})]);
      }
    }
    await client.query('COMMIT');
    await audit(userId(req), 'quest.update', 'quest', q.rows[0].id, q.rows[0], updated, req.body.reason || null);
    res.json({ quest: updated });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// The quest editor's Rewards and Prerequisites prefill: the quest's reward
// rows plus its condition config, gated on quest.manage.
router.get('/quests/:id/rewards', async (req, res) => {
  const q = await pool.query(
    `SELECT q.*, c.project_id FROM quests q JOIN campaigns c ON c.id = q.campaign_id WHERE q.id = $1`, [req.params.id]);
  if (!q.rows.length) return res.status(404).json({ error: 'Quest not found' });
  if (!(await rbac.requireProjectPermission(req, res, q.rows[0].project_id, 'quest.manage'))) return;
  const rewards = await pool.query('SELECT id, kind, config FROM rewards WHERE quest_id = $1 ORDER BY id', [q.rows[0].id]);
  const cond = await pool.query('SELECT operator, config FROM quest_conditions WHERE quest_id = $1 LIMIT 1', [q.rows[0].id]);
  const badge = rewards.rows.find(r => r.kind === 'badge');
  const credential = rewards.rows.find(r => r.kind === 'credential');
  res.json({
    rewards: rewards.rows,
    badge_id: badge && badge.config ? badge.config.badge_id || null : null,
    credential_title: credential && credential.config ? credential.config.title || null : null,
    requires_quests: (cond.rows[0] && cond.rows[0].config && cond.rows[0].config.requires_quests) || [],
    require_all: cond.rows[0] ? cond.rows[0].operator !== 'any' : true,
  });
});

// Duplicate a quest as a draft at the end of its own campaign. The copy is a
// full configuration copy: every quest column, each task with its reward and
// completion settings and a fresh v1 version, plus the rewards and
// prerequisite conditions. Participant, submission and analytics data is
// never read.
router.post('/quests/:id/duplicate', async (req, res) => {
  const q = await pool.query(
    `SELECT q.*, c.project_id FROM quests q JOIN campaigns c ON c.id = q.campaign_id WHERE q.id = $1`, [req.params.id]);
  if (!q.rows.length) return res.status(404).json({ error: 'Quest not found' });
  if (!(await rbac.requireProjectPermission(req, res, q.rows[0].project_id, 'quest.manage'))) return;
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
                           visibility, max_participants, completion_limit, max_completions, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft', $14, $15, $16, $17, NOW())
       RETURNING *`,
      [quest.campaign_id, slug, quest.title + ' Copy', quest.description, quest.instructions,
        quest.image_url, quest.quest_type, ord.rows[0].n, quest.is_required, quest.xp_reward,
        quest.points_reward, quest.starts_at, quest.ends_at, quest.visibility, quest.max_participants,
        quest.completion_limit, quest.max_completions]);
    const newQuestId = nq.rows[0].id;
    const tasks = await client.query('SELECT * FROM quest_tasks WHERE quest_id = $1 ORDER BY sort_order', [quest.id]);
    for (const t of tasks.rows) {
      const ins = await client.query(
        `INSERT INTO quest_tasks (quest_id, type, title, config, sort_order, verification_type, proof_required,
                                  project_id, campaign_id, xp_reward, completion_mode, max_completions,
                                  attempt_limit, cooldown_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [newQuestId, t.type, t.title, JSON.stringify(t.config || {}), t.sort_order, t.verification_type,
          t.proof_required, quest.project_id, quest.campaign_id, t.xp_reward, t.completion_mode,
          t.max_completions, t.attempt_limit, t.cooldown_seconds]);
      // A duplicated task needs its own v1 version so the engine always reads
      // an active version, exactly as a freshly created task gets one.
      const ver = await client.query(
        `INSERT INTO task_versions (task_id, version, config, created_by) VALUES ($1, 1, $2, $3) RETURNING id`,
        [ins.rows[0].id, JSON.stringify(t.config || {}), userId(req)]);
      await client.query('UPDATE quest_tasks SET current_version_id = $2 WHERE id = $1', [ins.rows[0].id, ver.rows[0].id]);
    }
    // Rewards and prerequisite conditions travel with the copy.
    await client.query(
      `INSERT INTO rewards (quest_id, kind, config, supply_cap, status)
       SELECT $1, kind, config, supply_cap, status FROM rewards WHERE quest_id = $2`,
      [newQuestId, quest.id]);
    await client.query(
      `INSERT INTO quest_conditions (quest_id, operator, config)
       SELECT $1, operator, config FROM quest_conditions WHERE quest_id = $2`,
      [newQuestId, quest.id]);
    await client.query('COMMIT');
    await audit(userId(req), 'quest.duplicate', 'quest', newQuestId, null, nq.rows[0], null);
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
  if (!(await rbac.requireProjectPermission(req, res, quest.project_id, 'quest.manage'))) return;
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
  if (!(await rbac.requireProjectPermission(req, res, c.rows[0].project_id, 'quest.manage'))) return;
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
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'submissions.review'))) return;
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
  if (!(await rbac.requireProjectPermission(req, res, q.rows[0].project_id, 'submissions.review'))) return;
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
      `INSERT INTO notifications (user_id, type, title, body, link, dedupe_key)
       VALUES ($1, 'submission_rejected', $2, $3, $4, $5)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [sub.user_id, 'Submission rejected',
        quest.rows[0] ? `Your submission for "${quest.rows[0].title}" was rejected. ${reason}` : 'Your submission was rejected.',
        '/quest/' + sub.quest_id, 'submission-rejected:' + sub.id]
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
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'analytics.view'))) return;
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
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'analytics.view'))) return;
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
router.validateOnChainAsync = validateOnChainAsync;
router.testNetworkEndpoints = testNetworkEndpoints;
// Exposed for tests: the legal campaign state transitions.
router.CAMPAIGN_TRANSITIONS = CAMPAIGN_TRANSITIONS;
// ---- on-chain networks, tokens and task versions (Slice 1) ----
// Creator-facing shape of a network: never the RPC URL, only a masked host.
const NETWORK_COLUMNS = ['name', 'chain_namespace', 'chain_id', 'native_symbol', 'native_decimals',
  'explorer_url', 'explorer_tx_url', 'explorer_address_url', 'is_testnet', 'finality_model', 'address_format'];

function sanitizeNetworkRow(n, rpcs) {
  return {
    id: n.id, project_id: n.project_id, name: n.name, chain_namespace: n.chain_namespace,
    chain_id: n.chain_id === null || n.chain_id === undefined ? null : Number(n.chain_id),
    native_symbol: n.native_symbol, native_decimals: n.native_decimals,
    explorer_url: n.explorer_url, explorer_tx_url: n.explorer_tx_url,
    explorer_address_url: n.explorer_address_url, is_testnet: n.is_testnet,
    finality_model: n.finality_model, address_format: n.address_format,
    rpcs: (rpcs || []).map(r => ({ id: r.id, kind: r.kind, priority: r.priority, is_primary: r.is_primary,
      health_state: r.health_state, last_checked_at: r.last_checked_at, host: maskUrl(r.url) })),
  };
}

// The preset catalog. Public chain parameters only, so no permission needed
// beyond being signed in.
router.get('/network-presets', (req, res) => {
  res.json({ presets: networkPresets.PRESETS });
});

router.post('/projects/:id/networks', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'verification.manage'))) return;
  let b = req.body || {};
  // A preset supplies every field and its RPC endpoints; anything the creator
  // sent explicitly overrides the preset's value.
  let preset = null;
  if (b.preset_id) {
    preset = networkPresets.getPreset(String(b.preset_id));
    if (!preset) return res.status(400).json({ error: 'Unknown network preset' });
    const fromPreset = networkPresets.presetToNetworkFields(preset);
    const overrides = {};
    for (const k of Object.keys(fromPreset)) if (b[k] !== undefined && b[k] !== null && b[k] !== '') overrides[k] = b[k];
    b = { ...fromPreset, ...overrides };
    const dup = await pool.query('SELECT 1 FROM task_networks WHERE project_id = $1 AND name = $2', [p.id, b.name]);
    if (dup.rows.length) return res.status(409).json({ error: 'This project already has a network named ' + b.name });
  }
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'A network name is required' });
  const ns = String(b.chain_namespace || 'eip155');
  if (!adapterFor(ns)) {
    // Non-EVM families are accepted for configuration but have no adapter yet,
    // so tasks on them route to manual review. Only reject a namespace that no
    // known wallet chain recognizes.
    const walletChains = require('../verify/wallet-chains');
    if (!walletChains.adapterFor(ns)) return res.status(400).json({ error: 'Unknown chain family' });
  }
  const chainId = b.chain_id === undefined || b.chain_id === null || b.chain_id === '' ? null : Number(b.chain_id);
  if (chainId !== null && !Number.isFinite(chainId)) return res.status(400).json({ error: 'Chain id must be a number' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO task_networks (project_id, chain_namespace, chain_id, name, native_symbol, native_decimals,
        explorer_url, explorer_tx_url, explorer_address_url, is_testnet, finality_model, address_format)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [p.id, ns, chainId, String(b.name).trim().slice(0, 255), b.native_symbol || null,
        Number.isInteger(Number(b.native_decimals)) ? Number(b.native_decimals) : null,
        b.explorer_url || null, b.explorer_tx_url || null, b.explorer_address_url || null,
        !!b.is_testnet, b.finality_model || null, b.address_format || null]);
    // Preset RPCs (or the creator's own list, when they typed one) become the
    // network's endpoints: first is primary, the rest are backups in order.
    const rpcUrls = preset
      ? (Array.isArray(req.body.rpc_urls) ? req.body.rpc_urls.map(u => String(u).trim()).filter(Boolean) : preset.rpcs)
      : [];
    if (rpcUrls.some(u => !validUrl(u))) {
      await pool.query('DELETE FROM task_networks WHERE id = $1', [rows[0].id]);
      return res.status(400).json({ error: 'The RPC URL must start with http or https' });
    }
    const rpcRows = [];
    for (let i = 0; i < rpcUrls.length; i++) {
      const r = await pool.query(
        `INSERT INTO task_rpcs (network_id, url, kind, priority, is_primary) VALUES ($1,$2,'https',$3,$4) RETURNING *`,
        [rows[0].id, rpcUrls[i], i, i === 0]);
      rpcRows.push(r.rows[0]);
    }
    await audit(userId(req), 'network.create', 'network', rows[0].id, null, sanitizeNetworkRow(rows[0], rpcRows), null);
    res.json({ network: sanitizeNetworkRow(rows[0], rpcRows) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This project already has a network with that chain id' });
    throw err;
  }
});

router.get('/projects/:id/networks', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'verification.manage'))) return;
  const nets = await pool.query('SELECT * FROM task_networks WHERE project_id = $1 ORDER BY id', [p.id]);
  const rpcs = nets.rows.length ? await pool.query(
    'SELECT * FROM task_rpcs WHERE network_id = ANY($1) ORDER BY is_primary DESC, priority', [nets.rows.map(n => n.id)]) : { rows: [] };
  const byNet = {};
  for (const r of rpcs.rows) (byNet[r.network_id] = byNet[r.network_id] || []).push(r);
  res.json({ networks: nets.rows.map(n => sanitizeNetworkRow(n, byNet[n.id] || [])) });
});

router.get('/networks/:id', async (req, res) => {
  const n = await pool.query(
    `SELECT n.*, p.creator_id FROM task_networks n JOIN projects p ON p.id = n.project_id WHERE n.id = $1`, [req.params.id]);
  if (!n.rows.length) return res.status(404).json({ error: 'Network not found' });
  if (!(await rbac.requireProjectPermission(req, res, n.rows[0].project_id, 'verification.manage'))) return;
  const rpcs = await pool.query('SELECT * FROM task_rpcs WHERE network_id = $1 ORDER BY is_primary DESC, priority', [n.rows[0].id]);
  res.json({ network: sanitizeNetworkRow(n.rows[0], rpcs.rows) });
});

router.patch('/networks/:id', async (req, res) => {
  const n = await pool.query('SELECT * FROM task_networks WHERE id = $1', [req.params.id]);
  if (!n.rows.length) return res.status(404).json({ error: 'Network not found' });
  if (!(await rbac.requireProjectPermission(req, res, n.rows[0].project_id, 'verification.manage'))) return;
  const b = req.body || {};
  const allowed = {};
  for (const k of ['name', 'native_symbol', 'explorer_url', 'explorer_tx_url', 'explorer_address_url', 'finality_model', 'address_format']) {
    if (b[k] !== undefined) allowed[k] = b[k];
  }
  if (b.native_decimals !== undefined) allowed.native_decimals = Number.isInteger(Number(b.native_decimals)) ? Number(b.native_decimals) : null;
  if (b.chain_id !== undefined) allowed.chain_id = b.chain_id === null || b.chain_id === '' ? null : Number(b.chain_id);
  if (b.is_testnet !== undefined) allowed.is_testnet = !!b.is_testnet;
  const sets = Object.keys(allowed);
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  const { rows } = await pool.query(
    `UPDATE task_networks SET ${sets.map((s, i) => `${s} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [n.rows[0].id, ...sets.map(s => allowed[s])]);
  await audit(userId(req), 'network.update', 'network', n.rows[0].id, sanitizeNetworkRow(n.rows[0], []), sanitizeNetworkRow(rows[0], []), null);
  res.json({ network: sanitizeNetworkRow(rows[0], []) });
});

// The Test connection button. Never returns the raw URL to the client.
router.post('/networks/:id/test', async (req, res) => {
  const n = await pool.query('SELECT * FROM task_networks WHERE id = $1', [req.params.id]);
  if (!n.rows.length) return res.status(404).json({ error: 'Network not found' });
  if (!(await rbac.requireProjectPermission(req, res, n.rows[0].project_id, 'verification.manage'))) return;
  const result = await testNetworkEndpoints(n.rows[0]);
  res.json({ ok: !!result.ok, message: result.message, reported_chain_id: result.reported_chain_id || null,
    rpc_host: result.rpc_host || null, chain_id: n.rows[0].chain_id === null ? null : Number(n.rows[0].chain_id) });
});

// RPC endpoints. The URL is accepted on write and never returned on read.
router.post('/networks/:id/rpcs', async (req, res) => {
  const n = await pool.query('SELECT * FROM task_networks WHERE id = $1', [req.params.id]);
  if (!n.rows.length) return res.status(404).json({ error: 'Network not found' });
  if (!(await rbac.requireProjectPermission(req, res, n.rows[0].project_id, 'verification.manage'))) return;
  const b = req.body || {};
  if (!validUrl(b.url)) return res.status(400).json({ error: 'The RPC URL must start with http or https' });
  const isPrimary = !!b.is_primary;
  if (isPrimary) await pool.query('UPDATE task_rpcs SET is_primary = FALSE WHERE network_id = $1', [n.rows[0].id]);
  const { rows } = await pool.query(
    `INSERT INTO task_rpcs (network_id, url, kind, priority, is_primary, credential_ref, timeout_ms, max_retries)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [n.rows[0].id, String(b.url).trim(), b.kind === 'wss' ? 'wss' : 'https',
      Math.max(0, parseInt(b.priority, 10) || 0), isPrimary, b.credential_ref || null,
      Math.max(1000, parseInt(b.timeout_ms, 10) || 8000), Math.max(0, parseInt(b.max_retries, 10) || 0)]);
  await audit(userId(req), 'network.rpc.add', 'network', n.rows[0].id, null, sanitizeNetworkRow(n.rows[0], rows), null);
  res.json({ rpc: sanitizeNetworkRow(n.rows[0], rows).rpcs[0] });
});

router.patch('/rpcs/:id', async (req, res) => {
  const r = await pool.query(
    `SELECT r.*, n.project_id FROM task_rpcs r JOIN task_networks n ON n.id = r.network_id WHERE r.id = $1`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'RPC endpoint not found' });
  if (!(await rbac.requireProjectPermission(req, res, r.rows[0].project_id, 'verification.manage'))) return;
  const b = req.body || {};
  const allowed = {};
  if (b.url !== undefined) { if (!validUrl(b.url)) return res.status(400).json({ error: 'The RPC URL must start with http or https' }); allowed.url = String(b.url).trim(); }
  if (b.kind !== undefined) allowed.kind = b.kind === 'wss' ? 'wss' : 'https';
  if (b.priority !== undefined) allowed.priority = Math.max(0, parseInt(b.priority, 10) || 0);
  if (b.credential_ref !== undefined) allowed.credential_ref = b.credential_ref || null;
  if (b.timeout_ms !== undefined) allowed.timeout_ms = Math.max(1000, parseInt(b.timeout_ms, 10) || 8000);
  if (b.max_retries !== undefined) allowed.max_retries = Math.max(0, parseInt(b.max_retries, 10) || 0);
  if (b.is_primary !== undefined) {
    allowed.is_primary = !!b.is_primary;
    if (allowed.is_primary) await pool.query('UPDATE task_rpcs SET is_primary = FALSE WHERE network_id = $1 AND id <> $2', [r.rows[0].network_id, r.rows[0].id]);
  }
  const sets = Object.keys(allowed);
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  const { rows } = await pool.query(
    `UPDATE task_rpcs SET ${sets.map((s, i) => `${s} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [r.rows[0].id, ...sets.map(s => allowed[s])]);
  res.json({ rpc: { id: rows[0].id, kind: rows[0].kind, priority: rows[0].priority, is_primary: rows[0].is_primary,
    health_state: rows[0].health_state, host: maskUrl(rows[0].url) } });
});

router.delete('/rpcs/:id', async (req, res) => {
  const r = await pool.query(
    `SELECT r.*, n.project_id FROM task_rpcs r JOIN task_networks n ON n.id = r.network_id WHERE r.id = $1`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'RPC endpoint not found' });
  if (!(await rbac.requireProjectPermission(req, res, r.rows[0].project_id, 'verification.manage'))) return;
  await pool.query('DELETE FROM task_rpcs WHERE id = $1', [r.rows[0].id]);
  await audit(userId(req), 'network.rpc.remove', 'network', r.rows[0].network_id, { host: maskUrl(r.rows[0].url) }, null, null);
  res.json({ deleted: true });
});

// Tokens: try the contract for name/symbol/decimals, fall back to manual entry.
router.post('/projects/:id/tokens', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'verification.manage'))) return;
  const b = req.body || {};
  if (!b.network_id) return res.status(400).json({ error: 'Choose a network for this token' });
  const net = await pool.query('SELECT * FROM task_networks WHERE id = $1 AND project_id = $2', [b.network_id, p.id]);
  if (!net.rows.length) return res.status(404).json({ error: 'Network not found in this project' });
  if (!b.contract_address || !String(b.contract_address).trim()) return res.status(400).json({ error: 'A contract address is required' });
  let symbol = b.symbol || null, name = b.name || null, decimals = Number.isInteger(Number(b.decimals)) ? Number(b.decimals) : null;
  let source = 'manual';
  // Best-effort on-chain metadata; failure just means the owner types it.
  if (net.rows[0].chain_namespace === 'eip155' && (decimals === null || !symbol)) {
    try {
      const { rpcPoolFor } = require('../verify/evm/rpc-pool');
      const { ethers } = require('ethers');
      const pool_ = await rpcPoolFor(net.rows[0].id);
      const abi = ['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
      const got = await pool_.call(async (provider) => {
        const c = new ethers.Contract(String(b.contract_address).trim(), abi, provider);
        const [n2, s2, d2] = await Promise.all([c.name().catch(() => null), c.symbol().catch(() => null), c.decimals().catch(() => null)]);
        return { name: n2, symbol: s2, decimals: d2 === null ? null : Number(d2) };
      });
      if (got.value) {
        name = name || got.value.name; symbol = symbol || got.value.symbol;
        if (decimals === null && Number.isInteger(got.value.decimals)) decimals = got.value.decimals;
        source = 'contract';
      }
    } catch { /* leave manual */ }
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO task_tokens (network_id, project_id, contract_address, token_type, symbol, name, decimals, metadata_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [net.rows[0].id, p.id, String(b.contract_address).trim(), b.token_type === 'erc721' || b.token_type === 'erc1155' ? b.token_type : 'erc20',
        symbol, name, decimals, source]);
    await audit(userId(req), 'token.create', 'token', rows[0].id, null, rows[0], null);
    res.json({ token: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That token already exists on this network' });
    throw err;
  }
});

router.get('/projects/:id/tokens', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!(await rbac.requireProjectPermission(req, res, p.id, 'verification.manage'))) return;
  const { rows } = await pool.query('SELECT * FROM task_tokens WHERE project_id = $1 ORDER BY id', [p.id]);
  res.json({ tokens: rows });
});

// ---- task builder: create / read / edit / publish ----
router.post('/quests/:id/tasks', async (req, res) => {
  const isNum = !isNaN(Number(req.params.id));
  const q = await pool.query(
    `SELECT q.*, c.project_id FROM quests q JOIN campaigns c ON c.id = q.campaign_id
     WHERE ${isNum ? 'q.id = $1' : 'q.slug = $1'} LIMIT 1`, [req.params.id]);
  if (!q.rows.length) return res.status(404).json({ error: 'Quest not found' });
  if (!(await rbac.requireProjectPermission(req, res, q.rows[0].project_id, 'task.manage'))) return;
  const idemKey = clientKey(req);
  if (idemKey) {
    const dup = await pool.query('SELECT * FROM quest_tasks WHERE idempotency_key = $1', [idemKey]);
    if (dup.rows.length) return res.json({ task: dup.rows[0], idempotent: true });
  }
  const b = req.body || {};
  const cfgErr = validateTaskConfig(b.type, b.config || {});
  if (cfgErr) return res.status(400).json({ error: cfgErr });
  if (b.type === 'on_chain') {
    const asyncErr = await validateOnChainAsync(q.rows[0].project_id, b.config || {});
    if (asyncErr) return res.status(400).json({ error: asyncErr });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ord = await client.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM quest_tasks WHERE quest_id = $1', [q.rows[0].id]);
    const verification = ['quiz', 'wallet_connect', 'on_chain'].includes(b.type) ? 'automatic' : 'manual';
    const ins = await client.query(
      `INSERT INTO quest_tasks (quest_id, type, title, config, sort_order, verification_type, proof_required,
                                project_id, campaign_id, xp_reward, completion_mode, max_completions,
                                attempt_limit, cooldown_seconds, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [q.rows[0].id, b.type, String(b.title || 'Task').slice(0, 255), JSON.stringify(b.config || {}),
        ord.rows[0].n, verification, ['url_proof', 'manual', 'social'].includes(b.type),
        q.rows[0].project_id, q.rows[0].campaign_id, Math.max(0, parseInt(b.xp_reward, 10) || 0),
        ['one_time', 'daily', 'weekly', 'monthly'].includes(b.completion_mode) ? b.completion_mode : 'one_time',
        Math.max(1, parseInt(b.max_completions, 10) || 1),
        b.attempt_limit ? Math.max(1, parseInt(b.attempt_limit, 10)) : null,
        Math.max(0, parseInt(b.cooldown_seconds, 10) || 0), idemKey]);
    const ver = await client.query(
      `INSERT INTO task_versions (task_id, version, config, created_by) VALUES ($1, 1, $2, $3) RETURNING id`,
      [ins.rows[0].id, JSON.stringify(b.config || {}), userId(req)]);
    await client.query('UPDATE quest_tasks SET current_version_id = $2 WHERE id = $1', [ins.rows[0].id, ver.rows[0].id]);
    await client.query('COMMIT');
    res.json({ task: { ...ins.rows[0], current_version_id: ver.rows[0].id } });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.get('/quests/:id/tasks', async (req, res) => {
  const isNum = !isNaN(Number(req.params.id));
  const q = await pool.query(
    `SELECT q.*, c.project_id FROM quests q JOIN campaigns c ON c.id = q.campaign_id
     WHERE ${isNum ? 'q.id = $1' : 'q.slug = $1'} LIMIT 1`, [req.params.id]);
  if (!q.rows.length) return res.status(404).json({ error: 'Quest not found' });
  if (!(await rbac.requireProjectPermission(req, res, q.rows[0].project_id, 'task.manage'))) return;
  const tasks = await pool.query('SELECT * FROM quest_tasks WHERE quest_id = $1 ORDER BY sort_order', [q.rows[0].id]);
  const versions = tasks.rows.length ? await pool.query(
    `SELECT DISTINCT ON (task_id) * FROM task_versions WHERE task_id = ANY($1) ORDER BY task_id, version DESC`,
    [tasks.rows.map(t => t.id)]) : { rows: [] };
  const byTask = {};
  for (const v of versions.rows) byTask[v.task_id] = v;
  res.json({ quest: { id: q.rows[0].id, title: q.rows[0].title, status: q.rows[0].status,
      starts_at: q.rows[0].starts_at, ends_at: q.rows[0].ends_at, project_id: q.rows[0].project_id },
    tasks: tasks.rows.map(t => sanitizeTaskForCreator(t, byTask[t.id] || null)) });
});

router.get('/tasks/:id', async (req, res) => {
  const t = await pool.query(
    `SELECT t.*, c.project_id FROM quest_tasks t JOIN quests q ON q.id = t.quest_id
     JOIN campaigns c ON c.id = q.campaign_id WHERE t.id = $1`, [req.params.id]);
  if (!t.rows.length) return res.status(404).json({ error: 'Task not found' });
  const task = t.rows[0];
  const canManage = await rbac.can(task.project_id, userId(req), 'task.manage');
  if (!canManage) return res.status(403).json({ error: 'You do not have permission to manage this project' });
  const v = await pool.query('SELECT * FROM task_versions WHERE task_id = $1 ORDER BY version DESC LIMIT 1', [task.id]);
  res.json({ task: sanitizeTaskForCreator(task, v.rows[0] || null) });
});

// PATCH creates a new version when the task is live; while it is a draft of an
// unpublished quest it edits in place so the owner can iterate cheaply.
router.patch('/tasks/:id', async (req, res) => {
  const t = await pool.query(
    `SELECT t.*, q.status AS quest_status, c.project_id FROM quest_tasks t
     JOIN quests q ON q.id = t.quest_id JOIN campaigns c ON c.id = q.campaign_id WHERE t.id = $1`, [req.params.id]);
  if (!t.rows.length) return res.status(404).json({ error: 'Task not found' });
  if (!(await rbac.requireProjectPermission(req, res, t.rows[0].project_id, 'task.manage'))) return;
  const task = t.rows[0];
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inPlace = ['draft', 'scheduled'].includes(task.quest_status);
    const sets = {};
    if (b.title !== undefined) sets.title = String(b.title).slice(0, 255);
    if (b.xp_reward !== undefined) sets.xp_reward = Math.max(0, parseInt(b.xp_reward, 10) || 0);
    if (b.completion_mode !== undefined) sets.completion_mode = ['one_time', 'daily', 'weekly', 'monthly'].includes(b.completion_mode) ? b.completion_mode : 'one_time';
    if (b.max_completions !== undefined) sets.max_completions = Math.max(1, parseInt(b.max_completions, 10) || 1);
    if (b.attempt_limit !== undefined) sets.attempt_limit = b.attempt_limit ? Math.max(1, parseInt(b.attempt_limit, 10)) : null;
    if (b.cooldown_seconds !== undefined) sets.cooldown_seconds = Math.max(0, parseInt(b.cooldown_seconds, 10) || 0);

    let newConfig = task.config;
    if (b.config !== undefined) {
      const cfgErr = validateTaskConfig(task.type, b.config || {});
      if (cfgErr) { await client.query('ROLLBACK'); return res.status(400).json({ error: cfgErr }); }
      if (task.type === 'on_chain') {
        const asyncErr = await validateOnChainAsync(task.project_id, b.config || {});
        if (asyncErr) { await client.query('ROLLBACK'); return res.status(400).json({ error: asyncErr }); }
      }
      newConfig = b.config;
    }
    if (inPlace) {
      const all = { ...sets };
      if (b.config !== undefined) all.config = JSON.stringify(newConfig);
      const keys = Object.keys(all);
      if (keys.length) {
        await client.query(
          `UPDATE quest_tasks SET ${keys.map((s, i) => `${s} = $${i + 2}`).join(', ')} WHERE id = $1`,
          [task.id, ...keys.map(k => all[k])]);
      }
      if (task.current_version_id) await client.query('UPDATE task_versions SET config = $2 WHERE id = $1', [task.current_version_id, JSON.stringify(newConfig)]);
    } else {
      const nextVer = await client.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM task_versions WHERE task_id = $1', [task.id]);
      const ver = await client.query(
        `INSERT INTO task_versions (task_id, version, config, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [task.id, nextVer.rows[0].v, JSON.stringify(newConfig), userId(req)]);
      sets.config = JSON.stringify(newConfig);
      sets.current_version_id = ver.rows[0].id;
      const keys = Object.keys(sets);
      await client.query(
        `UPDATE quest_tasks SET ${keys.map((s, i) => `${s} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [task.id, ...keys.map(k => sets[k])]);
    }
    await client.query('COMMIT');
    const fresh = await pool.query('SELECT * FROM quest_tasks WHERE id = $1', [task.id]);
    const v = await pool.query('SELECT * FROM task_versions WHERE task_id = $1 ORDER BY version DESC LIMIT 1', [task.id]);
    await audit(userId(req), 'task.update', 'task', task.id, sanitizeTaskForCreator(task, null), sanitizeTaskForCreator(fresh.rows[0], v.rows[0]), null);
    res.json({ task: sanitizeTaskForCreator(fresh.rows[0], v.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.post('/tasks/:id/publish', async (req, res) => {
  const t = await pool.query(
    `SELECT t.*, q.status AS quest_status, c.project_id FROM quest_tasks t
     JOIN quests q ON q.id = t.quest_id JOIN campaigns c ON c.id = q.campaign_id WHERE t.id = $1`, [req.params.id]);
  if (!t.rows.length) return res.status(404).json({ error: 'Task not found' });
  if (!(await rbac.requireProjectPermission(req, res, t.rows[0].project_id, 'task.publish'))) return;
  const task = t.rows[0];
  const v = await pool.query('SELECT * FROM task_versions WHERE task_id = $1 ORDER BY version DESC LIMIT 1', [task.id]);
  const config = (v.rows[0] && v.rows[0].config) || task.config || {};
  const cfgErr = validateTaskConfig(task.type, config);
  if (cfgErr) return res.status(400).json({ error: cfgErr });
  if (task.type === 'on_chain') {
    const asyncErr = await validateOnChainAsync(task.project_id, config);
    if (asyncErr) return res.status(400).json({ error: asyncErr });
  }
  await pool.query(
    `UPDATE quest_tasks SET verification_type = 'automatic', current_version_id = COALESCE(current_version_id, $2) WHERE id = $1`,
    [task.id, v.rows[0] ? v.rows[0].id : null]);
  await pool.query(`UPDATE quests SET status = 'active' WHERE id = $1 AND status IN ('draft','scheduled')`, [task.quest_id]);
  await audit(userId(req), 'task.publish', 'task', task.id, null, { published: true }, null);
  res.json({ ok: true, published: true });
});

// Delete a task, unless it already produced participant data. Submissions and
// completions are a participant's history, so a task that has any is refused
// rather than silently destroying it.
router.delete('/tasks/:id', async (req, res) => {
  const t = await pool.query(
    `SELECT t.*, c.project_id FROM quest_tasks t JOIN quests q ON q.id = t.quest_id
     JOIN campaigns c ON c.id = q.campaign_id WHERE t.id = $1`, [req.params.id]);
  if (!t.rows.length) return res.status(404).json({ error: 'Task not found' });
  const task = t.rows[0];
  if (!(await rbac.requireProjectPermission(req, res, task.project_id, 'task.manage'))) return;
  const used = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM task_submissions WHERE task_id = $1) AS submissions,
            (SELECT COUNT(*)::int FROM task_completions WHERE task_id = $1) AS completions`,
    [task.id]);
  const n = used.rows[0].submissions + used.rows[0].completions;
  if (n > 0) {
    return res.status(409).json({ error: 'This task already has participant activity, so it cannot be deleted. Archive the quest instead.' });
  }
  await pool.query('DELETE FROM quest_tasks WHERE id = $1', [task.id]);
  await audit(userId(req), 'task.delete', 'task', task.id, task, null, null);
  res.json({ deleted: true });
});

// Reorder a quest's tasks: the body is the full ordered id list.
router.post('/quests/:id/tasks/reorder', async (req, res) => {
  const isNum = !isNaN(Number(req.params.id));
  const q = await pool.query(
    `SELECT q.*, c.project_id FROM quests q JOIN campaigns c ON c.id = q.campaign_id
     WHERE ${isNum ? 'q.id = $1' : 'q.slug = $1'} LIMIT 1`, [req.params.id]);
  if (!q.rows.length) return res.status(404).json({ error: 'Quest not found' });
  if (!(await rbac.requireProjectPermission(req, res, q.rows[0].project_id, 'task.manage'))) return;
  const order = Array.isArray(req.body.order) ? req.body.order.map(Number).filter(Number.isFinite) : [];
  if (!order.length) return res.status(400).json({ error: 'An ordered list of task ids is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query(
        'UPDATE quest_tasks SET sort_order = $2 WHERE id = $1 AND quest_id = $3',
        [order[i], i, q.rows[0].id]);
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

// Creator-facing task shape: only allow-listed on-chain config fields; never
// any RPC URL or credential.
function sanitizeTaskForCreator(task, version) {
  const config = (version && version.config) || task.config || {};
  const safe = { ...config };
  delete safe.__raw;
  return {
    id: task.id, quest_id: task.quest_id, project_id: task.project_id, campaign_id: task.campaign_id,
    type: task.type, title: task.title, sort_order: task.sort_order,
    verification_type: task.verification_type, proof_required: task.proof_required,
    xp_reward: task.xp_reward, completion_mode: task.completion_mode, max_completions: task.max_completions,
    attempt_limit: task.attempt_limit, cooldown_seconds: task.cooldown_seconds,
    current_version_id: task.current_version_id,
    version: version ? { id: version.id, version: version.version, config: safe } : null,
    config: safe,
  };
}

module.exports = router;
