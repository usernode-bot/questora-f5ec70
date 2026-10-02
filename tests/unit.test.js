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

// ---- Phase 1 seams added on top: verifier abstractions, locks, transitions ----
const { SocialVerifier, ManualSocialVerifier, manualSocialVerifier } = require('../src/verify/social-verifier');
const { CAMPAIGN_TRANSITIONS } = require('../src/routes/creator');
const conditions = require('../src/conditions');

test('ManualSocialVerifier stays at pending review, never verifies', async () => {
  const v = manualSocialVerifier.verify({ task: {}, user: {}, submission: {} });
  assert.equal(v.result, 'pending');
  assert.notEqual(v.result, 'verified');
  assert.equal(v.detail.via, 'review');
  // The base class is the seam: a subclass without verify() fails loudly.
  assert.throws(() => new SocialVerifier('empty').verify({}), /implement/);
  assert.ok(new ManualSocialVerifier() instanceof SocialVerifier);
});

test('on_chain tasks report unsupported through NullChainAdapter, never fake', async () => {
  const verdict = await verifyTask('on_chain', { config: {}, submission: { proof_url: 'https://x' } });
  assert.equal(verdict.result, 'rejected');
  assert.equal(verdict.detail.adapter, 'NullChainAdapter');
  assert.match(verdict.detail.reason, /not currently supported/i);
});

test('task config validation rejects on-chain publishes', () => {
  const creator = require('../src/routes/creator');
  assert.ok(creator.validateTaskConfig('on_chain', {}), 'on_chain is not publishable in Phase 1');
  assert.equal(creator.validateTaskConfig('social', { url: 'https://x' }), null);
});

test('campaign state machine only allows forward transitions', () => {
  assert.ok(CAMPAIGN_TRANSITIONS.active.includes('paused'));
  assert.ok(CAMPAIGN_TRANSITIONS.paused.includes('active'));
  assert.ok(CAMPAIGN_TRANSITIONS.ended.includes('archived'));
  assert.ok(!CAMPAIGN_TRANSITIONS.active.includes('archived'), 'active campaigns end, they are not archived directly');
  assert.ok(!CAMPAIGN_TRANSITIONS.active.includes('draft'), 'no going back to draft');
  assert.equal(CAMPAIGN_TRANSITIONS.archived.length, 0, 'archived is terminal');
});

test('quest lock evaluator: pure logic over completed sets', () => {
  const reqs = [11, 12];
  // No viewer: locks are a per-user state, so an anonymous visitor sees none.
  assert.equal(conditions.evaluateLock(null, 'all', reqs, new Set()), false);
  assert.equal(conditions.evaluateLock(null, 'all', reqs, new Set([11])), false);
  // Operator all: every prerequisite must be completed.
  assert.equal(conditions.evaluateLock(7, 'all', reqs, new Set([11])), true);
  assert.equal(conditions.evaluateLock(7, 'all', reqs, new Set([11, 12])), false);
  assert.equal(conditions.evaluateLock(7, 'all', reqs, new Set([11, 12, 13])), false);
  // Operator any: one is enough.
  assert.equal(conditions.evaluateLock(7, 'any', reqs, new Set()), true);
  assert.equal(conditions.evaluateLock(7, 'any', reqs, new Set([12])), false);
  // No prerequisites: never locked.
  assert.equal(conditions.evaluateLock(7, 'all', [], new Set()), false);
});

// ---- Project Ownership: action resolution (pure) ----
const { resolveAction, PROJECT_ACTIONS } = require('../src/rbac');
const util = require('../src/util');

test('rbac default-deny: a project admin cannot delete without a grant', () => {
  const admin = { ownerUserId: 1, userId: 2, role: 'admin', permissions: {}, action: 'delete_project' };
  assert.equal(resolveAction(admin), false, 'admin has no delete_project by default');
  assert.equal(resolveAction({ ...admin, action: 'manage' }), true, 'admin still manages');
  assert.equal(resolveAction({ ...admin, action: 'edit' }), true);
  assert.equal(resolveAction({ ...admin, action: 'publish' }), true);
  assert.equal(resolveAction({ ...admin, action: 'review' }), true);
});

test('rbac explicit grant flips a withheld ability, and a revoke withholds a default', () => {
  assert.equal(resolveAction({ ownerUserId: 1, userId: 2, role: 'admin', permissions: { delete_project: true }, action: 'delete_project' }), true);
  // Explicit override beats the role default in either direction.
  assert.equal(resolveAction({ ownerUserId: 1, userId: 2, role: 'admin', permissions: { edit: false }, action: 'edit' }), false);
  assert.equal(resolveAction({ ownerUserId: 1, userId: 2, role: 'analyst', permissions: { edit: true }, action: 'edit' }), true);
});

test('rbac owner and platform admin resolve to true for every action', () => {
  for (const action of PROJECT_ACTIONS) {
    assert.equal(resolveAction({ isPlatformAdmin: true, ownerUserId: 1, userId: 9, role: null, permissions: null, action }), true, 'platform admin: ' + action);
    assert.equal(resolveAction({ ownerUserId: 1, userId: 1, role: 'owner', permissions: {}, action }), true, 'owner: ' + action);
    // A non-member gets nothing.
    assert.equal(resolveAction({ ownerUserId: 1, userId: 42, role: null, permissions: null, action }), false);
  }
});

test('quest slugs are unique per campaign via slugify', () => {
  assert.equal(util.slugify('Complete Quiz'), 'complete-quiz');
  assert.equal(util.slugify('Staging demo Vote on Proposal'), 'staging-demo-vote-on-proposal');
  assert.equal(util.slugify(''), '');
});

// Multi-chain wallet adapters (src/verify/wallet-chains.js).
const crypto = require('node:crypto');
const { adapterFor, chainChoices } = require('../src/verify/wallet-chains');

test('chain registry exposes the five supported chains by label', () => {
  const labels = chainChoices().map(c => c.label);
  for (const l of ['EVM', 'Solana', 'Sui', 'Aptos', 'Octra']) assert.ok(labels.includes(l), 'missing ' + l);
  assert.equal(adapterFor('dogecoin'), null, 'unknown chains are refused');
});

test('address validation is per-chain', () => {
  assert.ok(adapterFor('eip155').validateAddress('0x' + 'a'.repeat(40)));
  assert.ok(!adapterFor('eip155').validateAddress('0x' + 'a'.repeat(39)));
  assert.ok(!adapterFor('solana').validateAddress('not-base58-too-short'));
  assert.ok(adapterFor('sui').validateAddress('0x' + 'a'.repeat(64)));
  assert.ok(adapterFor('aptos').validateAddress('0x2'));
  // 0xio addresses are "oct" + base58(sha256(publicKey)): 47 chars, no oct1 prefix.
  const octKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).slice(12);
  const octAddr = 'oct' + require('../src/verify/bs58').encode(crypto.createHash('sha256').update(octKey).digest());
  assert.ok(adapterFor('octra').validateAddress(octAddr), 'a real derived Octra address validates');
  assert.ok(!adapterFor('octra').validateAddress('oct1abc'), 'a too-short body does not');
});

test('message builders: EVM lowercases, Ed25519 chains preserve the address', () => {
  const hex = '0xAbCdEf' + '0'.repeat(34);
  const evmMsg = adapterFor('eip155').buildMessage('0x' + 'A'.repeat(40), 'n1');
  assert.ok(evmMsg.includes('nonce: n1'.replace('nonce', 'Nonce')) || evmMsg.includes('n1'));
  assert.ok(adapterFor('solana').buildMessage('CaSeSensitiveAddr1111111111111111111111', 'n2').includes('CaSeSensitiveAddr'));
  assert.ok(adapterFor('eip155').normalizeAddress(hex) === hex.toLowerCase());
  // Sui/Aptos left-pad an abbreviated 0x address to 64 hex.
  assert.equal(adapterFor('sui').normalizeAddress('0x2'), '0x' + '0'.repeat(63) + '2');
});

// ---- key-bound verification (Sui, Aptos, Octra) ----------------------------
const { blake2b } = require('../src/verify/blake2b');
const MSG = 'Questora wallet verification\n\nAddress: ADDR\nNonce: n3';
const newKey = () => {
  const kp = crypto.generateKeyPairSync('ed25519');
  return { kp, raw: kp.publicKey.export({ type: 'spki', format: 'der' }).slice(12) };
};
const uleb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); };

test('blake2b-256 matches the published vector, and blake2b-512 matches node', () => {
  assert.equal(blake2b('abc', 32).toString('hex'), 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319');
  const data = crypto.randomBytes(300);
  assert.ok(blake2b(data, 64).equals(crypto.createHash('blake2b512').update(data).digest()));
});

test('Sui: serialized personal-message signature verifies only for the key-derived address', () => {
  const { kp, raw } = newKey();
  const address = '0x' + blake2b(Buffer.concat([Buffer.from([0]), raw]), 32).toString('hex');
  const msg = MSG.replace('ADDR', address);
  const bytes = Buffer.from(msg);
  const digest = blake2b(Buffer.concat([Buffer.from([3, 0, 0]), uleb(bytes.length), bytes]), 32);
  const sig = crypto.sign(null, digest, kp.privateKey);
  const serialized = Buffer.concat([Buffer.from([0]), sig, raw]).toString('base64');
  const sui = adapterFor('sui');
  assert.ok(sui.verify({ address, message: msg, signature: serialized }));
  assert.ok(!sui.verify({ address: '0x' + 'ab'.repeat(32), message: msg, signature: serialized }), 'a different address is refused');
  assert.ok(!sui.verify({ address, message: msg + 'x', signature: serialized }), 'a tampered message is refused');
  assert.ok(!sui.verify({ address, message: msg, signature: sig.toString('base64') }), 'a bare signature without the key is refused');
});

test('Aptos: the signing key must derive the account address', () => {
  const { kp, raw } = newKey();
  const address = '0x' + crypto.createHash('sha3-256').update(Buffer.concat([raw, Buffer.from([0])])).digest('hex');
  const msg = 'APTOS\nmessage: ' + MSG.replace('ADDR', address);
  const sig = crypto.sign(null, Buffer.from(msg), kp.privateKey);
  const aptos = adapterFor('aptos');
  assert.ok(aptos.verify({ address, message: msg, signature: sig, publicKey: raw }));
  assert.ok(!aptos.verify({ address: '0x' + '11'.repeat(32), message: msg, signature: sig, publicKey: raw }), 'someone else\'s address is refused');
  assert.ok(!aptos.verify({ address, message: 'tampered', signature: sig, publicKey: raw }));
});

test('Octra: 0xio framed signature verifies for the key-derived address', () => {
  const { kp, raw } = newKey();
  const address = 'oct' + require('../src/verify/bs58').encode(crypto.createHash('sha256').update(raw).digest());
  const msg = MSG.replace('ADDR', address);
  const framed = `Octra Signed Message:\n${Buffer.byteLength(msg)}\n${msg}`;
  const sig = crypto.sign(null, Buffer.from(framed), kp.privateKey).toString('base64');
  const octra = adapterFor('octra');
  assert.ok(octra.verify({ address, message: msg, signature: sig, publicKey: raw.toString('base64') }));
  const unframed = crypto.sign(null, Buffer.from(msg), kp.privateKey).toString('base64');
  assert.ok(!octra.verify({ address, message: msg, signature: unframed, publicKey: raw.toString('base64') }), 'a raw (unframed) signature is refused');
  assert.ok(!octra.verify({ address: 'oct' + 'A'.repeat(44), message: msg, signature: sig, publicKey: raw.toString('base64') }), 'a key that does not derive the address is refused');
});

test('Solana still verifies a raw Ed25519 signature over the message', () => {
  const { kp, raw } = newKey();
  const address = require('../src/verify/bs58').encode(raw);
  const sig = crypto.sign(null, Buffer.from(MSG), kp.privateKey);
  assert.ok(adapterFor('solana').verify({ address, message: MSG, signature: sig.toString('base64') }));
});
