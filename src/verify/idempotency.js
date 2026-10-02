// Idempotency keys for task completion and XP. Pure and chain-neutral: the
// transaction identity is (chain namespace + chain id + transaction id),
// which the spec requires because transaction ids are not globally unique
// and each chain names them differently (a hash, a signature, a digest).
//
// The adapter normalizes its transaction id before the engine builds a key
// from it, so this module never rewrites the id itself.

// An on-chain transaction's evidence key. logIndex is only meaningful for
// event-based checks; a chain without logs passes null and gets '-'.
function transactionKey({ chainNamespace, chainId, transactionId, logIndex, taskId }) {
  const ns = chainNamespace || 'unknown';
  const cid = chainId === undefined || chainId === null ? '-' : String(chainId);
  const log = logIndex === undefined || logIndex === null ? '-' : String(logIndex);
  return `chain:${ns}:${cid}:tx:${String(transactionId)}:log:${log}:task:${taskId}`;
}

// Balance or other non-transaction state: one completion per user per task
// per period. `once` for one-time and limited tasks; an ISO date, week or
// month for periodic modes.
function stateKey({ userId, taskId, completionPeriod }) {
  return `user:${userId}:task:${taskId}:${completionPeriod || 'once'}`;
}

// Build the key for a normalized verification result, choosing the shape from
// whether the evidence names a transaction.
function keyForResult(result, { userId, taskId, completionPeriod }) {
  if (result && result.transactionId) {
    return transactionKey({
      chainNamespace: result.chainNamespace || (result.network && result.network.namespace),
      chainId: result.chainId !== undefined ? result.chainId : (result.network && result.network.chainId),
      transactionId: result.transactionId,
      logIndex: result.logIndex,
      taskId,
    });
  }
  return stateKey({ userId, taskId, completionPeriod });
}

module.exports = { transactionKey, stateKey, keyForResult };
