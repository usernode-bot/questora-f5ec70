// The universal verification engine. It is chain-neutral: it resolves a
// task's active version, its network, token and the participant's wallet,
// then hands a normalized context to whichever chain adapter the network's
// namespace names. It never knows about chain ids, ABIs, receipts, logs or
// ERC standards; those live inside the adapter. It persists an append-only
// attempt with the raw evidence and, on VERIFIED, records the completion and
// awards task XP through the one idempotent writer.

const { pool } = require('../db');
const status = require('./status');
const { keyForResult } = require('./idempotency');
const { adapterFor, normalizeResult } = require('./chain-adapter');
const reward = require('../reward');

const COMPLETION_MODES = ['one_time', 'daily', 'weekly', 'monthly'];

// The completion period is the identity of one "slot" a state-based task can
// complete in. 'once' for one-time and limited modes; an ISO date/week/month
// otherwise. It is part of the idempotency key, never a stored counter.
function completionPeriodFor(mode, now = new Date()) {
  const m = COMPLETION_MODES.includes(mode) ? mode : 'one_time';
  const iso = now.toISOString();
  if (m === 'daily') return iso.slice(0, 10);
  if (m === 'monthly') return iso.slice(0, 7);
  if (m === 'weekly') {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 864e5) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return 'once';
}

// Load the task's active version, its project-scoped network and token.
async function resolveChainContext(task) {
  const v = await pool.query(
    `SELECT * FROM task_versions WHERE task_id = $1 ORDER BY version DESC LIMIT 1`, [task.id]);
  const version = v.rows[0] || null;
  const config = (version && version.config) || task.config || {};
  let network = null;
  let token = null;
  if (config.network_id) {
    const n = await pool.query(
      `SELECT * FROM task_networks WHERE id = $1 AND project_id = $2`, [config.network_id, task.project_id]);
    network = n.rows[0] || null;
  }
  if (config.token_id && network) {
    const tk = await pool.query(
      `SELECT * FROM task_tokens WHERE id = $1 AND network_id = $2 AND project_id = $3`,
      [config.token_id, network.id, task.project_id]);
    token = tk.rows[0] || null;
  }
  return { version, config, network, token };
}

// The caller's active verified wallet on the task's chain namespace. A chain
// identity is per-network; one string is never assumed to be another chain's.
async function resolveWallet(userId, namespace) {
  if (!namespace) return null;
  const { rows } = await pool.query(
    `SELECT * FROM wallets WHERE user_id = $1 AND chain_namespace = $2
       AND verified_at IS NOT NULL AND is_active = TRUE
     ORDER BY id LIMIT 1`, [userId, namespace]);
  return rows[0] || null;
}

// Attempt/cooldown guard. Returns null when the run may proceed, or a
// { retryAfterSeconds, reason } when the participant must wait.
async function attemptGuard(task, userId) {
  const limit = task.attempt_limit === null || task.attempt_limit === undefined ? null : Number(task.attempt_limit);
  const cooldown = Number(task.cooldown_seconds) || 0;
  const recent = await pool.query(
    `SELECT created_at FROM verification_attempts WHERE task_id = $1 AND user_id = $2
     ORDER BY created_at DESC LIMIT 1`, [task.id, userId]);
  if (cooldown && recent.rows.length) {
    const elapsed = (Date.now() - new Date(recent.rows[0].created_at).getTime()) / 1000;
    if (elapsed < cooldown) {
      return { retryAfterSeconds: Math.ceil(cooldown - elapsed), reason: 'Please wait a moment before verifying again.' };
    }
  }
  if (limit !== null) {
    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM verification_attempts WHERE task_id = $1 AND user_id = $2`, [task.id, userId]);
    if (count.rows[0].n >= limit) {
      return { reason: 'You have used all of this task\'s verification attempts.', exhausted: true };
    }
  }
  return null;
}

// Persist one attempt (append-only) plus its raw steps, then reflect the
// latest state on the participant's task_submissions row.
async function recordAttempt(task, userId, result, { walletAddress, method, latencyMs }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const input = { method, wallet_address: walletAddress, network_id: result.network ? undefined : undefined };
    const ins = await client.query(
      `INSERT INTO verification_attempts
         (task_id, task_version_id, user_id, wallet_address, chain_id, method, input, status, reason,
          evidence, rpc_url_used, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [task.id, task.current_version_id || null, userId, walletAddress || null,
        result.chainId === undefined ? null : result.chainId, method || result.method || null,
        JSON.stringify(input), result.status, result.reason || null,
        JSON.stringify({ evidence: result.evidence, rawEvidence: result.rawEvidence,
          adapter: result.adapterName, adapterVersion: result.adapterVersion,
          chainPosition: result.chainPosition, confirmations: result.confirmations,
          finality: result.finality, transactionId: result.transactionId }),
        null, latencyMs === undefined ? null : latencyMs]);
    for (const step of result.steps || []) {
      await client.query(
        `INSERT INTO verification_logs (attempt_id, step, detail) VALUES ($1, $2, $3)`,
        [ins.rows[0].id, String(step.step || 'step').slice(0, 40), JSON.stringify(step)]);
    }
    const coarse = status.classify(result.status).storedStatus;
    const existing = await client.query(
      `SELECT id FROM task_submissions WHERE task_id = $1 AND user_id = $2 AND verification_status IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`, [task.id, userId]);
    if (existing.rows.length) {
      await client.query(
        `UPDATE task_submissions SET status = $2, verification_status = $3, review_note = $4,
           proof_data = $5, task_version_id = $6, reviewed_at = NOW() WHERE id = $1`,
        [existing.rows[0].id, coarse, result.status, result.reason || null,
          JSON.stringify({ status: result.status, evidence: result.evidence }),
          task.current_version_id || null]);
    } else {
      await client.query(
        `INSERT INTO task_submissions (task_id, quest_id, user_id, proof_type, proof_data, status,
           verification_status, task_version_id, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [task.id, task.quest_id, userId, task.type,
          JSON.stringify({ status: result.status, evidence: result.evidence }),
          coarse, result.status, task.current_version_id || null]);
    }
    await client.query('COMMIT');
    return ins.rows[0].id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Pure evaluation: given an already-resolved chain context, pick the adapter
// and get a normalized result. No database access, so the engine can be
// unit-tested against an injected context and a fake adapter/pool.
async function evaluateVerification({ task, config, network, token, wallet, submission }) {
  const method = (config && config.method) || null;
  const adapter = network ? adapterFor(network.chain_namespace) : null;
  if (!adapter || !method || !adapter.supportsMethod(method)) {
    return normalizeResult({
      status: 'MANUAL_REVIEW',
      reason: !adapter
        ? 'This network has no verification adapter yet, so the project team will review it.'
        : 'This task type is not yet supported on this network.',
    }, adapter || { name: 'none' });
  }
  return adapter.verify({ method, config, network, token, wallet, submission: submission || {}, adapter, task });
}

// The whole flow: resolve, guard, evaluate, persist, and on VERIFIED hand off
// to the idempotent completion writer. Returns { status, reason, evidence,
// attemptId, completion, result }.
async function runVerification({ task, userId, transactionHash }) {
  const started = Date.now();
  const { config, network, token } = await resolveChainContext(task);
  const namespace = network ? network.chain_namespace : null;
  const wallet = await resolveWallet(userId, namespace);
  const walletAddress = wallet ? wallet.address : null;
  const method = (config && config.method) || null;

  const result = await evaluateVerification({
    task, config, network, token, wallet, submission: { transaction_hash: transactionHash },
  });
  const attemptId = await recordAttempt(task, userId, result, { walletAddress, method: result.method || method, latencyMs: Date.now() - started });

  let completion = null;
  if (result.status === 'VERIFIED') {
    const period = completionPeriodFor(task.completion_mode);
    const idempotencyKey = result.transactionId
      ? keyForResult(result, { userId, taskId: task.id, completionPeriod: period })
      : keyForResult({ transactionId: null }, { userId, taskId: task.id, completionPeriod: period });
    completion = await reward.completeTask({
      task, versionId: task.current_version_id, userId, walletAddress,
      chainId: result.chainId, method: result.method || method, evidence: result.evidence,
      completionPeriod: period, idempotencyKey, xpReward: task.xp_reward,
    });
  }
  return { status: result.status, reason: result.reason, evidence: result.evidence, attemptId, completion, result };
}

module.exports = { runVerification, evaluateVerification, resolveChainContext, resolveWallet, completionPeriodFor, attemptGuard, recordAttempt, COMPLETION_MODES };
