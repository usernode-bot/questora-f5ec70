const { ethers } = require('ethers');
const { pool } = require('../db');

// Every verifier implements verify(ctx) -> { result: 'verified'|'rejected',
// detail }. ctx = { task, config, user, submission }. Verifiers NEVER trust
// a frontend claim of completion: quiz answers are graded here, wallet
// signatures are recovered here, social/url/manual land in the review queue.
const verifiers = {
  // Verified instantly: the server issued the nonce and recovers the signer
  // address itself (see routes/wallets.js). This verifier just records.
  wallet_connect: (ctx) => ({ result: ctx.walletVerified ? 'verified' : 'rejected', detail: { via: 'signature' } }),

  // Server-graded quiz. Config: { questions: [{ q, options, answer }],
  // pass_score: 80 } where answer is the option INDEX (never shipped to the
  // client). ctx.submission.proof_data = { answers: [0, 2, ...] }.
  quiz: (ctx) => {
    const questions = (ctx.config.questions || []);
    const answers = (ctx.submission.proof_data && ctx.submission.proof_data.answers) || [];
    if (answers.length < questions.length) return { result: 'rejected', detail: { reason: 'Incomplete answers' } };
    let correct = 0;
    for (let i = 0; i < questions.length; i++) {
      if (Number(answers[i]) === Number(questions[i].answer)) correct++;
    }
    const score = Math.round((correct / Math.max(1, questions.length)) * 100);
    const pass = score >= Number(ctx.config.pass_score || 80);
    return { result: pass ? 'verified' : 'rejected', detail: { score, pass_score: Number(ctx.config.pass_score || 80) } };
  },

  // URL/proof, social, manual: content goes to the project review queue.
  // The verifier's job is validation, not judgment.
  url_proof: (ctx) => {
    const url = ctx.submission.proof_url;
    if (!url) return { result: 'rejected', detail: { reason: 'A URL is required' } };
    try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad'); }
    catch { return { result: 'rejected', detail: { reason: 'The URL must start with http or https' } }; }
    return { result: 'pending', detail: { via: 'review' } };
  },

  social: (ctx) => ({ result: 'pending', detail: { via: 'review' } }),
  manual: (ctx) => {
    const data = ctx.submission.proof_data || {};
    if (!String(data.text || '').trim() && !ctx.submission.proof_url) {
      return { result: 'rejected', detail: { reason: 'Some proof is required' } };
    }
    return { result: 'pending', detail: { via: 'review' } };
  },
};

function verifyTask(type, ctx) {
  const v = verifiers[type];
  if (!v) return { result: 'rejected', detail: { reason: `Unknown task type: ${type}` } };
  try {
    return v(ctx);
  } catch (err) {
    return { result: 'rejected', detail: { reason: 'Verification failed. Try again.' } };
  }
}

module.exports = { verifyTask, verifiers };
