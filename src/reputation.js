const { pool } = require('./db');

// Reputation (Phase 3): a transparent sum of per-signal category deltas.
// The table is the record; the profile panel reads the itemized rows and
// the total is always SUM(delta), never a stored counter, so anyone can
// see exactly where a score came from.
const CATEGORIES = {
  quest_completed: 5,
  quest_rejected: -5,
  wallet_verified: 10,
  referral_qualified: 10,
};

// Pure so the category table is unit-testable without a database.
function deltaFor(category) {
  return CATEGORIES[category] || 0;
}

// Record one reputation event. Idempotent per (category, source): the
// UNIQUE constraint makes a re-run a no-op, so re-verifying a wallet or
// re-reviewing a submission never double-moves the score. source_id
// defaults to 0 (not NULL) because NULLs never collide in Postgres.
async function record(client, userId, category, sourceType, sourceId, note) {
  const delta = deltaFor(category);
  if (!delta) return { recorded: false };
  await (client || pool).query(
    `INSERT INTO reputation_events (user_id, category, delta, source_type, source_id, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (category, source_type, source_id, user_id) DO NOTHING`,
    [userId, category, delta, sourceType || '', sourceId || 0, note || null]
  );
  return { recorded: true };
}

// Itemized breakdown for the profile panel: one row per category.
async function breakdown(userId) {
  const { rows } = await pool.query(
    `SELECT category, COUNT(*)::int AS events, SUM(delta)::int AS sum
     FROM reputation_events WHERE user_id = $1
     GROUP BY category ORDER BY category`, [userId]);
  const total = rows.reduce((acc, r) => acc + Number(r.sum), 0);
  return {
    total,
    breakdown: rows.map(r => ({ category: r.category, events: Number(r.events), sum: Number(r.sum) })),
  };
}

module.exports = { CATEGORIES, deltaFor, record, breakdown };