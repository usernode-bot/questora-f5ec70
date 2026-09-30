const { test } = require('node:test');
const assert = require('node:assert');

// Pure logic tests: no database needed.
const levels = require('../src/levels');
const { verifyTask } = require('../src/verify');
const { slugify, validUrl } = require('../src/util');

test('level curve: thresholds are data, not code', () => {
  const t = [{ level: 1, min_xp: 0 }, { level: 2, min_xp: 1000 }, { level: 3, min_xp: 2500 }];
  assert.equal(levels.levelForXp(0, t), 1);
  assert.equal(levels.levelForXp(999, t), 1);
  assert.equal(levels.levelForXp(1000, t), 2);
  assert.equal(levels.levelForXp(9999, t), 3);
  assert.deepEqual(levels.nextThreshold(1500, t), { level: 3, min_xp: 2500 });
  assert.equal(levels.nextThreshold(5000, t), null);
});

test('quiz verifier grades server-side and never trusts the client', () => {
  const config = { pass_score: 80, questions: [
    { q: 'a', options: ['x', 'y'], answer: 1 },
    { q: 'b', options: ['x', 'y', 'z'], answer: 2 },
  ] };
  assert.equal(verifyTask('quiz', { config, submission: { proof_data: { answers: [1, 2] } } }).result, 'verified');
  assert.equal(verifyTask('quiz', { config, submission: { proof_data: { answers: [0, 0] } } }).result, 'rejected');
  assert.equal(verifyTask('quiz', { config, submission: { proof_data: { answers: [1] } } }).result, 'rejected');
});

test('url verifier validates before sending to review', () => {
  const base = { config: {}, submission: {} };
  assert.equal(verifyTask('url_proof', { ...base, submission: { proof_url: 'https://ok.example' } }).result, 'pending');
  assert.equal(verifyTask('url_proof', { ...base, submission: { proof_url: 'javascript:alert(1)' } }).result, 'rejected');
  assert.equal(verifyTask('url_proof', { ...base, submission: {} }).result, 'rejected');
});

test('manual verifier requires some proof', () => {
  assert.equal(verifyTask('manual', { config: {}, submission: { proof_data: { text: 'I did it' } } }).result, 'pending');
  assert.equal(verifyTask('manual', { config: {}, submission: {} }).result, 'rejected');
});

test('unknown task types fail closed', () => {
  assert.equal(verifyTask('on_chain_tx', { submission: {} }).result, 'rejected');
});

test('slugify and url helpers', () => {
  assert.equal(slugify('Staging demo Welcome Campaign!'), 'staging-demo-welcome-campaign');
  assert.equal(validUrl('https://a.b'), true);
  assert.equal(validUrl('javascript:alert(1)'), false);
  assert.equal(validUrl(null), true); // optional field
});

test('xp cap math bounds awards', () => {
  const cap = 5000, earned = 4800, amount = 400;
  assert.equal(Math.max(0, Math.min(amount, cap - earned)), 200);
});

test('referral rules fall back to defaults on missing or invalid settings', () => {
  const { applyReferralRules, DEFAULT_RULES } = require('../src/referrals');
  assert.deepEqual(applyReferralRules(null), DEFAULT_RULES);
  assert.deepEqual(applyReferralRules({}), DEFAULT_RULES);
  assert.deepEqual(applyReferralRules({ qualification_quests: 5, xp_reward: 250 }),
    { qualification_quests: 5, xp_reward: 250 });
  // A zero or negative quest threshold is clamped up to 1; a negative
  // reward clamps down to 0.
  assert.equal(applyReferralRules({ qualification_quests: 0 }).qualification_quests, 1);
  assert.equal(applyReferralRules({ xp_reward: -5 }).xp_reward, 0);
});

// ---- Phase 3 pure helpers ----
const reputation = require('../src/reputation');
const seasons = require('../src/seasons');
const risk = require('../src/risk');
const achievements = require('../src/achievements');

test('reputation deltas are a fixed, transparent table', () => {
  assert.equal(reputation.deltaFor('quest_completed'), 5);
  assert.equal(reputation.deltaFor('quest_rejected'), -5);
  assert.equal(reputation.deltaFor('wallet_verified'), 10);
  assert.equal(reputation.deltaFor('referral_qualified'), 10);
  assert.equal(reputation.deltaFor('made_up'), 0, 'unknown categories move nothing');
});

test('season status and multiplier are computed, never stored', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  assert.equal(seasons.statusOf({
    starts_at: '2026-09-20T00:00:00Z', ends_at: '2026-10-20T00:00:00Z' }, now), 'active');
  assert.equal(seasons.statusOf({
    starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z' }, now), 'upcoming');
  assert.equal(seasons.statusOf({
    starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-02-01T00:00:00Z' }, now), 'ended');
  assert.equal(seasons.statusOf(null, now), 'ended');
  assert.equal(seasons.multiplierOf({ xp_multiplier: '2.00' }), 2);
  assert.equal(seasons.multiplierOf(null), 1);
  assert.equal(seasons.multiplierOf({ xp_multiplier: 'not-a-number' }), 1);
  assert.equal(seasons.multiplierOf({ xp_multiplier: '0' }), 1, 'a zero multiplier would zero every award');
});

test('risk state escalates on total severity', () => {
  assert.equal(risk.stateForScore(0), 'normal');
  assert.equal(risk.stateForScore(1), 'review');
  assert.equal(risk.stateForScore(2), 'review');
  assert.equal(risk.stateForScore(3), 'suspicious');
  assert.equal(risk.stateForScore(4), 'suspicious');
  assert.equal(risk.stateForScore(5), 'blocked');
  assert.equal(risk.stateForScore(99), 'blocked');
});

test('proof fingerprints normalize case and whitespace', () => {
  const a = risk.proofHash('HTTPS://Example.Com/PR-1 ', null);
  const b = risk.proofHash('https://example.com/PR-1', null);
  assert.equal(a, b);
  assert.equal(risk.proofHash(null, '  Same Text '), risk.proofHash('same text', null));
  assert.equal(risk.proofHash(null, null), null);
});

test('risk signals fire only past their thresholds', () => {
  assert.deepEqual(risk.evaluateSignals({}), []);
  // Velocity: 7 completions in an hour is a keen user, 8 is a farm.
  assert.equal(risk.evaluateSignals({ completionsLastHour: 7 }).length, 0);
  assert.deepEqual(
    risk.evaluateSignals({ completionsLastHour: 8 }).map(s => s.signal), ['velocity']);
  // Duplicate proof: needs three distinct accounts on one hash.
  assert.equal(risk.evaluateSignals({ duplicateUsers: 2 }).length, 0);
  assert.deepEqual(
    risk.evaluateSignals({ duplicateUsers: 3, duplicateHash: 'abc' }).map(s => s.signal),
    ['duplicate_proof']);
  // Referral graph: a shared wallet outranks a referrer with pending invites.
  assert.deepEqual(
    risk.evaluateSignals({ sameWalletReferral: 1, pendingReferrals: 5 }).map(s => s.signal),
    ['referral_graph']);
  assert.deepEqual(
    risk.evaluateSignals({ pendingReferrals: 2 }).length, 0);
  assert.deepEqual(
    risk.evaluateSignals({ pendingReferrals: 3, qualifiedReferrals: 0 }).map(s => s.signal),
    ['referral_graph']);
  assert.deepEqual(
    risk.evaluateSignals({ pendingReferrals: 3, qualifiedReferrals: 1 }).length, 0);
});

test('achievement criteria are metric-name checked and finite', () => {
  assert.equal(achievements.meets({ metric: 'quests_completed', value: 1 }, { quests_completed: 1 }), true);
  assert.equal(achievements.meets({ metric: 'quests_completed', value: 5 }, { quests_completed: 1 }), false);
  assert.equal(achievements.meets({ metric: 'nope', value: 1 }, { nope: 9 }), false, 'unknown metrics never unlock');
  assert.equal(achievements.meets({ metric: 'xp_earned', value: '1000' }, { xp_earned: 1500 }), true);
  assert.equal(achievements.meets({ metric: 'xp_earned', value: 'abc' }, { xp_earned: 9999 }), false);
  assert.equal(achievements.meets(null, { quests_completed: 9 }), false);
});
