const { pool } = require('./db');

// Referrals. A user shares /join?ref=<their code>; whoever signs in through
// it gets one pending referral row (UNIQUE referee_user_id — one invite
// ever). The referral qualifies when the referee has completed
// qualification_quests quests, checked server-side, and the referrer is paid
// once. Defaults live in platform_settings key 'referral', editable by
// admins; the constants below are only the fallback when no row exists.
const DEFAULT_RULES = { qualification_quests: 3, xp_reward: 100 };

// Pure so the rule defaults are unit-testable without a database.
function applyReferralRules(value) {
  const v = value && typeof value === 'object' ? value : {};
  const num = (x, d) => (Number.isFinite(x) ? x : d);
  return {
    qualification_quests: Math.max(1, num(v.qualification_quests, DEFAULT_RULES.qualification_quests)),
    xp_reward: Math.max(0, num(v.xp_reward, DEFAULT_RULES.xp_reward)),
  };
}

async function rules(client) {
  const c = client || pool;
  const { rows } = await c.query("SELECT value FROM platform_settings WHERE key = 'referral'");
  return applyReferralRules(rows[0] && rows[0].value);
}

// Stable per-user code, generated on first use.
async function getOrCreateCode(userId) {
  const existing = await pool.query('SELECT ref_code FROM users WHERE id = $1', [userId]);
  if (existing.rows[0] && existing.rows[0].ref_code) return existing.rows[0].ref_code;
  const { randomId } = require('./util');
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomId(8);
    const { rows } = await pool.query(
      `UPDATE users SET ref_code = $1 WHERE id = $2 AND ref_code IS NULL RETURNING ref_code`,
      [code, userId]
    );
    if (rows.length) return rows[0].ref_code;
    const again = await pool.query('SELECT ref_code FROM users WHERE id = $1', [userId]);
    if (again.rows[0] && again.rows[0].ref_code) return again.rows[0].ref_code;
  }
  throw new Error('Could not generate an invite code');
}

// Attach a referee to a referrer via a code. One referral per referee, ever.
// The referrer's identity is resolved from users.ref_code, so the code on
// the referral row is a record of what was shared, not the source of truth.
async function claim(code, refereeUserId) {
  const value = String(code || '').trim();
  if (!value) return { error: 'An invite code is required' };
  const referrer = await pool.query(
    'SELECT id, username FROM users WHERE ref_code = $1', [value]);
  if (!referrer.rows.length) return { error: 'This invite code is not valid' };
  if (referrer.rows[0].id === refereeUserId) return { error: 'You cannot use your own invite code' };
  const existing = await pool.query(
    'SELECT 1 FROM referrals WHERE referee_user_id = $1', [refereeUserId]);
  if (existing.rows.length) return { error: 'You already have an invite on record' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO referrals (referrer_user_id, referee_user_id, code, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [referrer.rows[0].id, refereeUserId, value]
    );
    await checkQualification(client, refereeUserId);
    await client.query('COMMIT');
    return { claimed: true, referrer_username: referrer.rows[0].username, referral_id: rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK');
    return { error: 'Could not record this invite' };
  } finally {
    client.release();
  }
}

// Called inside the reward transaction (and right after a claim): if the
// referee has reached the qualification count and the referral is still
// unpaid, pay the referrer once. The awardXp UNIQUE constraint and the
// status guard together make this a no-op on re-runs.
async function checkQualification(client, refereeUserId) {
  const pend = await client.query(
    `SELECT r.id, r.referrer_user_id FROM referrals r
     WHERE r.referee_user_id = $1 AND r.status = 'pending' AND r.rewarded_at IS NULL`,
    [refereeUserId]);
  if (!pend.rows.length) return { qualified: false };
  const cfg = await rules(client);
  const count = await client.query(
    'SELECT COUNT(*)::int AS n FROM quest_completions WHERE user_id = $1', [refereeUserId]);
  if (count.rows[0].n < cfg.qualification_quests) {
    return { qualified: false, need: cfg.qualification_quests - count.rows[0].n };
  }
  const r = pend.rows[0];
  const reward = require('./reward');
  await reward.awardXp(client, r.referrer_user_id, cfg.xp_reward, 'referral', r.id);
  const reputation = require('./reputation');
  await reputation.record(client, r.referrer_user_id, 'referral_qualified', 'referral', r.id);
  await client.query(
    `UPDATE referrals SET status = 'qualified', qualified_at = NOW(), rewarded_at = NOW() WHERE id = $1`,
    [r.id]);
  const referrer = await client.query('SELECT username FROM users WHERE id = $1', [r.referrer_user_id]);
  await client.query(
    `INSERT INTO notifications (user_id, type, title, body)
     VALUES ($1, 'referral_qualified', 'Invite qualified', $2)`,
    [r.referrer_user_id, `@${(referrer.rows[0] || {}).username || 'someone'} finished ${cfg.qualification_quests} quests. +${cfg.xp_reward} XP.`]);
  await client.query(
    `INSERT INTO notifications (user_id, type, title, body)
     VALUES ($1, 'referral_qualified', 'Invite bonus sent', $2)`,
    [refereeUserId, `You completed ${cfg.qualification_quests} quests and your inviter earned their bonus.`]);
  return { qualified: true, referral_id: r.id };
}

// Summary for the profile's invite block.
async function summary(userId) {
  const code = await getOrCreateCode(userId);
  const mine = await pool.query(
    `SELECT r.id, r.status, r.qualified_at, r.created_at, u.username
     FROM referrals r JOIN users u ON u.id = r.referee_user_id
     WHERE r.referrer_user_id = $1 ORDER BY r.created_at DESC LIMIT 20`, [userId]);
  const cfg = await rules(pool);
  return { code, referrals: mine.rows, qualification_quests: cfg.qualification_quests, xp_reward: cfg.xp_reward };
}

module.exports = { rules, applyReferralRules, getOrCreateCode, claim, checkQualification, summary, DEFAULT_RULES };