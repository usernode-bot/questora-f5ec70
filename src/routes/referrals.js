const express = require('express');
const { pool } = require('../db');
const referrals = require('../referrals');

const router = express.Router();

// My invite code + who I invited, for the profile's invite block.
router.get('/referrals/me', async (req, res) => {
  const s = await referrals.summary(req.user.db_id);
  res.json(s);
});

// Invite preview: resolve a code to the referrer's public username so the
// join page can say who invited you before you commit. Usernames are
// already public profile keys, so this leaks nothing.
router.get('/referrals/preview/:code', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT username FROM users WHERE ref_code = $1', [req.params.code]);
  if (!rows.length) return res.status(404).json({ error: 'This invite code is not valid' });
  res.json({ username: rows[0].username });
});

// Claim someone's invite code. One referral per referee, ever; the
// qualification rule (referee completes N quests) is checked server-side at
// claim time and again on every quest completion.
router.post('/referrals/claim', async (req, res) => {
  const result = await referrals.claim(req.body && req.body.code, req.user.db_id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

module.exports = router;