let pool = null;
function setPool(p) { pool = p; }

const PROJECT_ROLES = ['owner', 'admin', 'editor', 'reviewer', 'analyst'];
// What each project role can do; owners and project admins can do all of it.
const PROJECT_ROLE_ACTIONS = {
  owner: ['manage', 'review', 'edit', 'view_analytics'],
  admin: ['manage', 'review', 'edit', 'view_analytics'],
  editor: ['edit', 'view_analytics'],
  reviewer: ['review', 'view_analytics'],
  analyst: ['view_analytics'],
};

function isAdmin(req) {
  return req.user && req.user.role === 'admin';
}

async function projectRole(userId, projectId) {
  if (!pool || !userId) return null;
  const { rows } = await pool.query(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]
  );
  return rows[0] ? rows[0].role : null;
}

async function can(projectId, userId, action) {
  const role = await projectRole(userId, projectId);
  if (!role) return false;
  return (PROJECT_ROLE_ACTIONS[role] || []).includes(action);
}

async function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

module.exports = { setPool, projectRole, can, isAdmin, requireAdmin, PROJECT_ROLES };
