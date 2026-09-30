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

after(async () => {
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  if (pool) await pool.end();
});
