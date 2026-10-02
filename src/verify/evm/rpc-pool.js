// A pool of RPC endpoints for one EVM network, with automatic failover.
// Endpoints are ordered primary first, then by priority. call(fn) runs `fn`
// against each provider in turn with bounded exponential backoff and
// rotation, and throws RpcUnavailableError only after every endpoint in every
// round has failed. The raw URL is never returned to a caller that renders to
// a participant; only the endpoint's masked host leaves this module.

const { ethers } = require('ethers');
const { pool } = require('../../db');
const { RpcUnavailableError } = require('../errors');

function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
  } catch { return 'rpc'; }
}

// Credentials come from the app secret EVM_RPC_CREDENTIALS: a map of
// credential name to header additions. Missing credentials for an endpoint
// that needs them is a configuration fault, surfaced by the caller as
// INVALID_CONFIGURATION rather than a request without auth.
function loadCredentials() {
  const raw = process.env.EVM_RPC_CREDENTIALS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function buildProvider(endpoint, credentials) {
  const req = new ethers.FetchRequest(endpoint.url);
  if (endpoint.timeout_ms) req.timeout = Number(endpoint.timeout_ms) || 8000;
  const cred = endpoint.credential_ref ? credentials[endpoint.credential_ref] : null;
  if (cred && cred.headers && typeof cred.headers === 'object') {
    for (const [k, v] of Object.entries(cred.headers)) {
      try { req.setHeader(k, String(v)); } catch { /* invalid header name: ignore */ }
    }
  }
  // Pin the network so ethers does not re-run eth_chainId on every call; the
  // publish-time test is what checks the chain id for real.
  const network = endpoint.chain_id !== undefined && endpoint.chain_id !== null
    ? Number(endpoint.chain_id) : undefined;
  return new ethers.JsonRpcProvider(req, network, { staticNetwork: !!network });
}

function isTransient(err) {
  // A call that reached the chain and got a definitive answer is not
  // transient; anything else (timeout, 5xx, rate limit, malformed body) is
  // worth trying on the next endpoint.
  const msg = String((err && (err.shortMessage || err.message)) || '');
  if (err && err.code === 'CALL_EXCEPTION') return false;
  return /timeout|timed out|fetch|network|socket|ECONN|rate|429|50[0-9]|bad response|invalid json|missing response/i.test(msg)
    || !msg;
}

class RpcPool {
  // providers: [{ provider, endpoint }]. `retries` is the number of extra
  // full rounds over the endpoint list after the first.
  constructor(providers, { retries = 2, baseDelayMs = 200 } = {}) {
    this.entries = providers || [];
    this.retries = Math.max(0, retries);
    this.baseDelayMs = baseDelayMs;
    this._latestBlock = null;
    this._latestBlockAt = 0;
  }

  get empty() { return this.entries.length === 0; }

  async call(fn) {
    if (this.empty) throw new RpcUnavailableError('No RPC endpoints are configured for this network');
    const tried = [];
    let lastError = null;
    for (let round = 0; round <= this.retries; round++) {
      for (const entry of this.entries) {
        try {
          const value = await fn(entry.provider, entry);
          return { value, endpoint: entry.endpoint };
        } catch (err) {
          lastError = err;
          tried.push(entry.endpoint ? maskUrl(entry.endpoint.url) : 'rpc');
          if (round < this.retries && this.baseDelayMs) {
            await new Promise((r) => setTimeout(r, Math.min(this.baseDelayMs * (round + 1), 1500)));
          }
        }
      }
    }
    throw new RpcUnavailableError('Every RPC endpoint failed', { tried, lastError });
  }

  // Short-lived cache of the latest block so a re-run after a
  // WAITING_CONFIRMATIONS result is cheap and consistent within a run.
  async latestBlock() {
    const now = Date.now();
    if (this._latestBlock !== null && now - this._latestBlockAt < 4000) return this._latestBlock;
    const { value } = await this.call((provider) => provider.getBlockNumber());
    this._latestBlock = Number(value);
    this._latestBlockAt = now;
    return this._latestBlock;
  }
}

// Build a pool for a network row. Never throws for a missing credential:
// endpoints that need auth but have none are simply unusable, and the pool
// reports all-down, which the engine maps to RPC_UNAVAILABLE. The publish-time
// test turns that into INVALID_CONFIGURATION for the owner.
async function rpcPoolFor(networkId, { credentials } = {}) {
  const { rows } = await pool.query(
    `SELECT r.url, r.kind, r.priority, r.is_primary, r.credential_ref, r.timeout_ms, r.max_retries, n.chain_id
     FROM task_rpcs r JOIN task_networks n ON n.id = r.network_id
     WHERE r.network_id = $1
     ORDER BY r.is_primary DESC, r.priority ASC, r.id ASC`, [networkId]);
  const creds = credentials || loadCredentials();
  const usable = rows.filter((r) => !r.credential_ref || creds[r.credential_ref]);
  const providers = usable.map((endpoint) => ({ endpoint, provider: buildProvider(endpoint, creds) }));
  const retries = rows.length ? Math.min(...rows.map((r) => Number(r.max_retries) || 0)) : 2;
  return new RpcPool(providers, { retries });
}

module.exports = { RpcPool, rpcPoolFor, maskUrl, buildProvider, loadCredentials, isTransient };
