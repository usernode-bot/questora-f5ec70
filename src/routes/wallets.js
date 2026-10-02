const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { audit } = require('../audit');
const reputation = require('../reputation');
const { adapterFor, chainChoices } = require('../verify/wallet-chains');

const router = express.Router();
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

// The chains the link flow can speak, straight from the adapter registry so
// the picker and the verifier can never drift.
router.get('/chains', (_req, res) => {
  res.json({ chains: chainChoices() });
});

// Step 1: server issues a one-time nonce bound to (address, chain). The exact
// string the user signs is produced by the chain's adapter and rebuilt here
// at verify time, so the verifier works from what was ACTUALLY signed.
router.post('/challenge', async (req, res) => {
  const { chain, address } = req.body || {};
  const adapter = adapterFor(chain);
  if (!adapter) return res.status(400).json({ error: 'Choose a supported chain' });
  if (!adapter.validateAddress(address)) {
    return res.status(400).json({ error: `That does not look like a ${adapter.label} address` });
  }
  const addr = adapter.normalizeAddress(address);
  const nonce = 'questora-' + crypto.randomBytes(16).toString('hex');
  const message = adapter.buildMessage(addr, nonce);
  await pool.query(
    `INSERT INTO wallet_challenges (nonce, wallet_address, chain_namespace, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [nonce, addr, adapter.namespace, new Date(Date.now() + CHALLENGE_TTL_MS)]
  );
  res.json({ chain: adapter.namespace, nonce, message });
});

// Step 2: verify the signature with the chain's adapter, then attach the
// wallet to the caller in one transaction. One address per chain belongs to
// exactly one account; a wallet already owned elsewhere is refused, never
// reassigned.
router.post('/verify', async (req, res) => {
  const { chain, address, signature, nonce, publicKey, signedMessage } = req.body || {};
  const adapter = adapterFor(chain);
  if (!adapter) return res.status(400).json({ error: 'Choose a supported chain' });
  if (!address || !signature || !nonce) {
    return res.status(400).json({ error: 'Address, signature and nonce are required' });
  }
  const addr = adapter.normalizeAddress(address);
  const ch = await pool.query(
    `SELECT * FROM wallet_challenges
       WHERE nonce = $1 AND wallet_address = $2 AND chain_namespace = $3
         AND consumed_at IS NULL AND expires_at > NOW()`,
    [nonce, addr, adapter.namespace]
  );
  if (!ch.rows.length) {
    return res.status(400).json({ error: 'This challenge expired or was already used. Start again.' });
  }
  // Rebuild the message from the STORED challenge, never from the request.
  // Some wallets (Aptos) sign their own prefixed wrapper; when the connector
  // hands that back we verify over it, but ONLY if it still carries this
  // challenge's nonce and address, so the binding cannot be forged.
  const stored = ch.rows[0].wallet_address;
  const message = adapter.buildMessage(stored, nonce);
  const boundSigned = typeof signedMessage === 'string'
    && signedMessage.includes(nonce) && signedMessage.includes(stored) ? signedMessage : null;
  let ok = false;
  try {
    ok = !!adapter.verify({ address: addr, message: boundSigned || message, signature, publicKey });
    if (!ok && boundSigned) ok = !!adapter.verify({ address: addr, message, signature, publicKey });
  } catch {
    ok = false;
  }
  if (!ok) {
    return res.status(400).json({ error: 'The signature could not be verified. Try again.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE wallet_challenges SET consumed_at = NOW() WHERE id = $1', [ch.rows[0].id]);
    const user = await client.query('SELECT id FROM users WHERE usernode_id = $1', [req.user.id]);
    if (!user.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
    const userId = user.rows[0].id;
    const existing = await client.query(
      'SELECT id, user_id FROM wallets WHERE address = $1 AND chain_namespace = $2',
      [ch.rows[0].wallet_address, adapter.namespace]);
    let walletId;
    if (existing.rows.length) {
      if (existing.rows[0].user_id !== userId) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This wallet is already linked to another account' });
      }
      const upd = await client.query(
        `UPDATE wallets SET verified_at = NOW(), public_key = COALESCE($2, public_key)
           WHERE id = $1 RETURNING id`,
        [existing.rows[0].id, publicKey || null]);
      walletId = upd.rows[0].id;
    } else {
      const ins = await client.query(
        `INSERT INTO wallets (user_id, address, chain_namespace, public_key, verified_at, is_primary)
         VALUES ($1, $2, $3, $4, NOW(),
                 NOT EXISTS (SELECT 1 FROM wallets WHERE user_id = $1 AND verified_at IS NOT NULL))
         RETURNING id`,
        [userId, ch.rows[0].wallet_address, adapter.namespace, publicKey || null]
      );
      walletId = ins.rows[0].id;
    }
    // Reputation (Phase 3): a verified wallet is a trust signal; the
    // UNIQUE constraint makes re-verifying the same wallet a no-op.
    await reputation.record(client, userId, 'wallet_verified', 'wallet', walletId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Could not save this wallet' });
  } finally {
    client.release();
  }
  res.json({ ok: true, chain: adapter.namespace, address: ch.rows[0].wallet_address });
});

router.get('/', async (req, res) => {
  const u = await pool.query('SELECT id FROM users WHERE usernode_id = $1', [req.user.id]);
  if (!u.rows.length) return res.json({ wallets: [] });
  const { rows } = await pool.query(
    `SELECT address, chain_namespace, verified_at, is_primary FROM wallets
     WHERE user_id = $1 AND verified_at IS NOT NULL ORDER BY is_primary DESC, created_at`,
    [u.rows[0].id]
  );
  res.json({
    wallets: rows.map(w => ({
      ...w,
      chain: w.chain_namespace,
      label: (adapterFor(w.chain_namespace) || {}).label || w.chain_namespace,
    })),
  });
});

module.exports = router;
