// Integration tests: run against a scratch Postgres.
//   DATABASE_URL=postgres://... USERNODE_ENV=staging npm test
// The suite boots the app's own migrate+seed path, so it exercises the same
// schema and staging seed block that staging runs use.
const { test, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const t = HAS_DB ? test : test.skip;

// Error-handler test support: auth.js pins the platform's real JWT public
// key, which a test cannot sign with, so the suite generates its own RSA
// keypair and tells the app to trust it. Tokens below are minted against it.
const { generateKeyPairSync } = require('node:crypto');
const { publicKey: testPublicKey, privateKey: testPrivateKey } =
  generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.USERNODE_JWT_PUBLIC_KEY =
  testPublicKey.export({ type: 'spki', format: 'pem' });
process.env.USERNODE_APP_ID = '999999';
process.env.USERNODE_ENV = process.env.USERNODE_ENV || 'staging';
const jwt = require('jsonwebtoken');

let pool;
let httpServer;
t('schema + seed + reward flow', async () => {
  process.env.USERNODE_ENV = process.env.USERNODE_ENV || 'staging';
  const db = require('../src/db');
  pool = db.pool;
  await db.migrate();
  const { seed } = require('../src/seed');
  await seed();

  // Seed idempotency: a second run must not duplicate quests.
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM quests');
  await seed();
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM quests');
  assert.equal(before.rows[0].n, after.rows[0].n, 'seed must be idempotent');

  // Seeded leaderboard state exists and belongs only to demo users.
  const lb = await pool.query(
    `SELECT u.username, SUM(x.amount) AS xp FROM xp_events x JOIN users u ON u.id = x.user_id
     GROUP BY u.id ORDER BY xp DESC LIMIT 3`);
  for (const r of lb.rows) assert.match(r.username, /^staging-demo-user/);

  // Private-table marker present on every sensitive table.
  const marked = await pool.query(
    `SELECT c.relname FROM pg_class c
     LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
     WHERE c.relname IN ('wallet_challenges','social_accounts','task_submissions','verification_events','reward_claims','audit_logs')
       AND d.description = 'staging:private'`);
  assert.equal(marked.rows.length, 6, 'all six private tables must be marked');

  // Reward idempotency: completing a seeded quest twice pays once.
  const { completeQuest } = require('../src/reward');
  const quest = await pool.query(`SELECT id FROM quests WHERE title = 'Submit Proof' LIMIT 1`);
  const user = await pool.query(`SELECT id FROM users WHERE username = 'staging-demo-user-6'`);
  // Start clean so the assertion is about this run, not leftover rows.
  await pool.query('DELETE FROM quest_completions WHERE quest_id = $1 AND user_id = $2', [quest.rows[0].id, user.rows[0].id]);
  await pool.query("DELETE FROM xp_events WHERE user_id = $1 AND source_type = 'quest' AND source_id = $2", [user.rows[0].id, quest.rows[0].id]);
  const tasks = await pool.query('SELECT id FROM quest_tasks WHERE quest_id = $1', [quest.rows[0].id]);
  for (const task of tasks.rows) {
    await pool.query(
      `INSERT INTO task_submissions (task_id, quest_id, user_id, proof_type, proof_url, status, reviewer_id, reviewed_at)
       VALUES ($1, $2, $3, 'url_proof', 'https://example.com/ok', 'verified', $4, NOW())`,
      [task.id, quest.rows[0].id, user.rows[0].id, user.rows[0].id]);
  }
  const first = await completeQuest(quest.rows[0].id, user.rows[0].id);
  assert.equal(first.completed, true);
  const xp1 = (await pool.query(
    'SELECT COALESCE(SUM(amount),0) AS s FROM xp_events WHERE user_id = $1 AND source_type = $2 AND source_id = $3',
    [user.rows[0].id, 'quest', quest.rows[0].id])).rows[0].s;
  const second = await completeQuest(quest.rows[0].id, user.rows[0].id);
  assert.equal(second.completed, false);
  assert.equal(second.reason, 'already_completed');
  const xp2 = (await pool.query(
    'SELECT COALESCE(SUM(amount),0) AS s FROM xp_events WHERE user_id = $1 AND source_type = $2 AND source_id = $3',
    [user.rows[0].id, 'quest', quest.rows[0].id])).rows[0].s;
  assert.equal(Number(xp1), Number(xp2), 'double completion must not double-award XP');

  // Level thresholds remain admin-editable data.
  const thr = await pool.query('SELECT level, min_xp FROM level_thresholds ORDER BY level');
  assert.ok(thr.rows.length >= 5);
  assert.equal(thr.rows[0].min_xp, 0);

  // Phase 2: project points systems. The seed awards project points to
  // Octra Builders for every welcome-campaign completion (3 users x 3 quests).
  const projPoints = await pool.query(
    `SELECT COUNT(*)::int AS n FROM points_events pe
     JOIN points_systems ps ON ps.id = pe.system_id
     JOIN projects p ON p.id = ps.project_id
     WHERE p.slug = 'staging-demo-octra-builders'`);
  assert.ok(projPoints.rows[0].n >= 9, 'project points system must receive quest points');

  // Phase 2: credential issuance. Configuring a credential reward on a quest
  // issues exactly one credential on completion, even if the completion is
  // attempted again.
  const credQuest = await pool.query(`SELECT id FROM quests WHERE title = 'Submit Proof' LIMIT 1`);
  await pool.query(
    `INSERT INTO rewards (quest_id, kind, config)
     SELECT $1, 'credential', '{"title": "Test Proof Credential"}'::jsonb
     WHERE NOT EXISTS (SELECT 1 FROM rewards WHERE quest_id = $1 AND kind = 'credential')`,
    [credQuest.rows[0].id]);
  const credUser = await pool.query(`SELECT id FROM users WHERE username = 'staging-demo-user-6'`);
  // The credentials table has no unique key; a re-run must start clean or
  // the exactly-once assertion below would count previous runs' rows.
  await pool.query(`DELETE FROM credentials WHERE title = 'Test Proof Credential'`);
  await pool.query(
    `DELETE FROM quest_completions WHERE quest_id = $1 AND user_id = $2`,
    [credQuest.rows[0].id, credUser.rows[0].id]);
  await pool.query(
    "DELETE FROM xp_events WHERE user_id = $1 AND source_type = 'quest' AND source_id = $2",
    [credUser.rows[0].id, credQuest.rows[0].id]);
  const credRes = await completeQuest(credQuest.rows[0].id, credUser.rows[0].id);
  assert.equal(credRes.completed, true);
  assert.ok(credRes.credential_id, 'a configured credential reward must issue a credential');
  const credCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM credentials WHERE title = 'Test Proof Credential'`);
  assert.equal(credCount.rows[0].n, 1, 'credential must issue exactly once');

  // Phase 2: referrals. Claim, then qualify after the referee completes
  // the configured number of quests; the referrer is paid exactly once.
  const referrals = require('../src/referrals');
  const referrer = await pool.query(`SELECT id FROM users WHERE username = 'staging-demo-user-1'`);
  const referee = await pool.query(`SELECT id FROM users WHERE username = 'staging-demo-user-4'`);
  const rid = referrer.rows[0].id, did = referee.rows[0].id;
  await pool.query('DELETE FROM referrals WHERE referee_user_id = $1', [did]);
  await pool.query("DELETE FROM xp_events WHERE user_id = $1 AND source_type = 'referral'", [rid]);
  const claimRes = await referrals.claim('demo-ref-1', did);
  assert.ok(claimRes.claimed, 'claim must succeed for a fresh referee');
  const claimAgain = await referrals.claim('demo-ref-1', did);
  assert.equal(claimAgain.error, 'You already have an invite on record');
  const selfClaim = await referrals.claim('demo-ref-1', rid);
  assert.equal(selfClaim.error, 'You cannot use your own invite code');

  // Complete quests one at a time; qualification lands on the third.
  const questIds = (
    await pool.query(
      `SELECT q.id FROM quests q WHERE q.title IN ('Connect Wallet', 'Join Community', 'Complete Quiz') ORDER BY q.title`)
  ).rows.map(r => r.id);
  const doneIds = (await pool.query(
    `SELECT DISTINCT quest_id FROM quest_completions WHERE user_id = $1`, [did])).rows.map(r => r.quest_id);
  // On a re-run the referee may already hold enough completions, in which
  // case qualification landed at claim time rather than in the loop below.
  let pending = true;
  const afterClaim = await pool.query(
    `SELECT status FROM referrals WHERE referee_user_id = $1`, [did]);
  if (afterClaim.rows[0].status === 'qualified') pending = false;
  for (const qid of questIds) {
    if (doneIds.includes(qid)) continue;
    const tasks = await pool.query('SELECT id FROM quest_tasks WHERE quest_id = $1', [qid]);
    for (const task of tasks.rows) {
      await pool.query(
        `INSERT INTO task_submissions (task_id, quest_id, user_id, proof_type, proof_url, status, reviewer_id, reviewed_at)
         VALUES ($1, $2, $3, 'manual', 'https://example.com/ok', 'verified', $4, NOW())
         ON CONFLICT DO NOTHING`,
        [task.id, qid, did, rid]);
    }
    const res = await completeQuest(qid, did);
    if (!res.completed) continue;
    const state = await pool.query(
      `SELECT status, rewarded_at FROM referrals WHERE referee_user_id = $1`, [did]);
    if (doneIds.length + 1 < 3) {
      assert.equal(state.rows[0].status, 'pending', 'referral stays pending before the threshold');
    } else {
      assert.equal(state.rows[0].status, 'qualified');
      assert.ok(state.rows[0].rewarded_at, 'qualified referral must be marked rewarded');
      pending = false;
    }
    doneIds.push(qid);
  }
  assert.equal(pending, false, 'qualification must have been reached');
  const referralXp = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS s FROM xp_events WHERE user_id = $1 AND source_type = 'referral'`,
    [rid]);
  // Phase 3: the active season scales every XP award, so the expected
  // payout is the configured reward times the live multiplier (the staging
  // seed's 2x demo season in this suite).
  const seasons = require('../src/seasons');
  const activeSeason = await seasons.current(pool);
  const expectedReferralXp = Math.round(100 * seasons.multiplierOf(activeSeason));
  assert.equal(Number(referralXp.rows[0].s), expectedReferralXp,
    'referrer must be paid the referral XP exactly once, scaled by the active season');
}, { timeout: 30000 });

t('Phase 3: reputation, achievements, seasons, risk and teams', async () => {
  // Fresh-completion scenario on user 5 (no seeded completions): clear any
  // prior run's rows first so the assertions are about this run.
  const u5 = (await pool.query(`SELECT id FROM users WHERE username = 'staging-demo-user-5'`)).rows[0];
  const u6 = (await pool.query(`SELECT id FROM users WHERE username = 'staging-demo-user-6'`)).rows[0];
  const quest = (await pool.query(`SELECT id, xp_reward FROM quests WHERE title = 'Connect Wallet' LIMIT 1`)).rows[0];
  await pool.query('DELETE FROM quest_completions WHERE user_id = $1', [u5.id]);
  await pool.query("DELETE FROM xp_events WHERE user_id = $1", [u5.id]);
  await pool.query('DELETE FROM user_achievements WHERE user_id = $1', [u5.id]);
  await pool.query('DELETE FROM reputation_events WHERE user_id = $1', [u5.id]);
  const tasks = await pool.query('SELECT id FROM quest_tasks WHERE quest_id = $1', [quest.id]);
  for (const task of tasks.rows) {
    await pool.query(
      `INSERT INTO task_submissions (task_id, quest_id, user_id, proof_type, proof_url, status, reviewer_id, reviewed_at, proof_hash)
       VALUES ($1, $2, $3, 'manual', 'https://example.com/ok', 'verified', $4, NOW(), $5)
       ON CONFLICT DO NOTHING`,
      [task.id, quest.id, u5.id, u5.id, require('../src/risk').proofHash('https://example.com/ok', null)]);
  }

  // Season multiplier: awardXp scales the quest reward by the active season
  // and stamps the ledger row with the season.
  const { completeQuest } = require('../src/reward');
  const seasons = require('../src/seasons');
  const activeSeason = await seasons.current(pool);
  const res = await completeQuest(quest.id, u5.id);
  assert.equal(res.completed, true);
  const expectedXp = Math.round(Number(quest.xp_reward) * seasons.multiplierOf(activeSeason));
  const xpRow = (await pool.query(
    `SELECT amount, season_id FROM xp_events WHERE user_id = $1 AND source_type = 'quest' AND source_id = $2`,
    [u5.id, quest.id])).rows[0];
  assert.equal(Number(xpRow.amount), expectedXp, 'season multiplier must scale quest XP');
  if (activeSeason) assert.equal(xpRow.season_id, activeSeason.id, 'xp_events must be stamped with the active season');

  // Reputation: one itemized event per completion, idempotent on re-record.
  const reputation = require('../src/reputation');
  const rep = await reputation.breakdown(u5.id);
  assert.equal(rep.total, 5);
  assert.equal(rep.breakdown.length, 1);
  assert.equal(rep.breakdown[0].category, 'quest_completed');
  assert.equal(rep.breakdown[0].events, 1);
  await reputation.record(pool, u5.id, 'quest_completed', 'quest', quest.id);
  const repAgain = await reputation.breakdown(u5.id);
  assert.equal(repAgain.total, 5, 're-recording the same source must not move the score');

  // Achievements: the criteria evaluator unlocks 'first-quest' on the same
  // transaction that completed the quest.
  assert.ok(res.achievements.some(a => a.key === 'first-quest'), 'first-quest must unlock on the first completion');
  const achievements = require('../src/achievements');
  const owned = await achievements.forUser(u5.id);
  const fq = owned.find(a => a.key === 'first-quest');
  assert.ok(fq && fq.unlocked_at, 'forUser must report the unlock state');

  // Season lookup by id and slug.
  assert.equal((await seasons.find('staging-demo-season', pool)).slug, 'staging-demo-season');
  assert.equal((await seasons.find(String(activeSeason.id), pool)).id, activeSeason.id);
  assert.equal(await seasons.find('no-such-season', pool), null);

  // Risk engine: velocity (8 completions in an hour) + duplicate proof
  // (the same hash submitted by 3 accounts) score 5 and escalate to blocked.
  await pool.query('DELETE FROM quest_completions WHERE user_id = $1', [u6.id]);
  const questIds = (await pool.query('SELECT id FROM quests LIMIT 8')).rows.map(r => r.id);
  for (const qid of questIds) {
    await pool.query(
      `INSERT INTO quest_completions (quest_id, user_id, status, xp_awarded)
       VALUES ($1, $2, 'completed', 0) ON CONFLICT (quest_id, user_id) DO NOTHING`,
      [qid, u6.id]);
  }
  const sharedHash = require('../src/risk').proofHash('https://farm.example/same-proof', null);
  const u4 = (await pool.query(`SELECT id FROM users WHERE username = 'staging-demo-user-4'`)).rows[0];
  for (const uid of [u5.id, u6.id, u4.id]) {
    await pool.query(
      `INSERT INTO task_submissions (task_id, quest_id, user_id, proof_type, proof_url, status, proof_hash)
       VALUES ($1, $2, $3, 'url_proof', 'https://farm.example/same-proof', 'verified', $4)`,
      [tasks.rows[0].id, quest.id, uid, sharedHash]);
  }
  const risk = require('../src/risk');
  await pool.query("UPDATE users SET risk_state = 'normal' WHERE id = $1", [u6.id]);
  const riskRes = await risk.evaluateUser(pool, u6.id);
  assert.ok(riskRes.signals.includes('velocity'), 'velocity signal must fire at 8 completions/hour');
  assert.ok(riskRes.signals.includes('duplicate_proof'), 'duplicate proof signal must fire at 3 accounts');
  assert.ok(riskRes.score >= 5, 'combined severity must reach the blocked threshold');
  assert.equal(riskRes.state, 'blocked');
  const stateNow = (await pool.query('SELECT risk_state FROM users WHERE id = $1', [u6.id])).rows[0].risk_state;
  assert.equal(stateNow, 'blocked');
  // Escalation is one-way: a re-run never de-escalates on its own.
  const again = await risk.evaluateUser(pool, u6.id);
  assert.equal(again.state, 'blocked');
  assert.ok((await risk.signalsFor(u6.id)).length >= 2, 'explainer rows must be readable for the admin panel');

  // Teams: create, join by code, one-team-per-user, leave/disband rules.
  const teams = require('../src/teams');
  // A re-run starts clean: a previous run's test team would trip the
  // one-team-per-user rule.
  await pool.query('DELETE FROM teams WHERE owner_user_id = $1', [u5.id]);
  await pool.query('DELETE FROM team_members WHERE user_id = $1', [u6.id]);
  const created = await teams.create(u5.id, 'Integration Test Crew', 'phase 3 test');
  assert.ok(created.team, JSON.stringify(created));
  const dup = await teams.create(u5.id, 'Another Crew');
  assert.equal(dup.error, 'You are already in a team. Leave it before creating another.');
  const joined = await teams.join(u6.id, created.team.join_code);
  assert.ok(joined.joined);
  const detail = await teams.detail(created.team.id);
  assert.equal(detail.members.length, 2);
  const badJoin = await teams.join(u6.id, 'wrong-code');
  assert.equal(badJoin.error, 'You are already in a team. Leave it before joining another.');
  const ownerLeave = await teams.leave(u5.id);
  assert.equal(ownerLeave.error, 'Owners cannot leave. Disband the team instead.');
  assert.ok((await teams.leave(u6.id)).left);
  const memberDisband = await teams.disband(u6.id);
  assert.equal(memberDisband.error, 'You are not in a team');
  assert.ok((await teams.disband(u5.id)).disbanded);
}, { timeout: 30000 });

t('a route that throws returns 500 and the server keeps serving', async () => {
  const jwt = require('jsonwebtoken');
  process.env.PORT = '0';
  const { start } = require('../server');
  httpServer = await start();
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  const token = jwt.sign(
    { id: 424242424, username: 'staging-demo-error-1', pur: 'iframe' },
    testPrivateKey.export({ type: 'pkcs8', format: 'pem' }),
    { algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:app:999999' }
  );
  const auth = { 'x-usernode-token': token };

  // /quests/:id/my passes :id straight into an integer column, so the id
  // 'abc' makes Postgres reject the query inside the async handler. Before
  // the async-error bridge this rejection killed the whole process.
  const boom = await fetch(base + '/api/v1/quests/abc/my', { headers: auth });
  assert.equal(boom.status, 500);
  assert.deepEqual(await boom.json(), { error: 'Internal server error' });

  // The process survived: health still answers and the route works with a
  // valid id.
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  const quest = await pool.query('SELECT id FROM quests ORDER BY id LIMIT 1');
  const ok = await fetch(base + `/api/v1/quests/${quest.rows[0].id}/my`, { headers: auth });
  assert.equal(ok.status, 200);

  // Errors that already carry a 4xx status keep it: the body parser marks
  // malformed JSON as 400 rather than turning it into a 500.
  const bad = await fetch(base + '/api/v1/tasks/1/submit', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: '{"broken',
  });
  assert.equal(bad.status, 400);
}, { timeout: 20000 });

t('wallet challenge/verify signs over HTTP and pays the quest, guards hold', async () => {
  const jwt = require('jsonwebtoken');
  if (!httpServer) {
    process.env.PORT = '0';
    const { start } = require('../server');
    httpServer = await start();
  }
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  const { ethers } = require('ethers');
  // A run-scoped identity: the guards below (already completed, awaiting
  // review) are per-user, so a rerun must not inherit a previous run's
  // submissions.
  const uid = 700000000 + Math.floor(Math.random() * 90000000);
  const runUser = 'staging-demo-wallet-' + Date.now() % 100000000;
  const tokenFor = (username) => jwt.sign(
    { id: uid, username, pur: 'iframe' },
    testPrivateKey.export({ type: 'pkcs8', format: 'pem' }),
    { algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:app:999999' }
  );
  const auth = { 'x-usernode-token': tokenFor(runUser), 'content-type': 'application/json' };

  // E2E: challenge -> personal-style signature -> verify. The wallet signs
  // the message the server returned for a CHECKSUMMED address; the server
  // normalizes to lowercase before building the message, so the recovered
  // signer must still match.
  const wallet = ethers.Wallet.createRandom();
  const ch = await (await fetch(base + '/api/v1/wallets/challenge', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ chain: 'eip155', address: wallet.address }),
  })).json();
  assert.ok(ch.nonce && ch.message.includes(wallet.address.toLowerCase()), 'challenge must bind the nonce to the address');
  const signature = await wallet.signMessage(ch.message);
  const verified = await fetch(base + '/api/v1/wallets/verify', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ chain: 'eip155', address: wallet.address, signature, nonce: ch.nonce }),
  });
  assert.equal(verified.status, 200, JSON.stringify(await verified.json().catch(() => ({}))));
  const mine = await (await fetch(base + '/api/v1/wallets', { headers: auth })).json();
  assert.ok((mine.wallets || []).some(w => w.address === wallet.address.toLowerCase() && w.verified_at));

  // The nonce is one-time: replaying it is refused.
  const replay = await fetch(base + '/api/v1/wallets/verify', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ chain: 'eip155', address: wallet.address, signature, nonce: ch.nonce }),
  });
  assert.equal(replay.status, 400);

  // A signature by a DIFFERENT key does not vouch for the claimed address.
  const other = ethers.Wallet.createRandom();
  const ch2 = await (await fetch(base + '/api/v1/wallets/challenge', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ chain: 'eip155', address: other.address }),
  })).json();
  const wrongSig = await wallet.signMessage(ch2.message);
  const wrong = await fetch(base + '/api/v1/wallets/verify', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ chain: 'eip155', address: other.address, signature: wrongSig, nonce: ch2.nonce }),
  });
  assert.equal(wrong.status, 400);

  // Wallet quest submission now verifies server-side against the wallets
  // table, and the completion is idempotent: a second submit is refused.
  const wq = await pool.query(
    `SELECT t.id AS task_id, q.id AS quest_id FROM quest_tasks t
     JOIN quests q ON q.id = t.quest_id
     WHERE t.type = 'wallet_connect' AND q.title = 'Connect Wallet' LIMIT 1`);
  const sub1 = await fetch(base + `/api/v1/tasks/${wq.rows[0].task_id}/submit`, {
    method: 'POST', headers: auth, body: '{}',
  });
  assert.equal(sub1.status, 200);
  const body1 = await sub1.json();
  assert.equal(body1.completion.completed, true, 'a verified wallet must complete the quest');
  const sub2 = await fetch(base + `/api/v1/tasks/${wq.rows[0].task_id}/submit`, {
    method: 'POST', headers: auth, body: '{}',
  });
  assert.equal(sub2.status, 400, 'the completed quest must refuse a second submission');

  // A locked quest (seeded 'Claim Veteran Status' requires two quests this
  // user has not completed) refuses the submission with its reason.
  const lockedTask = await pool.query(
    `SELECT t.id FROM quest_tasks t JOIN quests q ON q.id = t.quest_id
     WHERE q.title = 'Claim Veteran Status' LIMIT 1`);
  const locked = await fetch(base + `/api/v1/tasks/${lockedTask.rows[0].id}/submit`, {
    method: 'POST', headers: auth, body: JSON.stringify({ proof_data: { text: 'ready' } }),
  });
  assert.equal(locked.status, 403);
  assert.match((await locked.json()).error, /^Complete "/);

  // One live submission per task: a pending url proof cannot be resubmitted.
  const urlTask = await pool.query(
    `SELECT t.id FROM quest_tasks t JOIN quests q ON q.id = t.quest_id
     WHERE t.type = 'url_proof' AND q.title = 'Submit Proof' LIMIT 1`);
  const s1 = await fetch(base + `/api/v1/tasks/${urlTask.rows[0].id}/submit`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ proof_url: 'https://example.com/work-1' }),
  });
  assert.equal(s1.status, 200);
  const s2 = await fetch(base + `/api/v1/tasks/${urlTask.rows[0].id}/submit`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ proof_url: 'https://example.com/work-2' }),
  });
  assert.equal(s2.status, 400);
  assert.match((await s2.json()).error, /awaiting review/);
}, { timeout: 30000 });

t('admin access comes from ADMIN_USERNAMES, not the panel or first user', async () => {
  if (!httpServer) {
    process.env.PORT = '0';
    const { start } = require('../server');
    httpServer = await start();
  }
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  process.env.ADMIN_USERNAMES = 'staging-demo-admin';
  const tokenFor = (username, id) => jwt.sign(
    { id, username, pur: 'iframe' },
    testPrivateKey.export({ type: 'pkcs8', format: 'pem' }),
    { algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:app:999999' }
  );
  const adminAuth = { 'x-usernode-token': tokenFor('Staging-Demo-Admin', 777666222) };
  const plainAuth = { 'x-usernode-token': tokenFor('staging-demo-plain-1', 777666223) };

  // Case-insensitive match against the secret; role resolves on the request.
  const ok = await fetch(base + '/api/v1/admin/users', { headers: adminAuth });
  assert.equal(ok.status, 200);
  const denied = await fetch(base + '/api/v1/admin/users', { headers: plainAuth });
  assert.equal(denied.status, 403, 'a username outside the secret is not an admin');

  // The panel cannot grant admin: role edits are refused with a pointer to
  // the secret.
  const who = await (await fetch(base + '/api/v1/admin/users', { headers: adminAuth })).json();
  const target = who.users.find(u => u.username === 'staging-demo-plain-1');
  assert.ok(target, 'the admin user list must include the just-created plain user');
  const patch = await fetch(base + `/api/v1/admin/users/${target.id}`, {
    method: 'PATCH',
    headers: { ...adminAuth, 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin', reason: 'test' }),
  });
  assert.equal(patch.status, 400);
  assert.match((await patch.json()).error, /ADMIN_USERNAMES/);
}, { timeout: 20000 });

t('a username held by a stale row resolves to the current platform id', async () => {
  if (!httpServer) {
    process.env.PORT = '0';
    const { start } = require('../server');
    httpServer = await start();
  }
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  const tokenFor = (username, id) => jwt.sign(
    { id, username, pur: 'iframe' },
    testPrivateKey.export({ type: 'pkcs8', format: 'pem' }),
    { algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:app:999999' }
  );
  // Simulate a platform rename: an old row holds the name under a different
  // usernode_id. The current holder must still resolve, not 404.
  const staleId = 777666900 + Math.floor(Math.random() * 90);
  const freshId = 777667000 + Math.floor(Math.random() * 90);
  const name = 'staging-demo-rename-' + Date.now() % 100000000;
  const oldAuth = { 'x-usernode-token': tokenFor(name, staleId) };
  assert.equal((await fetch(base + '/api/v1/users/me', { headers: oldAuth })).status, 200);
  // Fresh platform user arrives with the same username and a new id.
  const newAuth = { 'x-usernode-token': tokenFor(name, freshId) };
  const res = await fetch(base + '/api/v1/users/me', { headers: newAuth });
  assert.equal(res.status, 200, 'the new holder of the name is not bricked by the stale row');
  const me = (await res.json()).user;
  assert.equal(me.usernode_id, freshId);
  // And the old id still resolves, under its renamed-aside handle.
  const old = await fetch(base + '/api/v1/users/me', { headers: oldAuth });
  assert.equal(old.status, 200, 'the renamed-aside row still resolves for its owner');
  assert.match((await old.json()).user.username, /-stale-/);
}, { timeout: 20000 });

t('campaign transitions are enforced server-side with an admin bypass', async () => {
  if (!httpServer) {
    process.env.PORT = '0';
    const { start } = require('../server');
    httpServer = await start();
  }
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  const tokenFor = (username, id) => jwt.sign(
    { id, username, pur: 'iframe' },
    testPrivateKey.export({ type: 'pkcs8', format: 'pem' }),
    { algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:app:999999' }
  );
  // staging-demo-user-1 owns the seeded Octra Builders project (the seed
  // mints demo users at usernode_id 900000+i).
  const owner = { 'x-usernode-token': tokenFor('staging-demo-user-1', 900001), 'content-type': 'application/json' };
  const plain = { 'x-usernode-token': tokenFor('staging-demo-plain-2', 777666333), 'content-type': 'application/json' };
  const proj = await (await fetch(base + '/api/v1/projects/staging-demo-octra-builders', { headers: owner })).json();
  assert.ok(proj.project, 'seeded project must be readable');

  const created = await fetch(base + `/api/v1/projects/${proj.project.id}/campaigns`, {
    method: 'POST', headers: owner,
    body: JSON.stringify({ name: 'Integration Transition Campaign', status: 'draft' }),
  });
  const createdBody = await created.json();
  assert.equal(created.status, 200, JSON.stringify(createdBody));
  const camp = createdBody.campaign;

  // A non-member cannot edit it at all.
  const denied = await fetch(base + `/api/v1/campaigns/${camp.id}`, {
    method: 'PATCH', headers: plain,
    body: JSON.stringify({ status: 'active' }),
  });
  assert.equal(denied.status, 403);

  // draft -> active is legal, active -> archived is not.
  const goLive = await fetch(base + `/api/v1/campaigns/${camp.id}`, {
    method: 'PATCH', headers: owner, body: JSON.stringify({ status: 'active' }),
  });
  assert.equal(goLive.status, 200);
  assert.equal((await goLive.json()).campaign.status, 'active');
  const illegal = await fetch(base + `/api/v1/campaigns/${camp.id}`, {
    method: 'PATCH', headers: owner, body: JSON.stringify({ status: 'archived' }),
  });
  assert.equal(illegal.status, 400);
  assert.match((await illegal.json()).error, /cannot move to archived/);

  // A platform admin may archive from live (the admin panel's button).
  process.env.ADMIN_USERNAMES = 'staging-demo-admin';
  const admin = { 'x-usernode-token': tokenFor('staging-demo-admin', 777666222), 'content-type': 'application/json' };
  const forced = await fetch(base + `/api/v1/campaigns/${camp.id}`, {
    method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'archived', reason: 'test' }),
  });
  assert.equal(forced.status, 200);

  // The campaign directory endpoint filters by whitelisted status only.
  const list = await (await fetch(base + '/api/v1/campaigns?status=scheduled', { headers: owner })).json();
  assert.ok((list.campaigns || []).some(c => c.slug === 'staging-demo-on-chain-pioneer'));
  const bogus = await (await fetch(base + '/api/v1/campaigns?status=nonsense', { headers: owner })).json();
  assert.ok((bogus.campaigns || []).every(c => c.status === 'active'), 'unknown statuses fall back to active');
}, { timeout: 20000 });

t('scoped rewards: leaderboards never leak across projects, and delete guards hold', async () => {
  // A completion in one project must never appear in another project's sum.
  const octra = (await pool.query(`SELECT id FROM projects WHERE slug = 'staging-demo-octra-builders'`)).rows[0];
  const nebula = (await pool.query(`SELECT id FROM projects WHERE slug = 'staging-demo-nebula-ai'`)).rows[0];
  assert.ok(octra && nebula, 'both seeded projects exist');

  // Every quest-scoped reward row carries the full scope chain.
  const scope = await pool.query(
    `SELECT COUNT(*)::int AS n FROM xp_events x
     JOIN quests q ON q.id = x.quest_id JOIN campaigns c ON c.id = q.campaign_id
     WHERE x.source_type = 'quest' AND (x.project_id IS NULL OR x.campaign_id IS NULL
       OR x.project_id <> c.project_id OR x.campaign_id <> q.campaign_id)`);
  assert.equal(scope.rows[0].n, 0, 'awarded xp rows carry the correct project/campaign/quest scope');

  const pscope = await pool.query(
    `SELECT COUNT(*)::int AS n FROM points_events e
     JOIN quests q ON q.id = e.quest_id JOIN campaigns c ON c.id = q.campaign_id
     WHERE e.source_type = 'quest' AND (e.project_id IS NULL OR e.project_id <> c.project_id)`);
  assert.equal(pscope.rows[0].n, 0, 'awarded points rows carry the correct project scope');

  // Isolation by sum: the Octra board sums only Octra-tagged rows.
  const octraSum = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::int AS xp FROM xp_events WHERE project_id = $1`, [octra.id]);
  const nebulaSum = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::int AS xp FROM xp_events WHERE project_id = $1`, [nebula.id]);
  assert.ok(octraSum.rows[0].xp > 0 && nebulaSum.rows[0].xp > 0, 'both projects hold scoped XP');
  const mixed = await pool.query(
    `SELECT COUNT(*)::int AS n FROM xp_events e JOIN quests q ON q.id = e.quest_id
     JOIN campaigns c ON c.id = q.campaign_id
     WHERE e.project_id = $1 AND c.project_id <> $1`, [octra.id]);
  assert.equal(mixed.rows[0].n, 0, "no Octra row belongs to another project's quest");

  // Completing a Nebula quest does not move the Octra board.
  const nebulaQuest = (await pool.query(
    `SELECT q.id FROM quests q JOIN campaigns c ON c.id = q.campaign_id
     WHERE c.project_id = $1 AND q.status = 'active' ORDER BY q.id LIMIT 1`, [nebula.id])).rows[0];
  const u3 = (await pool.query(`SELECT id FROM users WHERE username = 'staging-demo-user-3'`)).rows[0];
  await pool.query('DELETE FROM quest_completions WHERE quest_id = $1 AND user_id = $2', [nebulaQuest.id, u3.id]);
  const tasks = await pool.query('SELECT id FROM quest_tasks WHERE quest_id = $1', [nebulaQuest.id]);
  for (const task of tasks.rows) {
    await pool.query(
      `INSERT INTO task_submissions (task_id, quest_id, user_id, proof_type, proof_url, status, reviewer_id, reviewed_at)
       VALUES ($1, $2, $3, 'manual', 'https://example.com/ok', 'verified', $3, NOW())`,
      [task.id, nebulaQuest.id, u3.id]);
  }
  const before = (await pool.query('SELECT COALESCE(SUM(amount),0)::int AS xp FROM xp_events WHERE project_id = $1', [octra.id])).rows[0].xp;
  const { completeQuest } = require('../src/reward');
  const done = await completeQuest(nebulaQuest.id, u3.id);
  assert.equal(done.completed, true, 'the Nebula quest must complete');
  const after = (await pool.query('SELECT COALESCE(SUM(amount),0)::int AS xp FROM xp_events WHERE project_id = $1', [octra.id])).rows[0].xp;
  assert.equal(before, after, 'a completion in project B never moves project A\'s sum');
  const nb = await pool.query(
    `SELECT project_id, campaign_id, quest_id FROM quest_completions WHERE quest_id = $1 AND user_id = $2`,
    [nebulaQuest.id, u3.id]);
  assert.equal(nb.rows[0].project_id, nebula.id, 'the completion is stamped with its project');

  // Delete guards: a quest with completions is archived, never deleted.
  const ownerToken = (u, id) => jwt.sign({ id, username: u, pur: 'iframe' },
    testPrivateKey.export({ type: 'pkcs8', format: 'pem' }),
    { algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:app:999999' });
  if (!httpServer) {
    process.env.PORT = '0';
    const { start } = require('../server');
    httpServer = await start();
  }
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  const owner = { 'x-usernode-token': ownerToken('staging-demo-user-1', 900001), 'content-type': 'application/json' };
  // A quest that already has a completion in the seed.
  const doneQuest = (await pool.query('SELECT quest_id FROM quest_completions LIMIT 1')).rows[0].quest_id;
  const del = await fetch(base + `/api/v1/quests/${doneQuest}`, { method: 'DELETE', headers: owner });
  assert.equal(del.status, 200);
  const delBody = await del.json();
  assert.equal(delBody.archived, true, 'a quest with completions is archived, not deleted');
  const stillThere = await pool.query('SELECT status FROM quests WHERE id = $1', [doneQuest]);
  assert.equal(stillThere.rows[0].status, 'archived');

  // Membership endpoints reject a non-manager and accept the owner.
  const plain = { 'x-usernode-token': ownerToken('staging-demo-plain-m', 777777001), 'content-type': 'application/json' };
  const deniedMembers = await fetch(base + `/api/v1/projects/${octra.id}/members`, { headers: plain });
  assert.equal(deniedMembers.status, 403, 'a non-member cannot read the roster');
  const okMembers = await fetch(base + `/api/v1/projects/${octra.id}/members`, { headers: owner });
  assert.equal(okMembers.status, 200);
  const roster = await okMembers.json();
  assert.ok(roster.members.some(m => m.role === 'admin'), 'the seeded admin membership is visible');
  // A bogus role is refused.
  const badRole = await fetch(base + `/api/v1/projects/${octra.id}/members`, {
    method: 'POST', headers: owner, body: JSON.stringify({ username: 'staging-demo-user-1', role: 'superuser' }),
  });
  assert.equal(badRole.status, 400);

  // Scoped leaderboard endpoint returns a ranking per scope.
  const plb = await fetch(base + `/api/v1/projects/${octra.id}/leaderboard?metric=xp`, { headers: owner });
  assert.equal(plb.status, 200);
  const plbBody = await plb.json();
  assert.equal(plbBody.scope, 'project');
  assert.ok(plbBody.entries.length > 0);
  assert.ok(plbBody.entries.some(e => /^staging-demo-user/.test(e.username)),
    'the seeded demo users appear on the Octra project board');
  // Narrowing by another project's campaign is refused, not silently ignored.
  const camp = (await pool.query('SELECT c.id FROM campaigns c WHERE c.project_id = $1 LIMIT 1', [nebula.id])).rows[0];
  const cross = await fetch(base + `/api/v1/projects/${octra.id}/leaderboard?campaign=${camp.id}`, { headers: owner });
  assert.equal(cross.status, 404, 'a campaign from another project cannot narrow this board');
}, { timeout: 30000 });

t('project ownership: create assigns owner, cross-project ids are refused, delete guard', async () => {
  if (!httpServer) {
    process.env.PORT = '0';
    const { start } = require('../server');
    httpServer = await start();
  }
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  const run = String(Date.now()).slice(-7);
  const tokenFor = (username, id) => jwt.sign(
    { id, username, pur: 'iframe' },
    testPrivateKey.export({ type: 'pkcs8', format: 'pem' }),
    { algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:app:999999' }
  );
  const h = (name, id) => ({ 'x-usernode-token': tokenFor(name, id), 'content-type': 'application/json' });
  const ownerA = h('staging-demo-owner-a-' + run, 810000000 + Number(run));
  const ownerC = h('staging-demo-owner-c-' + run, 820000000 + Number(run));
  const manager = h('staging-demo-manager-' + run, 830000000 + Number(run));
  const helper = h('staging-demo-helper-' + run, 840000000 + Number(run));
  const nobody = h('staging-demo-nobody-' + run, 850000000 + Number(run));

  // Register the identities so they resolve against the local users table.
  for (const auth of [ownerA, ownerC, manager, helper, nobody]) {
    assert.equal((await fetch(base + '/api/v1/users/me', { headers: auth })).status, 200);
  }
  const uidOf = async (name) => (await pool.query('SELECT id FROM users WHERE username = $1', [name])).rows[0].id;

  // --- Ownership on create: the creator is owner and gets an owner row. ---
  const projA = (await (await fetch(base + '/api/v1/projects', {
    method: 'POST', headers: ownerA, body: JSON.stringify({ name: 'Ownership Test Alpha ' + run }),
  })).json()).project;
  const projB = (await (await fetch(base + '/api/v1/projects', {
    method: 'POST', headers: ownerA, body: JSON.stringify({ name: 'Ownership Test Beta ' + run }),
  })).json()).project;
  const projC = (await (await fetch(base + '/api/v1/projects', {
    method: 'POST', headers: ownerC, body: JSON.stringify({ name: 'Ownership Test Gamma ' + run }),
  })).json()).project;
  assert.ok(projA && projB && projC, 'projects created');
  const ownerAId = await uidOf('staging-demo-owner-a-' + run);
  const ownerRow = await pool.query('SELECT owner_user_id FROM projects WHERE id = $1', [projA.id]);
  assert.equal(Number(ownerRow.rows[0].owner_user_id), ownerAId, 'owner_user_id is the creator');
  const ownerMember = await pool.query(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [projA.id, ownerAId]);
  assert.equal(ownerMember.rows[0].role, 'owner', 'the creator gets a project_members owner row');

  // A campaign + quest in project B, the target of the cross-project attempts.
  const campB = (await (await fetch(base + `/api/v1/projects/${projB.id}/campaigns`, {
    method: 'POST', headers: ownerA, body: JSON.stringify({ name: 'Beta Campaign ' + run, status: 'active' }),
  })).json()).campaign;
  const questB = (await (await fetch(base + `/api/v1/campaigns/${campB.id}/quests`, {
    method: 'POST', headers: ownerA,
    body: JSON.stringify({ title: 'Beta Quest ' + run, xp_reward: 10, tasks: [{ type: 'manual', title: 'Do it' }] }),
  })).json()).quest;
  assert.ok(campB && questB, 'campaign and quest created in project B');

  // Manager belongs to project C only.
  const added = await fetch(base + `/api/v1/projects/${projC.id}/members`, {
    method: 'POST', headers: ownerC, body: JSON.stringify({ username: 'staging-demo-manager-' + run, role: 'admin' }),
  });
  assert.equal(added.status, 200);
  assert.equal((await fetch(base + `/api/v1/projects/${projC.id}/members`, { headers: manager })).status, 200,
    'the manager can manage project C');

  // --- Cross-project refusal: a manager of C cannot touch B, whatever the id. ---
  const crossPatch = await fetch(base + `/api/v1/campaigns/${campB.id}`, {
    method: 'PATCH', headers: manager, body: JSON.stringify({ name: 'hijack', project_id: projC.id }),
  });
  assert.equal(crossPatch.status, 403, 'a non-owner manager cannot edit another project\'s campaign');
  const crossQuest = await fetch(base + `/api/v1/quests/${questB.id}`, {
    method: 'PATCH', headers: manager, body: JSON.stringify({ title: 'hijack' }),
  });
  assert.equal(crossQuest.status, 403, 'a non-owner manager cannot edit another project\'s quest');
  const crossDelete = await fetch(base + `/api/v1/quests/${questB.id}`, { method: 'DELETE', headers: manager });
  assert.equal(crossDelete.status, 403, 'a non-owner manager cannot delete another project\'s quest');
  const crossCreate = await fetch(base + `/api/v1/projects/${projA.id}/campaigns`, {
    method: 'POST', headers: manager, body: JSON.stringify({ name: 'sneak' }),
  });
  assert.equal(crossCreate.status, 403, 'a non-owner manager cannot create in another project');
  // The id in the body cannot move the resource either.
  const bodySwap = await fetch(base + `/api/v1/campaigns/${campB.id}`, {
    method: 'PATCH', headers: ownerA, body: JSON.stringify({ name: 'ok-swap', project_id: projC.id }),
  });
  const swapped = await (await bodySwap.json()).campaign;
  assert.equal(swapped.project_id, projB.id, 'the server ignores a project_id supplied in the body');

  // --- A stranger is refused everywhere. ---
  for (const [method, path] of [
    ['GET', `/api/v1/projects/${projA.id}/members`],
    ['GET', `/api/v1/projects/${projA.id}/deletion-preview`],
    ['POST', `/api/v1/projects/${projA.id}/campaigns`],
    ['PATCH', `/api/v1/campaigns/${campB.id}`],
    ['DELETE', `/api/v1/quests/${questB.id}`],
    ['DELETE', `/api/v1/projects/${projA.id}`],
  ]) {
    const res = await fetch(base + path, { method, headers: nobody, body: method === 'GET' ? undefined : '{}' });
    assert.equal(res.status, 403, `a non-member gets 403 on ${method} ${path}`);
  }

  // --- Role defaults: admin without a grant cannot delete; the owner can grant. ---
  const deniedDelete = await fetch(base + `/api/v1/projects/${projC.id}`, { method: 'DELETE', headers: manager });
  assert.equal(deniedDelete.status, 403, 'a project admin cannot delete the project by default');
  // Only the owner may hand out the flag: another admin cannot self-escalate.
  const helperId = await uidOf('staging-demo-helper-' + run);
  await fetch(base + `/api/v1/projects/${projC.id}/members`, {
    method: 'POST', headers: ownerC, body: JSON.stringify({ username: 'staging-demo-helper-' + run, role: 'admin' }),
  });
  const escalate = await fetch(base + `/api/v1/projects/${projC.id}/members/${helperId}`, {
    method: 'PATCH', headers: manager, body: JSON.stringify({ role: 'admin', permissions: { delete_project: true } }),
  });
  assert.equal(escalate.status, 403, 'only the owner may grant delete_project');
  const managerId = await uidOf('staging-demo-manager-' + run);
  const grant = await fetch(base + `/api/v1/projects/${projC.id}/members/${managerId}`, {
    method: 'PATCH', headers: ownerC, body: JSON.stringify({ role: 'admin', permissions: { delete_project: true } }),
  });
  assert.equal(grant.status, 200, 'the owner can grant delete_project');
  const allowedDelete = await fetch(base + `/api/v1/projects/${projC.id}`, { method: 'DELETE', headers: manager });
  assert.equal(allowedDelete.status, 200, 'with the grant, the admin can archive the project');
  const cAfter = await pool.query('SELECT status, deleted_at FROM projects WHERE id = $1', [projC.id]);
  assert.equal(cAfter.rows[0].status, 'archived');
  assert.ok(cAfter.rows[0].deleted_at, 'a soft delete stamps deleted_at');
  // Restore: the owner can bring it back.
  const restore = await fetch(base + `/api/v1/projects/${projC.id}`, {
    method: 'PATCH', headers: ownerC, body: JSON.stringify({ status: 'active' }),
  });
  assert.equal(restore.status, 200);
  const restored = await (await restore.json()).project;
  assert.equal(restored.status, 'active');
  assert.equal(restored.deleted_at, null, 'restoring clears the soft-delete mark');

  // --- Delete safety on project B. ---
  const preview = await fetch(base + `/api/v1/projects/${projB.id}/deletion-preview`, { headers: ownerA });
  assert.equal(preview.status, 200);
  const counts = (await preview.json()).counts;
  assert.ok(counts.campaigns >= 1 && counts.quests >= 1 && counts.tasks >= 1, 'the preview counts the children');

  const soft = await fetch(base + `/api/v1/projects/${projB.id}`, { method: 'DELETE', headers: ownerA });
  assert.equal(soft.status, 200);
  assert.equal((await soft.json()).archived, true);
  const stillThere = await pool.query('SELECT status FROM projects WHERE id = $1', [projB.id]);
  assert.equal(stillThere.rows[0].status, 'archived', 'a soft delete keeps the row');
  const childrenKept = await pool.query('SELECT COUNT(*)::int AS n FROM campaigns WHERE project_id = $1', [projB.id]);
  assert.ok(childrenKept.rows[0].n >= 1, 'a soft delete keeps the children');
  const dir = await (await fetch(base + '/api/v1/projects/directory', { headers: ownerA })).json();
  assert.ok(!dir.projects.some(x => x.id === projB.id), 'an archived project leaves the directory');
  assert.equal((await fetch(base + `/api/v1/projects/${projB.slug}`, { headers: nobody })).status, 404,
    'an archived project is not publicly reachable');
  assert.equal((await fetch(base + `/api/v1/projects/${projB.slug}`, { headers: ownerA })).status, 200,
    'its owner can still open an archived project');
  // Restore, then hard delete.
  assert.equal((await fetch(base + `/api/v1/projects/${projB.id}`, {
    method: 'PATCH', headers: ownerA, body: JSON.stringify({ status: 'active' }),
  })).status, 200);
  const hard = await fetch(base + `/api/v1/projects/${projB.id}?mode=hard`, { method: 'DELETE', headers: ownerA });
  assert.equal(hard.status, 200);
  assert.equal((await hard.json()).mode, 'hard');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM projects WHERE id = $1', [projB.id])).rows[0].n, 0,
    'a hard delete removes the project row');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM campaigns WHERE project_id = $1', [projB.id])).rows[0].n, 0,
    'a hard delete cascades to campaigns');

  // --- Project settings: edit + visibility round-trip. ---
  const settings = await fetch(base + `/api/v1/projects/${projA.id}`, {
    method: 'PATCH', headers: ownerA,
    body: JSON.stringify({ description: 'updated', visibility: 'unlisted', logo_url: 'https://example.com/l.png' }),
  });
  assert.equal(settings.status, 200);
  const sProject = (await settings.json()).project;
  assert.equal(sProject.visibility, 'unlisted');
  assert.equal(sProject.logo_url, 'https://example.com/l.png');
}, { timeout: 40000 });


// Multi-chain wallet linking: Ed25519 chains verify over HTTP, the address
// columns hold 66-char Sui/Aptos addresses, cross-chain reuse stays separate,
// and a wallet already owned by another account is refused (409).
t('multi-chain wallet link signs over HTTP and refuses cross-account claims', async () => {
  const jwt = require('jsonwebtoken');
  const crypto = require('node:crypto');
  if (!httpServer) {
    process.env.PORT = '0';
    const { start } = require('../server');
    httpServer = await start();
  }
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  const idA = 800000000 + Math.floor(Math.random() * 90000000);
  const idB = idA + 1;
  const tokenFor = (id, username) => jwt.sign(
    { id, username, pur: 'iframe' },
    testPrivateKey.export({ type: 'pkcs8', format: 'pem' }),
    { algorithm: 'RS256', issuer: 'usernode', audience: 'usernode:app:999999' }
  );
  const json = { 'content-type': 'application/json' };
  const authA = { ...json, 'x-usernode-token': tokenFor(idA, 'staging-demo-chain-a-' + Date.now() % 100000) };
  const authB = { ...json, 'x-usernode-token': tokenFor(idB, 'staging-demo-chain-b-' + Date.now() % 100000) };

  // A Solana Ed25519 keypair: the base58 public key IS the address.
  const kp = crypto.generateKeyPairSync('ed25519');
  const raw = kp.publicKey.export({ type: 'spki', format: 'der' }).slice(12);
  const solAddress = require('../src/verify/bs58').encode(raw);

  const ch = await (await fetch(base + '/api/v1/wallets/challenge', {
    method: 'POST', headers: authA,
    body: JSON.stringify({ chain: 'solana', address: solAddress }),
  })).json();
  assert.ok(ch.nonce && ch.message.includes(solAddress), 'challenge binds the nonce to the address');
  const sig = crypto.sign(null, Buffer.from(ch.message), kp.privateKey);
  const sigB64 = sig.toString('base64');
  const ok = await fetch(base + '/api/v1/wallets/verify', {
    method: 'POST', headers: authA,
    body: JSON.stringify({ chain: 'solana', address: solAddress, signature: sigB64, nonce: ch.nonce }),
  });
  assert.equal(ok.status, 200, JSON.stringify(await ok.json().catch(() => ({}))));
  const mine = await (await fetch(base + '/api/v1/wallets', { headers: authA })).json();
  const linked = (mine.wallets || []).find(w => w.address === solAddress);
  assert.ok(linked && linked.chain === 'solana', 'the linked wallet reports its chain');
  assert.equal(linked.label, 'Solana', 'the API returns the plain chain label');

  // A second account cannot claim the same (address, chain): 409, no reassign.
  const chB = await (await fetch(base + '/api/v1/wallets/challenge', {
    method: 'POST', headers: authB,
    body: JSON.stringify({ chain: 'solana', address: solAddress }),
  })).json();
  const sigB = crypto.sign(null, Buffer.from(chB.message), kp.privateKey);
  const steal = await fetch(base + '/api/v1/wallets/verify', {
    method: 'POST', headers: authB,
    body: JSON.stringify({ chain: 'solana', address: solAddress, signature: sigB.toString('base64'), nonce: chB.nonce }),
  });
  assert.equal(steal.status, 409);
  const owner = await pool.query('SELECT user_id FROM wallets WHERE address = $1 AND chain_namespace = $2', [solAddress, 'solana']);
  assert.equal(Number(owner.rows[0].user_id), (await pool.query('SELECT id FROM users WHERE usernode_id = $1', [String(idA)])).rows[0].id,
    'ownership did not move');

  // A 66-char Sui-style address is accepted, proving the column widening.
  const suiAddr = '0x' + raw.toString('hex');
  const chS = await (await fetch(base + '/api/v1/wallets/challenge', {
    method: 'POST', headers: authA,
    body: JSON.stringify({ chain: 'sui', address: suiAddr }),
  })).json();
  assert.ok(chS.nonce, 'a 66-char Sui address is accepted');
  const sigS = crypto.sign(null, Buffer.from(chS.message), kp.privateKey);
  const suiOk = await fetch(base + '/api/v1/wallets/verify', {
    method: 'POST', headers: authA,
    body: JSON.stringify({ chain: 'sui', address: suiAddr, signature: sigS.toString('base64'), publicKey: raw.toString('base64'), nonce: chS.nonce }),
  });
  assert.equal(suiOk.status, 200, 'the same key on a different chain is a separate wallet');

  // An unknown chain is refused before any signature work.
  const bad = await fetch(base + '/api/v1/wallets/challenge', {
    method: 'POST', headers: authA, body: JSON.stringify({ chain: 'dogecoin', address: 'D123' }),
  });
  assert.equal(bad.status, 400);

  // The profile payload the Wallets tab reads exposes the VIEWED user's
  // verified wallets (public addresses), so someone else's profile shows
  // their linked wallets, not the caller's.
  const prof = await (await fetch(base + '/api/v1/users/staging-demo-user-1', { headers: authB })).json();
  assert.ok(Array.isArray(prof.wallets) && prof.wallets.length === 5,
    'the demo profile carries its five seeded wallets');
  assert.ok(prof.wallets.some(w => w.chain_namespace === 'solana'), 'each row names its chain');
}, { timeout: 40000 });


after(async () => {
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  if (pool) await pool.end();
});
