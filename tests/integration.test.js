// Integration tests: run against a scratch Postgres.
//   DATABASE_URL=postgres://... USERNODE_ENV=staging npm test
// The suite boots the app's own migrate+seed path, so it exercises the same
// schema and staging seed block that staging runs use.
const { test, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const t = HAS_DB ? test : test.skip;

let pool;
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
}, { timeout: 30000 });

after(async () => {
  if (pool) await pool.end();
});
