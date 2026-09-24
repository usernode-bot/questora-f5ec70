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
