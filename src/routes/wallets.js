const express = require('express');
const crypto = require('crypto');
const { pool, IS_STAGING } = require('../db');
const { audit } = require('../audit');
const reputation = require('../reputation');
const { adapterFor, chainChoices, MAX_ADDRESSES_PER_CHAIN } = require('../verify/wallet-chains');

const router = express.Router();
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

// The chains the link flow can speak, straight from the adapter registry so
// the picker and the verifier can never drift.
router.get('/chains', (_req, res) => {
  res.json({ chains: chainChoices(), limit: MAX_ADDRESSES_PER_CHAIN, dev: IS_STAGING });
});

class LimitError extends Error {}
function limitMessage(adapter) {
  return `Maximum ${MAX_ADDRESSES_PER_CHAIN} ${adapter.label} addresses connected. Disconnect an existing ${adapter.label} address before connecting another.`;
}
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
async function userIdFor(db, usernodeId) {
  const u = await db.query('SELECT id FROM users WHERE usernode_id = $1', [usernodeId]);
  return u.rows.length ? u.rows[0].id : null;
}
// Count a user's addresses on one chain. Inside a transaction this takes the
// same advisory lock the DB trigger uses, so the check and the insert that
// follows cannot interleave with a concurrent request.
async function countOnChain(db, userId, namespace, { lock } = {}) {
  if (lock) await db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [userId, namespace]);
  const c = await db.query('SELECT COUNT(*)::int AS n FROM wallets WHERE user_id = $1 AND chain_namespace = $2', [userId, namespace]);
  return c.rows[0].n;
}

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
  // Refuse before the user signs anything when this would be a 4th address.
  const uid = await userIdFor(pool, req.user.id);
  if (uid) {
    const owned = await pool.query(
      'SELECT 1 FROM wallets WHERE user_id = $1 AND chain_namespace = $2 AND address = $3', [uid, adapter.namespace, addr]);
    if (!owned.rows.length && (await countOnChain(pool, uid, adapter.namespace)) >= MAX_ADDRESSES_PER_CHAIN) {
      return res.status(409).json({ code: 'wallet_limit', error: limitMessage(adapter) });
    }
  }
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
  const { chain, address, signature, nonce, publicKey, signedMessage, walletId, walletName } = req.body || {};
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
    // Serialise this user's wallet writes on this chain, then re-check the
    // limit under the lock; the DB trigger is the backstop behind it.
    const count = await countOnChain(client, userId, adapter.namespace, { lock: true });
    const existing = await client.query(
      'SELECT id, user_id FROM wallets WHERE address = $1 AND chain_namespace = $2',
      [ch.rows[0].wallet_address, adapter.namespace]);
    const wid = clean(walletId, 64) || null;
    const wname = clean(walletName, 80) || null;
    let walletId_;
    if (existing.rows.length) {
      if (existing.rows[0].user_id !== userId) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This wallet is already linked to another account' });
      }
      const upd = await client.query(
        `UPDATE wallets SET verified_at = NOW(), last_used_at = NOW(),
                public_key = COALESCE($2, public_key),
                wallet_id = COALESCE($3, wallet_id), wallet_name = COALESCE($4, wallet_name)
           WHERE id = $1 RETURNING id`,
        [existing.rows[0].id, publicKey || null, wid, wname]);
      walletId_ = upd.rows[0].id;
    } else {
      if (count >= MAX_ADDRESSES_PER_CHAIN) throw new LimitError();
      // The first address on a chain starts as that chain's active address.
      const ins = await client.query(
        `INSERT INTO wallets (user_id, address, chain_namespace, public_key, verified_at, last_used_at,
                              wallet_id, wallet_name, is_active, is_primary)
         VALUES ($1::int, $2, $3::varchar, $4, NOW(), NOW(), $5, $6,
                 NOT EXISTS (SELECT 1 FROM wallets WHERE user_id = $1::int AND chain_namespace = $3::varchar AND is_active),
                 NOT EXISTS (SELECT 1 FROM wallets WHERE user_id = $1::int AND verified_at IS NOT NULL))
         RETURNING id`,
        [userId, ch.rows[0].wallet_address, adapter.namespace, publicKey || null, wid, wname]
      );
      walletId_ = ins.rows[0].id;
    }
    // Reputation (Phase 3): a verified wallet is a trust signal; the
    // UNIQUE constraint makes re-verifying the same wallet a no-op.
    await reputation.record(client, userId, 'wallet_verified', 'wallet', walletId_);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // LimitError is our own check; 23514 is the DB trigger catching anything
    // that slipped past it.
    if (err instanceof LimitError || err.code === '23514') {
      return res.status(409).json({ code: 'wallet_limit', error: limitMessage(adapter) });
    }
    console.error('[wallets] verify failed', err.message);
    return res.status(500).json({ error: 'Could not save this wallet' });
  } finally {
    client.release();
  }
  res.json({ ok: true, chain: adapter.namespace, address: ch.rows[0].wallet_address });
});

const WALLET_COLUMNS = `id, address, chain_namespace, verified_at, is_primary, is_active, label,
                        wallet_id, wallet_name, last_used_at, created_at`;
function present(w) {
  return { ...w, chain: w.chain_namespace, chain_label: (adapterFor(w.chain_namespace) || {}).label || w.chain_namespace };
}

router.get('/', async (req, res) => {
  const uid = await userIdFor(pool, req.user.id);
  if (!uid) return res.json({ wallets: [], limit: MAX_ADDRESSES_PER_CHAIN });
  const { rows } = await pool.query(
    `SELECT ${WALLET_COLUMNS} FROM wallets
     WHERE user_id = $1 AND verified_at IS NOT NULL ORDER BY chain_namespace, created_at, id`, [uid]);
  // `label` keeps its older meaning (the chain's plain name) for existing
  // callers; the user's own name for the address is `nickname`.
  res.json({
    limit: MAX_ADDRESSES_PER_CHAIN,
    wallets: rows.map((w) => ({ ...present(w), nickname: w.label, label: present(w).chain_label })),
  });
});

// Rename an address and/or make it the chain's active address.
router.patch('/:id(\\d+)', async (req, res) => {
  const { label, active } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uid = await userIdFor(client, req.user.id);
    const w = uid && (await client.query(
      'SELECT id, chain_namespace FROM wallets WHERE id = $1 AND user_id = $2 FOR UPDATE', [req.params.id, uid])).rows[0];
    if (!w) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Address not found' }); }
    if (label !== undefined) {
      await client.query('UPDATE wallets SET label = $2 WHERE id = $1', [w.id, clean(label, 40) || null]);
    }
    if (active === true) {
      await client.query('UPDATE wallets SET is_active = FALSE WHERE user_id = $1 AND chain_namespace = $2 AND is_active', [uid, w.chain_namespace]);
      await client.query('UPDATE wallets SET is_active = TRUE, last_used_at = NOW() WHERE id = $1', [w.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[wallets] update failed', err.message);
    return res.status(500).json({ error: 'Could not update this address' });
  } finally {
    client.release();
  }
  res.json({ ok: true });
});

// Remove addresses. The chain's active address and the account's primary
// wallet fall to the oldest remaining one so neither is left empty.
async function removeWallets(client, uid, where, params) {
  const gone = await client.query(`DELETE FROM wallets WHERE user_id = $1 AND ${where} RETURNING chain_namespace`, [uid, ...params]);
  for (const ns of new Set(gone.rows.map((r) => r.chain_namespace))) {
    await client.query(
      `UPDATE wallets SET is_active = TRUE WHERE id = (SELECT id FROM wallets WHERE user_id = $1 AND chain_namespace = $2
         AND verified_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wallets x WHERE x.user_id = $1 AND x.chain_namespace = $2 AND x.is_active)
         ORDER BY created_at, id LIMIT 1)`, [uid, ns]);
  }
  await client.query(
    `UPDATE wallets SET is_primary = TRUE WHERE id = (SELECT id FROM wallets WHERE user_id = $1 AND verified_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM wallets x WHERE x.user_id = $1 AND x.is_primary) ORDER BY created_at, id LIMIT 1)`, [uid]);
  return gone.rowCount;
}

async function disconnect(req, res, where, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uid = await userIdFor(client, req.user.id);
    if (!uid) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
    const n = await removeWallets(client, uid, where, params);
    if (!n && where !== 'TRUE') { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Address not found' }); }
    await client.query('COMMIT');
    res.json({ ok: true, removed: n });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[wallets] disconnect failed', err.message);
    res.status(500).json({ error: 'Could not disconnect this address' });
  } finally {
    client.release();
  }
}
router.delete('/:id(\\d+)', (req, res) => disconnect(req, res, 'id = $2', [req.params.id]));
router.delete('/', (req, res) => disconnect(req, res, 'TRUE', []));

module.exports = router;
