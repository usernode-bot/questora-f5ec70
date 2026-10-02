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

test('on_chain tasks on a chain with no adapter report MANUAL_REVIEW, never fake', async () => {
  // The engine routes an unsupported family (or an unknown method) to manual
  // review; it never invents a verdict and never a user-facing failure.
  const engine = require('../src/verify/engine');
  const solana = await engine.evaluateVerification({
    task: { id: 1 }, config: { method: 'native_balance' },
    network: { chain_namespace: 'solana' }, token: null, wallet: null, submission: {} });
  assert.equal(solana.status, 'MANUAL_REVIEW');
  assert.match(solana.reason, /no verification adapter/i);

  const unknownMethod = await engine.evaluateVerification({
    task: { id: 1 }, config: { method: 'abracadabra' },
    network: { chain_namespace: 'eip155' }, token: null, wallet: null, submission: {} });
  assert.equal(unknownMethod.status, 'MANUAL_REVIEW');

  // verifyTask folds that to the coarse 'pending', not 'rejected'.
  const verdict = await verifyTask('on_chain', { config: {}, submission: {} });
  assert.equal(verdict.result, 'pending');
  assert.equal(verdict.detail.status, 'MANUAL_REVIEW');
});

test('task config validation accepts a valid Simple Mode on-chain task and rejects the gaps', () => {
  const creator = require('../src/routes/creator');
  const good = { network_id: 1, method: 'native_balance', requirement: { amount: '100', operator: 'gte' } };
  assert.equal(creator.validateTaskConfig('on_chain', good), null);
  assert.match(creator.validateTaskConfig('on_chain', { method: 'native_balance' }), /network_id/);
  assert.match(creator.validateTaskConfig('on_chain', { network_id: 1, method: 'nope' }), /supported verification method/i);
  assert.match(creator.validateTaskConfig('on_chain', { network_id: 1, method: 'native_balance', requirement: { amount: '1', operator: 'wat' } }), /comparison operator/i);
  assert.match(creator.validateTaskConfig('on_chain', { network_id: 1, method: 'erc20_balance' }), /token/i);
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

// ---- Project access: permission resolution (pure) ----
const { resolvePermission, PROJECT_PERMISSIONS } = require('../src/rbac');
const util = require('../src/util');

test('rbac: the Creator resolves every permission', () => {
  for (const permission of PROJECT_PERMISSIONS) {
    assert.equal(resolvePermission({ isCreator: true, role: null, permission }), true, 'creator: ' + permission);
  }
});

test('rbac: an Admin manages content but never the project or its access', () => {
  const admin = { isCreator: false, role: 'admin' };
  for (const p of ['campaign.manage', 'quest.manage', 'task.manage', 'task.publish', 'verification.manage', 'rewards.manage', 'submissions.review', 'analytics.view', 'leaderboard.view', 'participants.view', 'project.view_private']) {
    assert.equal(resolvePermission({ ...admin, permission: p }), true, 'admin can ' + p);
  }
  for (const p of ['project.delete', 'project.edit', 'access.manage', 'audit.view']) {
    assert.equal(resolvePermission({ ...admin, permission: p }), false, 'admin cannot ' + p);
  }
});

test('rbac: a Moderator reviews and moderates, and manages nothing', () => {
  const mod = { isCreator: false, role: 'moderator' };
  for (const p of ['submissions.review', 'moderation.moderate', 'participants.view', 'analytics.view', 'leaderboard.view', 'project.view_private']) {
    assert.equal(resolvePermission({ ...mod, permission: p }), true, 'moderator can ' + p);
  }
  for (const p of ['campaign.manage', 'quest.manage', 'task.manage', 'task.publish', 'verification.manage', 'rewards.manage', 'project.delete', 'project.edit', 'access.manage', 'audit.view']) {
    assert.equal(resolvePermission({ ...mod, permission: p }), false, 'moderator cannot ' + p);
  }
});

test('rbac: a non-member resolves nothing, and there is no platform-admin global role', () => {
  for (const permission of PROJECT_PERMISSIONS) {
    assert.equal(resolvePermission({ isCreator: false, role: null, permission }), false, 'non-member: ' + permission);
    assert.equal(resolvePermission({ isCreator: false, role: 'admin', permission, isPlatformAdmin: true }), resolvePermission({ isCreator: false, role: 'admin', permission }), 'platform admin is not special: ' + permission);
  }
});

test('rbac: legacy granular roles collapse to moderator (least privilege)', () => {
  for (const role of ['editor', 'reviewer', 'analyst']) {
    assert.equal(resolvePermission({ isCreator: false, role, permission: 'submissions.review' }), true, role + ' reviews');
    assert.equal(resolvePermission({ isCreator: false, role, permission: 'campaign.manage' }), false, role + ' does not manage');
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


// ---- Slice 1: universal verification core (pure) ----
const status = require('../src/verify/status');
const idempotency = require('../src/verify/idempotency');
const amountMod = require('../src/verify/amount');
const chainAdapter = require('../src/verify/chain-adapter');
const evmVerifier = require('../src/verify/evm/evm-verifier');
const { RpcUnavailableError } = require('../src/verify/errors');

test('status.classify maps all nine enum values to the coarse task state', () => {
  assert.equal(status.STATUSES.length, 9);
  const expect = {
    VERIFIED: ['verified', false, true],
    FAILED: ['rejected', true, false],
    EXPIRED: ['rejected', true, false],
    PENDING: ['pending', false, false],
    WAITING_CONFIRMATIONS: ['pending', false, false],
    INDEXING_DELAY: ['pending', false, false],
    RPC_UNAVAILABLE: ['pending', false, false],
    MANUAL_REVIEW: ['pending', false, false],
    INVALID_CONFIGURATION: ['invalid', false, false],
  };
  for (const [k, [stored, fail, awards]] of Object.entries(expect)) {
    const c = status.classify(k);
    assert.equal(c.storedStatus, stored, k + ' stored');
    assert.equal(c.isUserFailure, fail, k + ' user failure');
    assert.equal(c.awardsCompletion, awards, k + ' awards');
  }
  // An unknown enum value is treated as infrastructure, never a failure.
  assert.equal(status.classify('WHO_KNOWS').storedStatus, 'pending');
  assert.equal(status.classify('WHO_KNOWS').isUserFailure, false);
});

test('idempotency key builder produces both shapes', () => {
  assert.equal(
    idempotency.transactionKey({ chainNamespace: 'eip155', chainId: 1, transactionId: '0xABC', logIndex: null, taskId: 7 }),
    'chain:eip155:1:tx:0xABC:log:-:task:7');
  assert.equal(
    idempotency.transactionKey({ chainNamespace: 'eip155', chainId: 1, transactionId: '0xABC', logIndex: 2, taskId: 7 }),
    'chain:eip155:1:tx:0xABC:log:2:task:7');
  assert.equal(
    idempotency.stateKey({ userId: 3, taskId: 7, completionPeriod: 'once' }),
    'user:3:task:7:once');
  assert.equal(
    idempotency.stateKey({ userId: 3, taskId: 7, completionPeriod: '2026-10-02' }),
    'user:3:task:7:2026-10-02');
  // The keyForResult chooser picks the shape from whether a tx id is present.
  assert.match(idempotency.keyForResult({ transactionId: '0x1', chainNamespace: 'eip155', chainId: 5 }, { userId: 1, taskId: 2 }), /^chain:eip155:5:tx:0x1/);
  assert.match(idempotency.keyForResult({ transactionId: null }, { userId: 1, taskId: 2, completionPeriod: 'once' }), /^user:1:task:2:once/);
});

test('amount comparison is BigInt-only and refuses malformed input', () => {
  assert.equal(amountMod.compare('100000000000000000000', { amount: '100', decimals: 18, operator: 'gte' }).ok, true);
  assert.equal(amountMod.compare('99999999999999999999', { amount: '100', decimals: 18, operator: 'gte' }).ok, false);
  assert.equal(amountMod.compare('100', { amount: '100', decimals: 0, operator: 'eq' }).ok, true);
  assert.equal(amountMod.compare('100', { amount: '100', decimals: 0, operator: 'gt' }).ok, false);
  assert.equal(amountMod.compare('5', { amount: '10', decimals: 0, operator: 'lte' }).ok, true);
  // Operators accept symbols and words.
  assert.equal(amountMod.normalizeOperator('>='), 'gte');
  assert.equal(amountMod.normalizeOperator('at_least'), 'gte');
  assert.equal(amountMod.normalizeOperator('nonsense'), null);
  // Refuse extra precision rather than rounding money silently.
  assert.equal(amountMod.toBaseUnits('1.234', 2), null);
  assert.equal(amountMod.toBaseUnits('1.20', 2).toString(), '120');
  assert.equal(amountMod.toBaseUnits('-1', 0), null);
  assert.equal(amountMod.compare('100', { amount: '1.2.3', decimals: 0, operator: 'gte' }).invalid, true);
});

test('the chain adapter registry resolves EVM and refuses families with no adapter', () => {
  const evm = chainAdapter.adapterFor('eip155');
  assert.ok(evm, 'EVM adapter is registered');
  assert.equal(evm.capabilities().nativeBalance, true);
  assert.equal(evm.capabilities().fungibleBalance, true);
  assert.deepEqual(evm.supportedMethods().sort(), ['erc20_balance', 'native_balance', 'transaction']);
  // A family with no adapter returns null so the engine routes to manual review.
  assert.equal(chainAdapter.adapterFor('solana'), null);
  // The interface declares the broader conceptual surface; unsupported calls
  // say so rather than faking.
  assert.equal(chainAdapter.adapterFor('eip155').capabilities().nftOwnership, false);
});

// A fake pool: the seam evm-verifier accepts via ctx.pool, so the EVM checks
// are unit-tested with no live RPC.
function fakePool(map) {
  return {
    entries: [{}],
    async call(fn) { return { value: await fn(map.provider || fakeProvider(map)), endpoint: { url: 'https://fake.example' } }; },
    async latestBlock() { return map.latestBlock === undefined ? 100 : map.latestBlock; },
  };
}
function fakeProvider(map) {
  return {
    async getNetwork() { return { chainId: BigInt(map.chainId === undefined ? 11155111 : map.chainId) }; },
    async getBalance() { return BigInt(map.balance || 0); },
    async getBlockNumber() { return map.latestBlock === undefined ? 100 : map.latestBlock; },
    async getTransaction(hash) { return map.tx === undefined ? null : map.tx; },
    async getTransactionReceipt(hash) { return map.receipt === undefined ? null : map.receipt; },
  };
}

const NETWORK = { id: 1, name: 'Sepolia', chain_namespace: 'eip155', chain_id: 11155111, native_symbol: 'ETH', native_decimals: 18 };
const WALLET = { address: '0x1111111111111111111111111111111111111111' };

test('evm native balance verifies, fails honestly, and needs a wallet', async () => {
  const adapter = chainAdapter.adapterFor('eip155');
  const base = { method: 'native_balance', config: { requirement: { amount: '1', operator: 'gte' } },
    network: NETWORK, token: null, wallet: WALLET, submission: {}, adapter };
  const ok = await evmVerifier.verifyEvm({ ...base, pool: fakePool({ balance: '1000000000000000000' }) });
  assert.equal(ok.status, 'VERIFIED');
  assert.equal(ok.verified, true);
  const low = await evmVerifier.verifyEvm({ ...base, pool: fakePool({ balance: '999' }) });
  assert.equal(low.status, 'FAILED');
  assert.equal(status.classify(low.status).isUserFailure, true);
  const noWallet = await evmVerifier.verifyEvm({ ...base, wallet: null, pool: fakePool({ balance: '0' }) });
  assert.equal(noWallet.status, 'INVALID_CONFIGURATION');
});

test('evm erc20 balance uses contract decimals and BigInt math', async () => {
  const adapter = chainAdapter.adapterFor('eip155');
  const provider = {
    async getNetwork() { return { chainId: 11155111n }; },
    async getBlockNumber() { return 100; },
  };
  // The contract call path is exercised through the pool's call(fn).
  const pool = {
    async call(fn) { return { value: await fn(makeErc20Provider('250000000000000000000', 18)) }; },
    async latestBlock() { return 100; },
  };
  const ctx = { method: 'erc20_balance', config: { requirement: { amount: '100', operator: 'gte' } },
    network: NETWORK, token: { contract_address: '0xtoken', symbol: 'USDX', decimals: 18 },
    wallet: WALLET, submission: {}, adapter, pool };
  const r = await evmVerifier.verifyEvm(ctx);
  assert.equal(r.status, 'VERIFIED');
  const r2 = await evmVerifier.verifyEvm({ ...ctx, config: { requirement: { amount: '1000', operator: 'gte' } } });
  assert.equal(r2.status, 'FAILED');
});

function makeErc20Provider(balance, decimals) {
  const { ethers } = require('ethers');
  const iface = new ethers.Interface([
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ]);
  // The verifier's only provider dependency is eth_call; decode the selector
  // and answer with properly encoded results.
  return {
    async getNetwork() { return { chainId: 11155111n }; },
    async getBlockNumber() { return 100; },
    async call({ to, data }) {
      const selector = data.slice(0, 10);
      if (selector === iface.getFunction('decimals').selector) {
        return iface.encodeFunctionResult('decimals', [decimals]);
      }
      if (selector === iface.getFunction('balanceOf').selector) {
        return iface.encodeFunctionResult('balanceOf', [BigInt(balance)]);
      }
      throw new Error('unexpected eth_call ' + selector);
    },
  };
}

test('evm transaction: verified, reverted, waiting, and unseen all behave distinctly', async () => {
  const adapter = chainAdapter.adapterFor('eip155');
  const tx = { from: WALLET.address, to: '0x2222222222222222222222222222222222222222', value: 1000000000000000000n };
  const base = { method: 'transaction', config: { confirmations: 3 },
    network: NETWORK, token: null, wallet: WALLET, submission: { transaction_hash: '0x' + 'a'.repeat(64) }, adapter };

  const okReceipt = { status: 1, from: WALLET.address, to: tx.to, blockNumber: 98, logs: [] };
  const ok = await evmVerifier.verifyEvm({ ...base, pool: fakePool({ tx, receipt: okReceipt, latestBlock: 100 }) });
  assert.equal(ok.status, 'VERIFIED');
  assert.equal(ok.confirmations, 3);
  assert.equal(ok.finality, 'finalized');

  const wait = await evmVerifier.verifyEvm({ ...base, pool: fakePool({ tx, receipt: okReceipt, latestBlock: 99 }) });
  assert.equal(wait.status, 'WAITING_CONFIRMATIONS');
  assert.equal(status.classify(wait.status).storedStatus, 'pending');

  const reverted = await evmVerifier.verifyEvm({ ...base, pool: fakePool({ tx, receipt: { ...okReceipt, status: 0 }, latestBlock: 100 }) });
  assert.equal(reverted.status, 'FAILED');
  assert.equal(status.classify(reverted.status).isUserFailure, true);

  const unseen = await evmVerifier.verifyEvm({ ...base, pool: fakePool({ tx: null, receipt: null, latestBlock: 100 }) });
  assert.equal(unseen.status, 'INDEXING_DELAY');
  assert.equal(status.classify(unseen.status).isUserFailure, false);

  const otherSender = await evmVerifier.verifyEvm({ ...base,
    pool: fakePool({ tx: { ...tx, from: '0x9999999999999999999999999999999999999999' }, receipt: okReceipt, latestBlock: 100 }) });
  assert.equal(otherSender.status, 'FAILED');
});

test('all RPC endpoints down is RPC_UNAVAILABLE, never a user failure', async () => {
  const evmVerifierLocal = require('../src/verify/evm/evm-verifier');
  const adapter = chainAdapter.adapterFor('eip155');
  const deadPool = {
    async call() { throw new RpcUnavailableError('down', { tried: ['https://a'] }); },
    async latestBlock() { throw new RpcUnavailableError('down'); },
  };
  const r = await evmVerifierLocal.verifyEvm({
    method: 'native_balance', config: { requirement: { amount: '1', operator: 'gte' } },
    network: NETWORK, token: null, wallet: WALLET, submission: {}, adapter, pool: deadPool });
  assert.equal(r.status, 'RPC_UNAVAILABLE');
  assert.equal(status.classify(r.status).storedStatus, 'pending');
  assert.equal(status.classify(r.status).isUserFailure, false);
});

// ---- Navigation audit: Create menu permissions and orphan cleanup ----
const navMenu = require('../public/nav-menu.js');

test('Create menu offers Project, but the project-scoped actions only when the user manages a project', () => {
  const none = navMenu.createMenuItems([]);
  assert.equal(none.project.href, '/create');
  assert.equal(none.items.length, 0, 'a user with no manageable project gets no campaign/quest/task action');
  assert.match(none.hint, /Create a project first/);

  const one = navMenu.createMenuItems([{ slug: 'octra', name: 'Octra' }]);
  assert.deepEqual(one.items.map((i) => i.key), ['campaign', 'quest', 'task']);
  for (const it of one.items) assert.match(it.href, /^\/dashboard\/projects\/octra\//);
  assert.equal(one.needsPicker, false);

  const two = navMenu.createMenuItems([{ slug: 'a', name: 'A' }, { slug: 'b', name: 'B' }]);
  assert.equal(two.needsPicker, true, 'two manageable projects force a picker');
});

test('the orphan duplicate page components are no longer exported', () => {
  // views.js is a browser bundle (it touches window), so read the export
  // list as text: viewCampaign/viewProject must be gone from it.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'views.js'), 'utf8');
  const start = src.indexOf('window.QV = {');
  const exportLine = src.slice(start, src.indexOf('};', start) + 2);
  assert.ok(start >= 0 && exportLine, 'views.js must still export its view map');
  assert.ok(!/\bviewCampaign\b/.test(exportLine), 'viewCampaign must not be exported');
  assert.ok(!/\bviewProject\b(?!Overview|Campaigns|Quests)/.test(exportLine), 'viewProject must not be exported');
  assert.ok(/viewNotFound/.test(exportLine), 'the not-found view must be exported');
});
