const express = require('express');
const crypto = require('crypto');
const { ethers } = require('ethers');
const { pool } = require('../db');
const { audit } = require('../audit');

const router = express.Router();
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

// Step 1: server issues a one-time nonce bound to the address.
router.post('/challenge', async (req, res) => {
  const { address } = req.body || {};
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: 'A valid wallet address is required' });
  }
  const nonce = 'questora-' + crypto.randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO wallet_challenges (nonce, wallet_address, expires_at)
     VALUES ($1, $2, $3)`,
    [nonce, address.toLowerCase(), new Date(Date.now() + CHALLENGE_TTL_MS)]
  );
  res.json({ nonce, message: `Questora wallet verification\n\nAddress: ${address}\nNonce: ${nonce}` });
});

// Step 2: server recovers the signer with ethers, consumes the nonce once.
router.post('/verify', async (req, res) => {
  const { address, signature, nonce } = req.body || {};
  if (!address || !signature || !nonce) {
    return res.status(400).json({ error: 'Address, signature and nonce are required' });
  }
  const ch = await pool.query(
    `SELECT * FROM wallet_challenges WHERE nonce = $1 AND wallet_address = $2
       AND consumed_at IS NULL AND expires_at > NOW()`,
    [nonce, String(address).toLowerCase()]
  );
  if (!ch.rows.length) {
    return res.status(400).json({ error: 'This challenge expired or was already used. Start again.' });
  }
  let recovered;
  try {
    recovered = ethers.verifyMessage(ch.rows[0].wallet_address, signature);
  } catch {
    return res.status(400).json({ error: 'The signature could not be verified. Try again.' });
  }
  if (recovered.toLowerCase() !== String(address).toLowerCase()) {
    return res.status(400).json({ error: 'The signature does not match this address' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE wallet_challenges SET consumed_at = NOW() WHERE id = $1', [ch.rows[0].id]);
    const user = await client.query('SELECT id FROM users WHERE usernode_id = $1', [req.user.id]);
    if (!user.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
    const userId = user.rows[0].id;
    const existing = await client.query(
      'SELECT id FROM wallets WHERE address = $1', [recovered.toLowerCase()]);
    if (existing.rows.length) {
      await client.query('UPDATE wallets SET verified_at = NOW() WHERE address = $1', [recovered.toLowerCase()]);
    } else {
      await client.query(
        `INSERT INTO wallets (user_id, address, verified_at, is_primary)
         VALUES ($1, $2, NOW(), NOT EXISTS (SELECT 1 FROM wallets WHERE user_id = $1 AND verified_at IS NOT NULL))`,
        [userId, recovered.toLowerCase()]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Could not save this wallet' });
  } finally {
    client.release();
  }
  res.json({ ok: true, address: recovered.toLowerCase() });
});

router.get('/', async (req, res) => {
  const u = await pool.query('SELECT id FROM users WHERE usernode_id = $1', [req.user.id]);
  if (!u.rows.length) return res.json({ wallets: [] });
  const { rows } = await pool.query(
    `SELECT address, chain_namespace, verified_at, is_primary FROM wallets
     WHERE user_id = $1 AND verified_at IS NOT NULL ORDER BY is_primary DESC, created_at`,
    [u.rows[0].id]
  );
  res.json({ wallets: rows });
});

module.exports = router;
