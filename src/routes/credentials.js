const express = require('express');
const { pool } = require('../db');
const { audit } = require('../audit');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Public credential page data (Phase 2). Anyone with the link can verify
// who issued it, who holds it, the criteria and the issue date. It exposes
// only already-public facts; it is reachable signed-out through the
// platform's chromeless share flow, and its API path is on the explicit
// public prefix list in server.js.
router.get('/credentials/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Credential not found' });
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.criteria, c.issued_at, c.expires_at, c.revoked_at,
            p.name AS issuer_name, p.slug AS issuer_slug, p.logo_url AS issuer_logo,
            u.username, u.display_name
     FROM credentials c
     LEFT JOIN projects p ON p.id = c.issuer_project_id
     JOIN users u ON u.id = c.recipient_user_id
     WHERE c.id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Credential not found' });
  const c = rows[0];
  res.json({
    credential: {
      id: c.id,
      title: c.title,
      criteria: c.criteria || {},
      issued_at: c.issued_at,
      expires_at: c.expires_at,
      revoked: !!c.revoked_at,
      issuer: c.issuer_name ? { name: c.issuer_name, slug: c.issuer_slug, logo_url: c.issuer_logo } : null,
      recipient: { username: c.username, display_name: c.display_name },
    },
  });
});

// The holder's own credential list (profile Credentials tab uses the
// /users/:username payload; this is the signed-in convenience route).
router.get('/users/me/credentials', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.criteria, c.issued_at, c.revoked_at, p.name AS issuer_name
     FROM credentials c LEFT JOIN projects p ON p.id = c.issuer_project_id
     WHERE c.recipient_user_id = $1 ORDER BY c.issued_at DESC`, [req.user.db_id]);
  res.json({ credentials: rows });
});

// Revoke (issuer side, audited). A revoked credential page shows it.
router.post('/credentials/:id/revoke', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Credential not found' });
  const { rows } = await pool.query('SELECT * FROM credentials WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Credential not found' });
  const cred = rows[0];
  const rbac = require('../rbac');
  const isAdmin = req.user.role === 'admin';
  const canManage = cred.issuer_project_id &&
    (await rbac.can(cred.issuer_project_id, req.user.db_id, 'manage'));
  if (!isAdmin && !canManage) {
    return res.status(403).json({ error: 'Only the issuing project can revoke this credential' });
  }
  if (cred.revoked_at) return res.json({ credential: cred });
  const updated = await pool.query(
    `UPDATE credentials SET revoked_at = NOW() WHERE id = $1 RETURNING *`,
    [cred.id]);
  await audit(req.user.db_id, 'credential.revoke', 'credential', cred.id,
    { revoked_at: null }, { revoked_at: updated.rows[0].revoked_at }, req.body && req.body.reason || null);
  res.json({ credential: updated.rows[0] });
});

module.exports = router;