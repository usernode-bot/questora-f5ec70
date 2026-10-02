const { pool } = require('./db');

// Every admin and reviewer action lands here: who, what, when, before, after.
// The seventh argument is either a reason string (platform actions) or a
// metadata object (project access changes, which carry the target user and the
// previous/new role). Only one of `reason` / `metadata` is ever set per call.
async function audit(actorUserId, action, entityType, entityId, before, after, reasonOrMetadata) {
  let reason = null;
  let metadata = {};
  if (reasonOrMetadata && typeof reasonOrMetadata === 'object') metadata = reasonOrMetadata;
  else if (reasonOrMetadata !== undefined && reasonOrMetadata !== null) reason = reasonOrMetadata;
  try {
    await pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, before, after, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [actorUserId, action, entityType, entityId || null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        reason,
        JSON.stringify(metadata)]
    );
  } catch (err) {
    console.warn('audit write failed: ' + err.message);
  }
}

module.exports = { audit };
