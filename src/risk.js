const crypto = require('crypto');
const { pool } = require('./db');

// Anti-sybil risk engine (Phase 3). Three heuristics run inside the same
// transaction that pays rewards; each writes an explainer row into
// risk_signals, and the combined severity of recent signals escalates
// users.risk_state. The engine only escalates: clearing a state is an
// admin decision (PATCH /admin/users/:id), recorded in the audit log.

const STATES = ['normal', 'review', 'suspicious', 'blocked'];
const ORDER = { normal: 0, review: 1, suspicious: 2, blocked: 3 };
const SEVERITY = { velocity: 2, duplicate_proof: 3, referral_graph: 2 };

// Escalation thresholds: 1-2 review, 3-4 suspicious, 5+ blocked.
function stateForScore(score) {
  if (score >= 5) return 'blocked';
  if (score >= 3) return 'suspicious';
  if (score >= 1) return 'review';
  return 'normal';
}

// Normalized, deterministic fingerprint of a task proof. The same link or
// text pasted by many accounts is the classic completion-farm signature.
function proofHash(proofUrl, proofText) {
  let v = String(proofUrl || '').trim().toLowerCase();
  if (!v) v = String(proofText || '').trim().toLowerCase();
  if (!v) return null;
  return crypto.createHash('sha256').update(v).digest('hex');
}

// Pure signal evaluation so the thresholds are unit-testable without a
// database. Returns the explainer rows to write.
function evaluateSignals(stats) {
  const s = stats || {};
  const signals = [];
  if ((s.completionsLastHour || 0) >= 8) {
    signals.push({
      signal: 'velocity', signal_key: 'hourly', severity: SEVERITY.velocity,
      detail: { reason: `${s.completionsLastHour} quest completions in the last hour. Humans read quests before finishing them.` },
    });
  }
  if ((s.duplicateUsers || 0) >= 3) {
    signals.push({
      signal: 'duplicate_proof', signal_key: s.duplicateHash || 'unknown', severity: SEVERITY.duplicate_proof,
      detail: { reason: `The same proof was submitted by ${s.duplicateUsers} different accounts.` },
    });
  }
  if ((s.sameWalletReferral || 0) > 0) {
    signals.push({
      signal: 'referral_graph', signal_key: 'shared_wallet', severity: 3,
      detail: { reason: 'A referral pair shares a verified wallet address. Inviting yourself is not a referral.' },
    });
  } else if ((s.pendingReferrals || 0) >= 3 && (s.qualifiedReferrals || 0) === 0) {
    signals.push({
      signal: 'referral_graph', signal_key: 'referrer', severity: SEVERITY.referral_graph,
      detail: { reason: `${s.pendingReferrals} invites, none qualified. Invites that never quest look farmed.` },
    });
  }
  return signals;
}

// Runs on the reward transaction's client. Writes explainer rows (one per
// user/signal/key, refreshed on re-run) and escalates risk_state only
// upward. Returns the state now on record plus the score behind it.
async function evaluateUser(client, userId) {
  const c = client || pool;
  const [vel, hashes, refs, wallet] = await Promise.all([
    c.query(
      `SELECT COUNT(*)::int AS n FROM quest_completions
       WHERE user_id = $1 AND completed_at > NOW() - interval '1 hour'`, [userId]),
    c.query(
      `SELECT DISTINCT proof_hash FROM task_submissions
       WHERE user_id = $1 AND proof_hash IS NOT NULL LIMIT 20`, [userId]),
    c.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'qualified')::int AS qualified
       FROM referrals WHERE referrer_user_id = $1`, [userId]),
    c.query(
      `SELECT 1 FROM referrals r
       JOIN wallets wa ON wa.user_id = r.referrer_user_id
       JOIN wallets wb ON wb.user_id = r.referee_user_id AND wb.address = wa.address
       WHERE r.referrer_user_id = $1 OR r.referee_user_id = $1
       LIMIT 1`, [userId]),
  ]);

  let duplicateUsers = 0;
  let duplicateHash = null;
  if (hashes.rows.length) {
    const dup = await c.query(
      `SELECT proof_hash, COUNT(DISTINCT user_id)::int AS users
       FROM task_submissions
       WHERE proof_hash = ANY($1) AND user_id <> $2
       GROUP BY proof_hash ORDER BY users DESC LIMIT 1`,
      [hashes.rows.map(r => r.proof_hash), userId]);
    if (dup.rows.length) {
      duplicateHash = dup.rows[0].proof_hash;
      duplicateUsers = Number(dup.rows[0].users) + 1;
    }
  }

  const signals = evaluateSignals({
    completionsLastHour: vel.rows[0].n,
    duplicateUsers,
    duplicateHash,
    pendingReferrals: refs.rows[0].pending,
    qualifiedReferrals: refs.rows[0].qualified,
    sameWalletReferral: wallet.rows.length,
  });

  for (const s of signals) {
    await c.query(
      `INSERT INTO risk_signals (user_id, signal, signal_key, severity, detail)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, signal, signal_key)
       DO UPDATE SET severity = EXCLUDED.severity, detail = EXCLUDED.detail, created_at = NOW()`,
      [userId, s.signal, s.signal_key, s.severity, JSON.stringify(s.detail)]);
  }

  // Only recent signals carry weight, so a fixed account does not stay
  // flagged forever; escalation is still monotonic until an admin resets it.
  const score = await c.query(
    `SELECT COALESCE(SUM(severity), 0)::int AS score FROM risk_signals
     WHERE user_id = $1 AND created_at > NOW() - interval '7 days'`, [userId]);
  const target = stateForScore(score.rows[0].score);
  const cur = await c.query('SELECT risk_state FROM users WHERE id = $1', [userId]);
  const currentState = cur.rows[0] ? cur.rows[0].risk_state : 'normal';
  let state = currentState;
  if (ORDER[target] > ORDER[currentState]) {
    await c.query('UPDATE users SET risk_state = $2 WHERE id = $1', [userId, target]);
    state = target;
  }
  return { state, score: score.rows[0].score, signals: signals.map(s => s.signal) };
}

// Explainer rows for the admin panel.
async function signalsFor(userId) {
  const { rows } = await pool.query(
    'SELECT id, signal, signal_key, severity, detail, created_at FROM risk_signals WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  return rows;
}

module.exports = { STATES, ORDER, SEVERITY, stateForScore, proofHash, evaluateSignals, evaluateUser, signalsFor };