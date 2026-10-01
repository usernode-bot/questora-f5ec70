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
    body: JSON.stringify({ address: wallet.address }),
  })).json();
  assert.ok(ch.nonce && ch.message.includes(wallet.address.toLowerCase()), 'challenge must bind the nonce to the address');
  const signature = await wallet.signMessage(ch.message);
  const verified = await fetch(base + '/api/v1/wallets/verify', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ address: wallet.address, signature, nonce: ch.nonce }),
  });
  assert.equal(verified.status, 200, JSON.stringify(await verified.json().catch(() => ({}))));
  const mine = await (await fetch(base + '/api/v1/wallets', { headers: auth })).json();
  assert.ok((mine.wallets || []).some(w => w.address === wallet.address.toLowerCase() && w.verified_at));

  // The nonce is one-time: replaying it is refused.
  const replay = await fetch(base + '/api/v1/wallets/verify', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ address: wallet.address, signature, nonce: ch.nonce }),
  });
  assert.equal(replay.status, 400);

  // A signature by a DIFFERENT key does not vouch for the claimed address.
  const other = ethers.Wallet.createRandom();
  const ch2 = await (await fetch(base + '/api/v1/wallets/challenge', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ address: other.address }),
  })).json();
  const wrongSig = await wallet.signMessage(ch2.message);
  const wrong = await fetch(base + '/api/v1/wallets/verify', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ address: other.address, signature: wrongSig, nonce: ch2.nonce }),
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
    body: JSON.stringify({ status: 'live' }),
  });
  assert.equal(denied.status, 403);

  // draft -> live is legal, live -> archived is not.
  const goLive = await fetch(base + `/api/v1/campaigns/${camp.id}`, {
    method: 'PATCH', headers: owner, body: JSON.stringify({ status: 'live' }),
  });
  assert.equal(goLive.status, 200);
  assert.equal((await goLive.json()).campaign.status, 'live');
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
  const bogus = await (await fetch(base + '/api/v1/campaigns?status=draft', { headers: owner })).json();
  assert.ok((bogus.campaigns || []).every(c => c.status === 'live'), 'unknown statuses fall back to live');
}, { timeout: 20000 });

after(async () => {
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  if (pool) await pool.end();
});
