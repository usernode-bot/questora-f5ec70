const { pool } = require('./db');

// Every admin and reviewer action lands here: who, what, when, before, after.
async function audit(actorUserId, action, entityType, entityId, before, after, reason) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, before, after, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actorUserId, action, entityType, entityId || null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        reason || null]
    );
  } catch (err) {
    console.warn('audit write failed: ' + err.message);
  }
}

module.exports = { audit };
