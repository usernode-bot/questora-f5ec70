let pool = null;
function setPool(p) { pool = p; }

const PROJECT_ROLES = ['owner', 'admin', 'editor', 'reviewer', 'analyst'];
// Every project ability. `delete_project` is deliberately absent from the
// project-admin default: deleting the project is the owner's call alone, and
// an admin only gets it through an explicit per-member grant.
const PROJECT_ACTIONS = ['manage', 'review', 'edit', 'view_analytics', 'publish', 'delete_project'];
const PROJECT_ROLE_ACTIONS = {
  owner: ['manage', 'review', 'edit', 'view_analytics', 'publish', 'delete_project'],
  admin: ['manage', 'review', 'edit', 'view_analytics', 'publish'],
  editor: ['edit', 'view_analytics', 'publish'],
  reviewer: ['review', 'view_analytics'],
  analyst: ['view_analytics'],
};

function isAdmin(req) {
  return req.user && req.user.role === 'admin';
}

// Pure resolution: platform admin > owner > explicit per-member override >
// the role's default set. Exported so the rule can be unit-tested without a
// database, and used by can() below for the real decision.
function resolveAction({ isPlatformAdmin, ownerUserId, userId, role, permissions, action }) {
  if (isPlatformAdmin) return true;
  if (!userId) return false;
  if (ownerUserId !== undefined && ownerUserId !== null && Number(ownerUserId) === Number(userId)) return true;
  if (!role) return false;
  const perms = permissions && typeof permissions === 'object' ? permissions : {};
  if (Object.prototype.hasOwnProperty.call(perms, action)) return !!perms[action];
  return (PROJECT_ROLE_ACTIONS[role] || []).includes(action);
}

function isOwner(project, userId) {
  return !!project && userId != null && Number(project.owner_user_id) === Number(userId);
}

async function membership(userId, projectId) {
  if (!pool || !userId) return null;
  const { rows } = await pool.query(
    'SELECT role, permissions FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]
  );
  return rows[0] || null;
}

async function projectRole(userId, projectId) {
  const m = await membership(userId, projectId);
  return m ? m.role : null;
}

async function can(projectId, userId, action, req) {
  if (req && isAdmin(req)) return true;
  const { rows } = await pool.query(
    'SELECT owner_user_id FROM projects WHERE id = $1', [projectId]);
  if (!rows.length) return false;
  const m = await membership(userId, projectId);
  return resolveAction({
    isPlatformAdmin: false,
    ownerUserId: rows[0].owner_user_id,
    userId,
    role: m ? m.role : null,
    permissions: m ? m.permissions : null,
    action,
  });
}

async function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

// Guard a project-scoped write: a platform admin passes, otherwise the
// caller must be the project owner or hold a role (or explicit grant) for
// `action`. Returns true on success, or false after answering 403 (the
// caller returns). Every write route resolves the project from the resource
// row server-side and goes through this one path, so an id swapped in a URL
// or body cannot reach another project.
async function requireProjectAction(req, res, projectId, action) {
  const ok = await can(projectId, req.user && req.user.db_id, action, req);
  if (!ok) {
    res.status(403).json({ error: 'You do not have permission to manage this project' });
    return false;
  }
  return true;
}

module.exports = {
  setPool, projectRole, membership, can, resolveAction, isOwner, isAdmin,
  requireAdmin, requireProjectAction, PROJECT_ROLES, PROJECT_ACTIONS,
};
