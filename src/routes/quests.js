const express = require('express');
const { pool } = require('../db');
const { verifyTask } = require('../verify');
const { adapterFor } = require('../verify/chain-adapter');
const reward = require('../reward');
const risk = require('../risk');
const { lockState } = require('../conditions');
const engine = require('../verify/engine');
const statusMod = require('../verify/status');
const QB = require('../../public/quest-builder.js');

const router = express.Router();
function userId(req) { return req.user.db_id; }

// Anti-sybil (Phase 3): an account the engine has escalated to blocked
// cannot submit anything until an admin clears the state.
async function blocked(uid) {
  const { rows } = await pool.query('SELECT risk_state FROM users WHERE id = $1', [uid]);
  return rows[0] && rows[0].risk_state === 'blocked';
}

// Simple in-memory rate limit on submissions: 10 per minute per user.
const rateBuckets = new Map();
function rateLimited(userIdVal) {
  const now = Date.now();
  const b = rateBuckets.get(userIdVal) || [];
  const recent = b.filter(t => now - t < 60_000);
  if (recent.length >= 10) return true;
  recent.push(now);
  rateBuckets.set(userIdVal, recent);
  return false;
}

// ---- creator-side draft validation + answer hygiene ----
// The one rule table for a quest draft lives in public/quest-builder.js
// (questDraftRules / validateQuestDraft) so the browser and the server grade
// the same inputs the same way. This adapter maps the API payload onto that
// draft shape and overlays the structural checks a server must still own.
function draftFromPayload(body) {
  body = body || {};
  var tasks = Array.isArray(body.tasks) ? body.tasks : [];
  var t = tasks[0] || null;
  var config = (t && t.config) || {};
  return {
    title: body.title,
    xp_reward: body.xp_reward,
    task_choice: t ? QB.choiceForTask(t) : null,
    task_url: config.url !== undefined ? config.url : (t && t.type === 'url_proof' ? config.placeholder : ''),
    task_network_id: config.network_id === undefined || config.network_id === null ? '' : String(config.network_id),
    task_network_name: config.network_name || '',
    task_instructions: config.instructions || '',
    quiz_pass_score: config.pass_score,
    quiz_questions: config.questions,
  };
}

// Returns { ok, errors } for a create/update quest payload, or null when the
// payload carries no tasks (an update that only touches quest fields, which the
// per-task routes validate instead). The error keys are the same field names
// public/quest-builder.js returns, so the client can place each message.
//
// Two tiers, matching the builder:
//   - structural checks always apply (a quiz must be gradeable, a social task's
//     link must be a link, an on-chain task must name a network and a method);
//   - the builder's own field-level rules apply to a body the wizard sent
//     (`draft: true`), so the two sides grade the same form the same way.
function validateQuestPayload(body) {
  if (!body || !Array.isArray(body.tasks) || !body.tasks.length) return null;
  var tasks = body.tasks;
  var errors = {};

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i] || {};
    var cfg = t.config || {};
    if (t.type === 'quiz') {
      // Reuse the shared rules for the gradeable shape and their exact messages.
      var qRes = QB.validateQuestDraft({ title: 'x', xp_reward: 1, task_choice: 'quiz', quiz_questions: cfg.questions, quiz_pass_score: cfg.pass_score });
      for (var qf in qRes.errors) if (!errors[qf]) errors[qf] = qRes.errors[qf];
      if (!errors.quiz_questions && Array.isArray(cfg.questions)) {
        if (cfg.questions.length > 100) errors.quiz_questions = 'A quiz can have at most 100 questions';
        else for (var j = 0; j < cfg.questions.length; j++) {
          var opts = (cfg.questions[j] || {}).options;
          if (Array.isArray(opts) && opts.some(function (o) { return !String(o || '').trim(); })) {
            errors['quiz_questions[' + j + ']'] = 'Question ' + (j + 1) + ': every option needs text';
            break;
          }
        }
      }
    } else if (t.type === 'url_proof') {
      // A builder-side placeholder is optional hint text, never required.
      if (cfg.placeholder !== undefined && cfg.placeholder !== null && cfg.placeholder !== '' && typeof cfg.placeholder !== 'string') {
        errors.task_url = 'The proof hint must be text';
      }
    } else if (t.type === 'social') {
      if (cfg.url === undefined || cfg.url === null || cfg.url === '' || !QB.isValidHttpUrl(cfg.url)) {
        errors.task_url = 'The social link must start with http:// or https://';
      }
      if (cfg.action !== undefined && cfg.action !== null && cfg.action !== '' && ['visit', 'join', 'follow'].indexOf(cfg.action) < 0) {
        errors.task_action = 'Unknown social action';
      }
    } else if (t.type === 'on_chain') {
      if (cfg.network_id === undefined || cfg.network_id === null || cfg.network_id === '' || !Number.isFinite(Number(cfg.network_id))) {
        errors.task_network_id = 'Choose a network for this task';
      }
      if (!['native_balance', 'erc20_balance', 'transaction'].includes(cfg.method)) {
        errors.task_network_id = 'Choose a supported verification method';
      }
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors: errors };

  if (body.draft !== true) return { ok: true, errors: {} };
  var shared = QB.validateQuestDraft(draftFromPayload(body));
  for (var f in shared.errors) if (!errors[f]) errors[f] = shared.errors[f];
  return { ok: Object.keys(errors).length === 0, errors: errors };
}

// The correct-answer index must never leave the server: strip it from any quiz
// config in a response body. Recurses through plain arrays and objects, so it
// covers a task, a version row, a quest's task list and a nested payload.
function stripQuizAnswersDeep(value, depth) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(function (v) { return stripQuizAnswersDeep(v, (depth || 0) + 1); });
  if (typeof value !== 'object') return value;
  if ((depth || 0) > 8) return value;
  var out = {};
  for (var k in value) {
    if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
    out[k] = stripQuizAnswersDeep(value[k], (depth || 0) + 1);
  }
  if (out.type === 'quiz' && out.config && typeof out.config === 'object') {
    out.config = QB.stripQuizAnswers(out.config);
  }
  return out;
}

// All my task states for one quest: which tasks are verified/pending/rejected.
router.get('/quests/:id/my', async (req, res) => {
  const states = await pool.query(
    `SELECT t.id AS task_id, s.status, s.verification_status, s.review_note, s.proof_url,
            s.created_at, s.reviewed_at,
            (SELECT reason FROM verification_attempts a
              WHERE a.task_id = t.id AND a.user_id = $2 ORDER BY a.created_at DESC LIMIT 1) AS verification_reason
     FROM quest_tasks t
     LEFT JOIN LATERAL (
       SELECT * FROM task_submissions s
       WHERE s.task_id = t.id AND s.user_id = $2
       ORDER BY s.created_at DESC LIMIT 1
     ) s ON TRUE
     WHERE t.quest_id = $1 ORDER BY t.sort_order`, [req.params.id, userId(req)]);
  res.json({ states: states.rows });
});

// Submit a task. Wallet tasks verified via signature; quizzes graded here;
// everything else lands in Pending review.
router.post('/tasks/:id/submit', async (req, res) => {
  const uid = userId(req);
  if (rateLimited(uid)) return res.status(429).json({ error: 'Too many submissions. Wait a moment.' });
  if (await blocked(uid)) return res.status(403).json({ error: 'Your account is restricted. Ask an admin to review it.' });
  const t = await pool.query('SELECT * FROM quest_tasks WHERE id = $1', [req.params.id]);
  if (!t.rows.length) return res.status(404).json({ error: 'Task not found' });
  const task = t.rows[0];
  const quest = await pool.query('SELECT id, status FROM quests WHERE id = $1', [task.quest_id]);
  if (!quest.rows.length || quest.rows[0].status !== 'active') {
    return res.status(400).json({ error: 'This quest is not open for submissions' });
  }
  const done = await pool.query('SELECT 1 FROM quest_completions WHERE quest_id = $1 AND user_id = $2', [task.quest_id, uid]);
  if (done.rows.length) return res.status(400).json({ error: 'You already completed this quest' });

  // Locked quests stay locked on the server: a prerequisite condition the
  // frontend displays is also enforced here.
  const lock = await lockState(task.quest_id, uid);
  if (lock.locked) return res.status(403).json({ error: lock.reason });

  // One live submission per task: a pending or already-verified task cannot
  // be resubmitted (rejected ones can, that is the resubmit flow).
  const latest = await pool.query(
    `SELECT status FROM task_submissions WHERE task_id = $1 AND user_id = $2
     ORDER BY created_at DESC LIMIT 1`, [task.id, uid]);
  if (latest.rows.length && latest.rows[0].status === 'pending') {
    return res.status(400).json({ error: 'Your submission is awaiting review' });
  }
  if (latest.rows.length && latest.rows[0].status === 'verified') {
    return res.status(400).json({ error: 'This task is already verified' });
  }

  const submission = {
    proof_url: req.body.proof_url || null,
    proof_data: req.body.proof_data || null,
  };
  const ctx = {
    task,
    config: task.config || {},
    user: req.user,
    submission,
    walletVerified: false,
  };

  if (task.type === 'wallet_connect') {
    // Wallet tasks verify against the wallets table, not a frontend claim.
    const w = await pool.query(
      `SELECT id FROM wallets WHERE user_id = $1 AND verified_at IS NOT NULL LIMIT 1`, [uid]);
    if (!w.rows.length) {
      return res.status(400).json({ error: 'Connect and verify a wallet first' });
    }
    ctx.walletVerified = true;
  }

  const verdict = await verifyTask(task.type, ctx);
  const status = verdict.result === 'pending' ? 'pending' : verdict.result;
  // Anti-sybil (Phase 3): a normalized fingerprint of the proof, so the
  // risk engine can spot the same link or text submitted by many accounts.
  const proofHash = risk.proofHash(
    submission.proof_url,
    submission.proof_data && submission.proof_data.text);
  if (status === 'rejected') {
    await pool.query(
      `INSERT INTO task_submissions (task_id, quest_id, user_id, proof_type, proof_url, proof_data, status, review_note, reviewed_at, proof_hash)
       VALUES ($1, $2, $3, $4, $5, $6, 'rejected', $7, NOW(), $8)`,
      [task.id, task.quest_id, uid, task.type, submission.proof_url,
        submission.proof_data ? JSON.stringify(submission.proof_data) : null,
        (verdict.detail && verdict.detail.reason) || 'Rejected', proofHash]
    );
    return res.status(400).json({ error: (verdict.detail && verdict.detail.reason) || 'Rejected' });
  }

  const ins = await pool.query(
    `INSERT INTO task_submissions (task_id, quest_id, user_id, proof_type, proof_url, proof_data, status, proof_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, status`,
    [task.id, task.quest_id, uid, task.type, submission.proof_url,
      submission.proof_data ? JSON.stringify(submission.proof_data) : null, status, proofHash]
  );
  await pool.query(
    `INSERT INTO verification_events (submission_id, verifier, result, detail)
     VALUES ($1, $2, $3, $4)`,
    [ins.rows[0].id, task.type, status, JSON.stringify(verdict.detail || {})]
  );

  let completion = null;
  if (status === 'verified') {
    completion = await reward.completeQuest(task.quest_id, uid);
  }
  res.json({ submission: ins.rows[0], completion });
});

// Verify Now for an on-chain task. Separate from /submit so the one-live-
// submission and quest-completion guards never block a re-verify after a
// WAITING_CONFIRMATIONS result. Runs the universal engine, appends an attempt,
// updates the participant's latest state, and pays task XP on VERIFIED.
router.post('/tasks/:id/verify', async (req, res) => {
  const uid = userId(req);
  if (await blocked(uid)) return res.status(403).json({ error: 'Your account is restricted. Ask an admin to review it.' });
  const t = await pool.query(
    `SELECT t.*, q.status AS quest_status FROM quest_tasks t JOIN quests q ON q.id = t.quest_id WHERE t.id = $1`,
    [req.params.id]);
  if (!t.rows.length) return res.status(404).json({ error: 'Task not found' });
  const task = t.rows[0];
  if (task.type !== 'on_chain') return res.status(400).json({ error: 'This task is not verified automatically' });
  if (task.quest_status !== 'active') return res.status(400).json({ error: 'This quest is not open' });

  // A verified task cannot be re-verified into a second payment.
  const already = await pool.query(
    `SELECT 1 FROM task_submissions WHERE task_id = $1 AND user_id = $2 AND verification_status = 'VERIFIED' LIMIT 1`,
    [task.id, uid]);
  if (already.rows.length) return res.status(400).json({ error: 'This task is already verified' });

  // Cooldown / attempt limit. Exhausted is a soft answer, not an error.
  const guard = await engine.attemptGuard(task, uid);
  if (guard) {
    return res.status(guard.exhausted ? 429 : 429).json({
      error: guard.reason, retry_after_seconds: guard.retryAfterSeconds || null, exhausted: !!guard.exhausted,
    });
  }

  // No wallet on this network is a participant-side prerequisite, answered
  // before the engine runs. Only when a chain adapter can actually verify
  // this task: a task on a chain with no adapter still returns MANUAL_REVIEW
  // rather than demanding a wallet. Matches the existing wallet task flow.
  const ctx = await engine.resolveChainContext(task);
  const adapter = ctx.network ? adapterFor(ctx.network.chain_namespace) : null;
  const method = ctx.config && ctx.config.method;
  if (adapter && method && adapter.supportsMethod(method)) {
    const wallet = await engine.resolveWallet(uid, ctx.network.chain_namespace);
    if (!wallet) return res.status(400).json({ error: 'Connect a wallet on this network first' });
  }

  const run = await engine.runVerification({ task, userId: uid, transactionHash: req.body && req.body.transaction_hash });
  const classified = statusMod.classify(run.status);
  res.json({
    status: run.status, verified: run.status === 'VERIFIED', reason: run.reason,
    tone: classified.tone, label: classified.label,
    attempt_id: run.attemptId, completion: run.completion || null,
    chain_position: run.result ? run.result.chainPositionLabel : null,
    confirmations: run.result ? run.result.confirmations : null,
    finality: run.result ? run.result.finality : null,
    transaction_id: run.result ? run.result.transactionId : null,
  });
});

// Poll the caller's latest verification state after WAITING_CONFIRMATIONS.
router.get('/tasks/:id/status', async (req, res) => {
  const uid = userId(req);
  const t = await pool.query('SELECT id, quest_id, current_version_id FROM quest_tasks WHERE id = $1', [req.params.id]);
  if (!t.rows.length) return res.status(404).json({ error: 'Task not found' });
  const sub = await pool.query(
    `SELECT status, verification_status, review_note, created_at FROM task_submissions
     WHERE task_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`, [t.rows[0].id, uid]);
  const attempt = await pool.query(
    `SELECT status, reason, evidence, created_at FROM verification_attempts
     WHERE task_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`, [t.rows[0].id, uid]);
  const latest = attempt.rows[0] || null;
  const verificationStatus = (sub.rows[0] && sub.rows[0].verification_status)
    || (latest && latest.status) || null;
  const classified = verificationStatus ? statusMod.classify(verificationStatus) : null;
  res.json({
    status: verificationStatus, verified: verificationStatus === 'VERIFIED',
    reason: (latest && latest.reason) || (sub.rows[0] && sub.rows[0].review_note) || null,
    label: classified ? classified.label : null, tone: classified ? classified.tone : null,
    submission_status: sub.rows[0] ? sub.rows[0].status : null,
    attempts: attempt.rows.length, checked_at: latest ? latest.created_at : null,
  });
});

// Quiz grading endpoint (answers come in, never out).
router.post('/quests/:id/quiz', async (req, res) => {
  const uid = userId(req);
  if (await blocked(uid)) return res.status(403).json({ error: 'Your account is restricted. Ask an admin to review it.' });
  const taskId = Number(req.body.task_id);
  const t = await pool.query(
    `SELECT * FROM quest_tasks WHERE id = $1 AND quest_id = $2 AND type = 'quiz'`,
    [taskId, req.params.id]);
  if (!t.rows.length) return res.status(404).json({ error: 'Quiz not found' });
  const task = t.rows[0];
  const lock = await lockState(task.quest_id, uid);
  if (lock.locked) return res.status(403).json({ error: lock.reason });
  const verdict = await verifyTask('quiz', {
    task, config: task.config, user: req.user,
    submission: { proof_data: { answers: req.body.answers || [] } },
  });
  const status = verdict.result === 'verified' ? 'verified' : 'rejected';
  const ins = await pool.query(
    `INSERT INTO task_submissions (task_id, quest_id, user_id, proof_type, proof_data, status, review_note, reviewed_at)
     VALUES ($1, $2, $3, 'quiz', $4, $5, $6, NOW()) RETURNING id`,
    [task.id, task.quest_id, uid, JSON.stringify({ answers: req.body.answers || [] }), status,
      status === 'rejected' ? `Score ${verdict.detail.score}% (needs ${verdict.detail.pass_score}%)` : null]
  );
  await pool.query(
    `INSERT INTO verification_events (submission_id, verifier, result, detail) VALUES ($1, 'quiz', $2, $3)`,
    [ins.rows[0].id, status, JSON.stringify(verdict.detail)]
  );
  let completion = null;
  if (status === 'verified') completion = await reward.completeQuest(task.quest_id, uid);
  res.json({ score: verdict.detail.score, pass_score: verdict.detail.pass_score, passed: status === 'verified', completion });
});

// Join a campaign: records the participant marker in user_settings
// (completions drive real participation; joining tracks interest).
router.post('/campaigns/:id/join', async (req, res) => {
  const uid = userId(req);
  const c = await pool.query('SELECT id FROM campaigns WHERE id = $1 AND status = $2', [req.params.id, 'active']);
  if (!c.rows.length) return res.status(400).json({ error: 'This campaign is not active' });
  const campaignId = Number(req.params.id);
  const cur = await pool.query(
    `SELECT notify->'joined_campaigns' AS j FROM user_settings WHERE user_id = $1`, [uid]);
  const list = Array.isArray(cur.rows[0] && cur.rows[0].j) ? cur.rows[0].j : [];
  if (!list.includes(campaignId)) list.push(campaignId);
  await pool.query(
    `INSERT INTO user_settings (user_id, notify) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET notify = user_settings.notify || $2, updated_at = NOW()`,
    [uid, JSON.stringify({ joined_campaigns: list })]
  );
  res.json({ ok: true, joined: true });
});

module.exports = router;
module.exports.validateQuestDraft = QB.validateQuestDraft;
module.exports.validateQuestPayload = validateQuestPayload;
module.exports.stripQuizAnswersDeep = stripQuizAnswersDeep;
module.exports.draftFromPayload = draftFromPayload;
