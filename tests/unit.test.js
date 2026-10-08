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

// ---- Quest CRUD builder helpers ----
const questBuilder = require('../public/quest-builder.js');

// ---- Explore load cancellation (api client) ----
// The SPA's api client is a browser IIFE, so load it in a sandbox with just
// the globals it reads (window, fetch, AbortController).
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function loadApiClient(fetchImpl) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'api.js'), 'utf8');
  const sandbox = {
    window: { location: { search: '' } },
    fetch: fetchImpl,
    AbortController,
    URLSearchParams,
    Map,
    Promise,
    Date,
    console,
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.QuestoraAPI;
}

test('api client: a newer navigation never inherits an older signal (Explore abort)', async () => {
  // fetch resolves only when the test releases it, so both reads are genuinely
  // in flight at the same time.
  const pending = [];
  const fetchImpl = (url, opts) => new Promise((resolve) => {
    pending.push({ url, signal: opts && opts.signal, resolve: () =>
      resolve({ ok: true, status: 200, json: async () => ({ marker: url }) }) });
  });
  const api = loadApiClient(fetchImpl);

  const ctrlA = new AbortController();
  const ctxA = { seq: 1, signal: ctrlA.signal };
  const ctxB = { seq: 2, signal: new AbortController().signal };

  // Read 1: navigation A asks for the discover feed.
  const first = api.api.get('/api/v1/discover', { signal: ctxA.signal });
  assert.equal(pending.length, 1, 'first read starts one request');

  // Navigation B begins: A's signal aborts (app.js beginNav behaviour).
  ctrlA.abort();

  // Read 2: navigation B asks for the SAME path. It must not reuse A's
  // request, which is bound to the now-aborted signal.
  const second = api.api.get('/api/v1/discover', { signal: ctxB.signal });
  assert.equal(pending.length, 2, 'a new signal starts a fresh request, not the aborted one');

  // Resolve the newer request; the current screen keeps its content.
  pending[1].resolve();
  const data = await second;
  assert.equal(data.marker, '/api/v1/discover');

  // The superseded request, when it settles, must not reject the screen and
  // must not poison the cache the newer read uses.
  pending[0].resolve();
  await first.catch(() => {}); // A's promise is irrelevant to B
  const cached = await api.api.get('/api/v1/discover', { signal: ctxB.signal });
  assert.equal(cached.marker, '/api/v1/discover');
});

test('api client: isCancelled recognises an AbortError, not a real failure', () => {
  const api = loadApiClient(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
  const abortErr = new Error('signal is aborted without reason');
  abortErr.name = 'AbortError';
  assert.equal(api.isCancelled(abortErr), true);
  assert.equal(api.isCancelled(new Error('Internal server error')), false);
  assert.equal(api.isCancelled(null), false);
});

test('quest status maps to the three-word vocabulary without losing the honest word', () => {
  assert.deepEqual(questBuilder.statusBucket('draft'), 'Draft');
  assert.deepEqual(questBuilder.statusPill('draft'), 'Draft');
  assert.deepEqual(questBuilder.statusBucket('active'), 'Published');
  assert.deepEqual(questBuilder.statusPill('active'), 'Published');
  // scheduled/paused/ended stay honest under the Published bucket.
  for (const st of ['scheduled', 'paused', 'ended']) {
    assert.equal(questBuilder.statusBucket(st), 'Published', st + ' buckets as Published');
    assert.notEqual(questBuilder.statusPill(st), 'Published', st + ' keeps its own word');
  }
  assert.equal(questBuilder.statusBucket('archived'), 'Archived');
  assert.equal(questBuilder.statusPill('archived'), 'Archived');
});

test('task type choices map to the six types the server verifies', () => {
  const supported = new Set(['wallet_connect', 'social', 'url_proof', 'quiz', 'manual', 'on_chain']);
  for (const c of questBuilder.TYPE_CHOICES) {
    const m = questBuilder.taskTypeToConfig(c.key, {});
    assert.ok(supported.has(m.type), c.key + ' maps to a supported server type');
  }
  // Connect Wallet, Visit Website, Complete Form and Custom Task are exact.
  assert.deepEqual(questBuilder.taskTypeToConfig('wallet_connect', {}), { type: 'wallet_connect', config: {} });
  assert.deepEqual(questBuilder.taskTypeToConfig('social', { url: 'https://x.example' }),
    { type: 'social', config: { url: 'https://x.example', action: 'visit' } });
  assert.deepEqual(questBuilder.taskTypeToConfig('custom_manual', {}), { type: 'manual', config: {} });
  // On-chain variants are one type with different config.method.
  const tx = questBuilder.taskTypeToConfig('on_chain_transaction', { network_id: '3', confirmations: '2' });
  assert.equal(tx.type, 'on_chain');
  assert.equal(tx.config.method, 'transaction');
  assert.equal(tx.config.network_id, 3);
  assert.equal(tx.config.confirmations, 2);
  const contract = questBuilder.taskTypeToConfig('contract_interaction', { network_id: '3', contract: '0xabc' });
  assert.equal(contract.config.method, 'transaction');
  assert.equal(contract.config.contract, '0xabc');
  const token = questBuilder.taskTypeToConfig('token_balance', { network_id: '4', token_id: '9', amount: '100', operator: 'gte' });
  assert.equal(token.config.method, 'erc20_balance');
  assert.equal(token.config.token_id, 9);
  assert.deepEqual(token.config.requirement, { amount: '100', operator: 'gte' });
  // Hold Token is the same balance check, named plainly (no NFT promise).
  const hold = questBuilder.taskTypeToConfig('hold_token', { network_id: '4', token_id: '9', amount: '5' });
  assert.equal(hold.config.method, 'erc20_balance');
  // Every on-chain mapping carries a requirement only when an amount was given.
  assert.equal(questBuilder.taskTypeToConfig('token_balance', { network_id: '4' }).config.requirement, null);
});

test('a stored task maps back to the builder choice it came from', () => {
  assert.equal(questBuilder.choiceForTask({ type: 'on_chain', config: { method: 'transaction' } }), 'on_chain_transaction');
  assert.equal(questBuilder.choiceForTask({ type: 'on_chain', config: { method: 'transaction', contract: '0x1' } }), 'contract_interaction');
  assert.equal(questBuilder.choiceForTask({ type: 'on_chain', config: { method: 'erc20_balance' } }), 'token_balance');
  assert.equal(questBuilder.choiceForTask({ type: 'social', config: {} }), 'social');
  assert.equal(questBuilder.choiceForTask({ type: 'url_proof', config: {} }), 'url_proof');
  assert.equal(questBuilder.choiceForTask({ type: 'manual', config: {} }), 'manual');
});

test('the duplicate title suffix is " Copy" with no parentheses', () => {
  assert.equal(questBuilder.duplicateTitle('Connect Wallet'), 'Connect Wallet Copy');
  assert.equal(questBuilder.duplicateTitle('  Spaced  '), 'Spaced Copy');
});

test('the task reorder payload orders ids to sort_order indices', () => {
  assert.deepEqual(questBuilder.reorderSortOrders(['7', 4, 9]),
    [{ id: 7, sort_order: 0 }, { id: 4, sort_order: 1 }, { id: 9, sort_order: 2 }]);
  assert.deepEqual(questBuilder.reorderSortOrders([]), []);
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


test('shared icon helper renders one svg and never throws on an unknown name', () => {
  // icons.js attaches to window.QUI; give it a window to attach to.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'icons.js'), 'utf8');
  const sandbox = { window: { QUI: {} } };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(sandbox.window, { createElement() { return {}; } });
  const icon = sandbox.window.QUI.icon;
  assert.equal(typeof icon, 'function');
  const svg = icon('folder');
  assert.match(svg, /^<svg /);
  assert.match(svg, /aria-hidden="true"/);
  assert.equal(icon('not-a-real-icon-name', {}), '', 'unknown name draws nothing and does not throw');
  const names = sandbox.window.QUI.iconNames();
  assert.ok(names.includes('more_vert') && names.includes('account_balance_wallet'));
});

test('one navigation source drives the desktop bar, drawer and bottom bar', () => {
  const navMenu = require('../public/nav-menu.js');
  assert.equal(typeof navMenu.NAV, 'object');
  assert.equal(typeof navMenu.BOTTOM_NAV, 'object');
  assert.equal(typeof navMenu.UTILITY_NAV, 'object');

  const seen = new Map();
  for (const dest of navMenu.NAV) seen.set(dest.path, dest.label);
  for (const dest of navMenu.BOTTOM_NAV) seen.set(dest.path, dest.label);
  for (const dest of navMenu.UTILITY_NAV) seen.set(dest.path, dest.label);
  assert.equal(seen.get('/projects'), 'Projects', 'Projects is the same destination everywhere');
  assert.equal(seen.get('/campaigns'), 'Campaigns');
  // The four bottom-bar destinations are a subset of the shared labels.
  for (const dest of navMenu.BOTTOM_NAV) {
    assert.ok(dest.icon && dest.match, dest.label + ' needs an icon and a match');
  }
  assert.equal(navMenu.BOTTOM_NAV.length, 4, 'the bottom bar holds four destinations');
  // Every destination has an icon and a match rule, and none is duplicated.
  const paths = [];
  for (const list of [navMenu.NAV, navMenu.BOTTOM_NAV, navMenu.UTILITY_NAV]) {
    for (const dest of list) { assert.ok(dest.icon && dest.match); paths.push(dest.path); }
  }
  assert.equal(navMenu.matchRe(navMenu.NAV[0]).test('/projects/abc'), true);
});

// ---- Design tokens: the contrast contract ----------------------------------
// The semantic palette lives as RGB triplets in styles/tailwind-input.css.
// This parses that block and re-checks every pair the components actually use,
// so a future edit cannot silently dim a token below WCAG. Normal text must
// clear 4.5:1, icons and control borders 3:1.
function parseTokenBlock(css, selector) {
  const start = css.indexOf(selector + ' {');
  assert.ok(start >= 0, 'missing token block for ' + selector);
  const open = css.indexOf('{', start);
  const end = css.indexOf('}', open);
  const body = css.slice(open + 1, end);
  const tokens = {};
  for (const line of body.split('\n')) {
    const m = line.match(/--q-([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/);
    if (m) tokens[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return tokens;
}
function luminance([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

test('design tokens meet WCAG AA in both themes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'tailwind-input.css'), 'utf8');
  const dark = parseTokenBlock(css, ':root');
  const light = parseTokenBlock(css, 'html.light');

  // The tables hold every token the components consume; a missing key means
  // the CSS block and this contract have drifted.
  for (const t of [...Object.keys(dark), ...Object.keys(light)]) {
    assert.ok(dark[t], 'dark theme defines --q-' + t);
    assert.ok(light[t], 'light theme defines --q-' + t);
  }

  const surfaces = ['surface', 'surface-container', 'surface-container-high', 'surface-container-highest'];
  const text = ['text-primary', 'text-secondary', 'text-tertiary'];
  const icons = ['icon-primary', 'icon-secondary'];
  const statuses = [['success', 'success-bg'], ['warning', 'warning-bg'], ['error', 'error-bg'], ['info', 'info-bg']];
  const borders = [['border-strong', 'surface'], ['border-strong', 'surface-container'], ['border-strong', 'surface-container-high']];

  for (const [theme, tk] of [['dark', dark], ['light', light]]) {
    for (const fg of text) {
      for (const bg of surfaces) {
        const ratio = contrast(tk[fg], tk[bg]);
        assert.ok(ratio >= 4.5, theme + ' ' + fg + ' on ' + bg + ' is ' + ratio.toFixed(2) + ':1 (needs 4.5)');
      }
    }
    // accent-contrast text on the accent fill (primary buttons, links).
    {
      const ratio = contrast(tk['accent-contrast'], tk['accent']);
      assert.ok(ratio >= 4.5, theme + ' accent-contrast on accent is ' + ratio.toFixed(2) + ':1');
    }
    // Status text on its own tint, both ways round.
    for (const [fg, bg] of statuses) {
      const ratio = contrast(tk[fg], tk[bg]);
      assert.ok(ratio >= 4.5, theme + ' ' + fg + ' on ' + bg + ' is ' + ratio.toFixed(2) + ':1');
    }
    // Icons and control borders are non-text: 3:1.
    for (const [fg, bg] of borders) {
      const ratio = contrast(tk[fg], tk[bg]);
      assert.ok(ratio >= 3, theme + ' ' + fg + ' on ' + bg + ' is ' + ratio.toFixed(2) + ':1 (needs 3)');
    }
    for (const fg of icons) {
      const ratio = contrast(tk[fg], tk['surface-container-high']);
      assert.ok(ratio >= 3, theme + ' ' + fg + ' on surface-container-high is ' + ratio.toFixed(2) + ':1');
    }
  }

  // The two themes must actually differ, or the light block is a no-op.
  assert.notDeepEqual(dark['background'], light['background']);
  assert.equal(dark['accent'].join(' '), '124 58 237', 'the brand violet fill is unchanged');
});

test('the app markup has no raw palette colours left and status is never colour alone', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const files = ['public/index.html', 'public/app.js', 'public/components.js', 'public/views.js', 'public/wallets/ui.js'];
  const banned = /\b(?:bg|text|border|placeholder:text|hover:bg|hover:text|hover:border|focus:border)-(?:zinc|violet|emerald|amber|red|sky|slate|gray)-(?:[0-9]{2,3})(?:\/[0-9]+)?/;
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!banned.test(src), f + ' still contains a raw palette utility');
    assert.ok(!/opacity-[0-9]/.test(src.replace(/opacity-0\b/g, '')) || f === 'public/app.js',
      f + ' still dims content with a blanket opacity utility');
  }
  // statePill and the wallet PILL both carry a glyph, so status is not
  // conveyed by colour alone.
  const components = fs.readFileSync(path.join(__dirname, '..', 'public', 'components.js'), 'utf8');
  assert.match(components, /const icons = \{[\s\S]*?pending: 'schedule'/);
  const wallets = fs.readFileSync(path.join(__dirname, '..', 'public', 'wallets', 'ui.js'), 'utf8');
  assert.match(wallets, /PILL_ICON = \{ ok: 'check'/);
  // The shared primitives are the seam every caller inherits, so they must
  // resolve through tokens rather than palette steps.
  assert.match(components, /var BTN_PRIMARY = '[^']*bg-accent[^']*text-accent-contrast/);
  assert.match(components, /var BTN_SECONDARY = '[^']*bg-surface-container[^']*border-line-strong/);
  assert.match(components, /var BTN_ICON = '[^']*text-icon-secondary[^']*hover:text-icon-primary/);
});

test('network presets: catalog shape, no keys, no guessed non-EVM fields', () => {
  const { PRESETS, getPreset, presetToNetworkFields } = require('../src/network-presets');
  const ids = PRESETS.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'preset ids are unique');
  for (const pr of PRESETS) {
    assert.ok(pr.name && pr.type && pr.namespace && pr.addressFormat && pr.wallets.length, pr.id + ' has the core fields');
    assert.ok(pr.nativeToken.symbol, pr.id + ' has a native symbol');
    for (const u of pr.rpcs) {
      assert.match(u, /^https:\/\//, pr.id + ': https RPCs only');
      assert.ok(!/[?@]|key|token/i.test(u), pr.id + ': no embedded credentials');
    }
    if (pr.type === 'EVM') {
      assert.ok(Number.isInteger(pr.chainId) && pr.chainId > 0 && pr.rpcs.length, pr.id + ': EVM needs chain id and RPCs');
      assert.equal(pr.namespace, 'eip155');
    } else {
      assert.equal(pr.chainId, null, pr.id + ': non-EVM presets carry no EVM chain id');
    }
  }
  const eth = getPreset('ethereum');
  assert.deepEqual([eth.chainId, eth.nativeToken.symbol, eth.rpcs[0]], [1, 'ETH', 'https://ethereum-rpc.publicnode.com']);
  assert.equal(getPreset('polygon').nativeToken.symbol, 'POL');
  assert.equal(getPreset('sepolia').isTestnet, true);
  assert.equal(getPreset('solana').rpcs[0], 'https://api.mainnet-beta.solana.com');
  assert.equal(getPreset('aptos').networkId, '1');
  // Octra: docs publish no RPC, chain id or explorer, so they stay unset and flagged.
  const octra = getPreset('octra');
  assert.deepEqual(octra.rpcs, []);
  assert.equal(octra.explorer.url, null);
  assert.ok(octra.unverified.includes('rpcs'));
  assert.equal(octra.nativeToken.symbol, 'OCT');
  assert.equal(presetToNetworkFields(eth).chain_namespace, 'eip155');
  assert.equal(getPreset('nope'), null);
});
