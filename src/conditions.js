// Quest lock evaluation. A quest_conditions row may name prerequisite
// quests in config.requires_quests; operator 'all' (the default) requires
// every one completed, 'any' at least one. The lock state is always
// computed from quest_completions on the server: the frontend may display
// it, but it can never grant it.
const { pool } = require('./db');

// Pure core, unit-tested in isolation: given the condition row's operator
// and prerequisite list, the viewer id, and the set of quests that viewer
// has completed, is the quest locked? An anonymous viewer gets no lock
// state (the endpoints render completion-based locks per signed-in user).
function evaluateLock(userId, operator, requiredIds, completedSet) {
  if (!userId || !requiredIds.length) return false;
  const missing = requiredIds.filter(id => !completedSet.has(id));
  if (operator === 'any') return missing.length === requiredIds.length;
  return missing.length > 0;
}

async function lockState(questId, userId) {
  if (!userId) return { locked: false, reason: null };
  const { rows } = await pool.query(
    'SELECT operator, config FROM quest_conditions WHERE quest_id = $1 LIMIT 1', [questId]);
  if (!rows.length) return { locked: false, reason: null };
  const required = ((rows[0].config && rows[0].config.requires_quests) || [])
    .map(Number).filter(Number.isFinite);
  if (!required.length) return { locked: false, reason: null };
  const done = await pool.query(
    'SELECT quest_id FROM quest_completions WHERE user_id = $1 AND quest_id = ANY($2)',
    [userId, required]);
  const doneIds = new Set(done.rows.map(r => r.quest_id));
  const locked = evaluateLock(userId, rows[0].operator, required, doneIds);
  if (!locked) return { locked: false, reason: null };
  const titles = await pool.query('SELECT id, title FROM quests WHERE id = ANY($1)', [required]);
  const nameFor = id => {
    const row = titles.rows.find(t => t.id === id);
    return row ? `"${row.title}"` : 'a prerequisite quest';
  };
  const names = required.filter(id => !doneIds.has(id)).map(nameFor).join(', ');
  return { locked: true, reason: `Complete ${names} to unlock this quest.` };
}

module.exports = { lockState, evaluateLock };
