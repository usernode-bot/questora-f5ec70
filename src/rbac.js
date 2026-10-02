// Project-scoped authorization. There is no global role in this path: a user
// is judged only by whether they are the project's Creator or an active
// project_members row for that exact project. Holding a role on one project
// grants nothing on another.
let pool = null;
function setPool(p) { pool = p; }

// Every permission a project role can be asked for. A blank cell in the
// matrix below means denied.
const PROJECT_PERMISSIONS = [
  'project.view_private', // see a paused/archived/soft-deleted project and its drafts
  'project.edit',         // name, description, branding, links, visibility, status
  'project.delete',       // archive (soft) and permanent delete
  'access.manage',        // add/remove members, change roles
  'audit.view',           // read the project's access history
  'campaign.manage',      // create, edit, publish, unpublish, archive, delete, reorder
  'quest.manage',         // create, edit, publish, unpublish, archive, delete, reorder
  'task.manage',          // create, edit, delete, version tasks
  'task.publish',         // validate and publish a task
  'verification.manage',  // networks, RPCs, tokens, on/off-chain verification rules
  'rewards.manage',       // rewards and XP configuration
  'submissions.review',   // approve or reject manual task submissions
  'moderation.moderate',  // moderate reported/flagged participant content
  'participants.view',
  'analytics.view',
  'leaderboard.view',
];

// Explicit per-role grants. Admin runs day-to-day content; Moderator reviews
// and moderates. Neither grants any project-level management.
const ROLE_PERMISSIONS = {
  admin: [
    'project.view_private',
    'campaign.manage', 'quest.manage', 'task.manage', 'task.publish',
    'verification.manage', 'rewards.manage',
    'submissions.review', 'moderation.moderate',
    'participants.view', 'analytics.view', 'leaderboard.view',
  ],
  moderator: [
    'project.view_private',
    'submissions.review', 'moderation.moderate',
    'participants.view', 'analytics.view', 'leaderboard.view',
  ],
};

// During the transition a boot may still carry a legacy role spelling (the
// boot migration normalizes these too). Least privilege: the granular legacy
// roles collapse down to moderator.
const LEGACY_ROLE_MAP = { editor: 'moderator', reviewer: 'moderator', analyst: 'moderator' };
function normalizeRole(role) {
  if (!role) return null;
  return LEGACY_ROLE_MAP[role] || role;
}

// Pure resolution, unit-testable without a database. Creator wins everything;
// otherwise the role's explicit matrix entry decides. No inheritance.
function resolvePermission({ isCreator, role, permission }) {
  if (isCreator) return PROJECT_PERMISSIONS.includes(permission);
  const normalized = normalizeRole(role);
  if (!normalized) return false;
  const granted = ROLE_PERMISSIONS[normalized];
  if (!granted) return false;
  return granted.includes(permission);
}

function isCreator(project, userId) {
  return !!project && userId != null && Number(project.creator_id) === Number(userId);
}

async function membership(userId, projectId) {
  if (!pool || !userId) return null;
  const { rows } = await pool.query(
    "SELECT role, status FROM project_members WHERE project_id = $1 AND user_id = $2 AND status = 'active'",
    [projectId, userId]);
  return rows[0] || null;
}

async function roleOn(userId, projectId) {
  const m = await membership(userId, projectId);
  return m ? m.role : null;
}

async function can(projectId, userId, permission) {
  if (!userId) return false;
  const { rows } = await pool.query('SELECT creator_id FROM projects WHERE id = $1', [projectId]);
  if (!rows.length) return false;
  if (Number(rows[0].creator_id) === Number(userId)) {
    return resolvePermission({ isCreator: true, role: null, permission });
  }
  const m = await membership(userId, projectId);
  return resolvePermission({ isCreator: false, role: m ? m.role : null, permission });
}

// Guard a project-scoped action. Every write route resolves the project from
// the resource row server-side and goes through this one path, so an id
// swapped in a URL or body cannot reach another project. A platform admin is
// deliberately NOT special here: project access is project-scoped only.
async function requireProjectPermission(req, res, projectId, permission) {
  const ok = await can(projectId, req.user && req.user.db_id, permission);
  if (!ok) {
    res.status(403).json({ error: 'You do not have permission to manage this project' });
    return false;
  }
  return true;
}

module.exports = {
  setPool, membership, roleOn, can, resolvePermission, isCreator, normalizeRole,
  requireProjectPermission, PROJECT_PERMISSIONS, ROLE_PERMISSIONS,
};
