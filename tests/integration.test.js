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
  assert.equal(Number(referralXp.rows[0].s), 100, 'referrer must be paid the referral XP exactly once');
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
