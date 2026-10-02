// The EVM verifier. Every EVM-specific assumption in the system lives in this
// file and its adapter: chain id, ABIs, receipts, logs, ERC-20, confirmations.
// It shares nothing of that with the engine. It implements exactly three
// Simple Mode methods and returns a normalized result.

const { ethers } = require('ethers');
const amount = require('../amount');
const { normalizeResult, chainPosition } = require('../chain-adapter');
const { IndexingDelayError, InvalidConfigurationError, RpcUnavailableError } = require('../errors');

// Minimal read-only ABI: balanceOf + decimals is all Simple Mode needs.
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const ERC20_IFACE = new ethers.Interface(ERC20_ABI);
const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

// Read a view function over eth_call. Using the raw provider.call rather than
// an ethers.Contract keeps the verifier's only provider dependency to one
// method, which is what the test seam injects.
async function ethCall(pool, to, method, args) {
  const data = ERC20_IFACE.encodeFunctionData(method, args);
  const { value } = await pool.call((provider) => provider.call({ to, data }));
  return ERC20_IFACE.decodeFunctionResult(method, value);
}

const DEFAULT_CONFIRMATIONS = 1;

function hexToBigInt(value) {
  try { return BigInt(value); } catch { return null; }
}

function normalizeAddr(a) {
  return typeof a === 'string' ? a.toLowerCase() : '';
}

// Ethereum's finality vocabulary: below the threshold it is N confirmations,
// at or above it we call it finalized. Cosmos/Solana etc. say it differently
// and do so in their own adapters.
function finalityFor(confirmations, threshold) {
  if (confirmations === null || confirmations === undefined) return 'unknown';
  if (confirmations >= threshold) return 'finalized';
  return 'n_confirmations';
}

async function networkInfo(pool) {
  // getNetwork() is cached per provider; the publish-time test checks the id.
  const { value } = await pool.call((provider) => provider.getNetwork());
  return { chainId: Number(value.chainId) };
}

async function readDecimals(pool, contractAddress) {
  const [dec] = await ethCall(pool, contractAddress, 'decimals', []);
  return Number(dec);
}

async function nativeBalance(ctx, pool) {
  const { network, wallet, config } = ctx;
  if (!wallet || !wallet.address) throw new InvalidConfigurationError('A wallet on this network is required');
  const decimals = Number(network.native_decimals);
  if (!Number.isInteger(decimals) || decimals < 0) throw new InvalidConfigurationError('The network has no native decimals configured');
  const { value, endpoint } = await pool.call((provider) => provider.getBalance(wallet.address));
  const actual = value;
  const cmp = amount.compare(actual, {
    amount: config.requirement && config.requirement.amount,
    decimals,
    operator: config.requirement && config.requirement.operator,
  });
  if (cmp.invalid) throw new InvalidConfigurationError(cmp.reason);
  const info = await networkInfo(pool);
  return normalizeResult({
    status: cmp.ok ? 'VERIFIED' : 'FAILED',
    reason: cmp.ok
      ? `Balance is at least ${config.requirement.amount} ${network.native_symbol || ''}`.trim()
      : `Balance is below the required ${config.requirement.amount} ${network.native_symbol || ''}`.trim(),
    network: { name: network.name, namespace: network.chain_namespace || 'eip155', chainId: info.chainId },
    chainId: info.chainId,
    chainPosition: chainPosition('block', await pool.latestBlock()),
    finality: 'finalized',
    evidence: { balance_base_units: actual.toString(), decimals, requirement: config.requirement, method: 'native_balance' },
    rawEvidence: { endpoint: endpoint ? endpoint.url : null, rpc_chain_id: info.chainId },
    steps: [{ step: 'eth_getBalance', address: wallet.address }],
    method: 'native_balance',
  }, ctx.adapter);
}

async function erc20Balance(ctx, pool) {
  const { network, wallet, token, config } = ctx;
  if (!wallet || !wallet.address) throw new InvalidConfigurationError('A wallet on this network is required');
  if (!token || !token.contract_address) throw new InvalidConfigurationError('No token is configured for this task');
  let decimals = token.decimals === null || token.decimals === undefined ? null : Number(token.decimals);
  const steps = [];
  if (!Number.isInteger(decimals)) {
    decimals = await readDecimals(pool, token.contract_address);
    steps.push({ step: 'decimals()', contract: token.contract_address, value: decimals });
  }
  const [bal] = await ethCall(pool, token.contract_address, 'balanceOf', [wallet.address]);
  const actual = bal;
  const cmp = amount.compare(actual, {
    amount: config.requirement && config.requirement.amount,
    decimals,
    operator: config.requirement && config.requirement.operator,
  });
  if (cmp.invalid) throw new InvalidConfigurationError(cmp.reason);
  const info = await networkInfo(pool);
  const symbol = token.symbol || 'tokens';
  return normalizeResult({
    status: cmp.ok ? 'VERIFIED' : 'FAILED',
    reason: cmp.ok
      ? `Balance is at least ${config.requirement.amount} ${symbol}`
      : `Balance is below the required ${config.requirement.amount} ${symbol}`,
    network: { name: network.name, namespace: network.chain_namespace || 'eip155', chainId: info.chainId },
    chainId: info.chainId,
    chainPosition: chainPosition('block', await pool.latestBlock()),
    finality: 'finalized',
    evidence: {
      balance_base_units: actual.toString(), decimals, token: token.contract_address,
      requirement: config.requirement, method: 'erc20_balance',
    },
    rawEvidence: { rpc_chain_id: info.chainId },
    steps: [{ step: 'erc20_balanceOf', token: token.contract_address, address: wallet.address }, ...steps],
    method: 'erc20_balance',
  }, ctx.adapter);
}

async function transaction(ctx, pool) {
  const { network, wallet, token, config, submission } = ctx;
  const hash = submission && submission.transaction_hash;
  if (!hash || typeof hash !== 'string') throw new InvalidConfigurationError('A transaction hash is required');
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new InvalidConfigurationError('That is not a valid transaction hash');

  const txRes = await pool.call((provider) => provider.getTransaction(hash));
  const tx = txRes.value;

  const receiptRes = await pool.call((provider) => provider.getTransactionReceipt(hash));
  const receipt = receiptRes.value;

  // A hash the node has not seen: never a user failure before the evidence
  // can exist. A mined-but-unextracted receipt is the same.
  if (!tx || !receipt) {
    throw new IndexingDelayError('The chain has not shown this transaction yet');
  }

  const info = await networkInfo(pool);
  const latest = await pool.latestBlock();
  const blockNumber = Number(receipt.blockNumber);
  const confirmations = Math.max(0, latest - blockNumber + 1);
  const threshold = Math.max(1, Number(config.confirmations) || DEFAULT_CONFIRMATIONS);
  const base = {
    transactionId: hash,
    logIndex: null,
    network: { name: network.name, namespace: network.chain_namespace || 'eip155', chainId: info.chainId },
    chainId: info.chainId,
    chainPosition: chainPosition('block', blockNumber),
    confirmations,
    finality: finalityFor(confirmations, threshold),
    evidence: {
      tx_hash: hash, from: receipt.from, to: receipt.to, block_number: blockNumber,
      confirmations, status: Number(receipt.status), method: 'transaction',
    },
    rawEvidence: { raw_transaction: tx, raw_receipt: receipt },
    steps: [{ step: 'eth_getTransactionByHash', hash }, { step: 'eth_getTransactionReceipt', hash }],
    method: 'transaction',
  };

  // A reverted transaction is a genuine, user-facing failure.
  if (Number(receipt.status) !== 1) {
    return normalizeResult({ ...base, status: 'FAILED', reason: 'That transaction reverted on chain.' }, ctx.adapter);
  }

  // Sender must be the linked wallet.
  const from = normalizeAddr(tx.from);
  if (wallet && wallet.address && from !== normalizeAddr(wallet.address)) {
    return normalizeResult({
      ...base, status: 'FAILED',
      reason: 'That transaction was not sent from your connected wallet.',
    }, ctx.adapter);
  }

  // Recipient / contract constraints, when configured.
  const toConstraint = config.to ? normalizeAddr(config.to) : null;
  const contractConstraint = config.contract ? normalizeAddr(config.contract) : null;
  const recipient = normalizeAddr(tx.to);
  if (toConstraint && recipient !== toConstraint) {
    return normalizeResult({ ...base, status: 'FAILED', reason: 'That transaction was sent to a different address.' }, ctx.adapter);
  }
  if (contractConstraint && recipient !== contractConstraint) {
    return normalizeResult({ ...base, status: 'FAILED', reason: 'That transaction did not call the configured contract.' }, ctx.adapter);
  }

  // Confirmations gate: not a failure, just not yet.
  if (confirmations < threshold) {
    return normalizeResult({
      ...base, status: 'WAITING_CONFIRMATIONS',
      reason: `Waiting for confirmations (${confirmations} of ${threshold}).`,
    }, ctx.adapter);
  }

  // Amount: either a native value or an ERC-20 Transfer amount.
  if (config.requirement && config.requirement.amount !== undefined && config.requirement.amount !== '') {
    let observed = null;
    if (token && token.contract_address) {
      observed = await erc20TransferAmount(pool, receipt, tx, token, wallet, toConstraint);
      if (observed === null) {
        return normalizeResult({
          ...base, status: 'FAILED',
          reason: 'That transaction did not transfer the required token to the expected address.',
        }, ctx.adapter);
      }
    } else {
      observed = tx.value;
    }
    const decimals = token && token.contract_address
      ? (token.decimals === null || token.decimals === undefined ? await readDecimals(pool, token.contract_address) : Number(token.decimals))
      : Number(network.native_decimals);
    const cmp = amount.compare(observed, {
      amount: config.requirement.amount,
      decimals,
      operator: config.requirement.operator,
    });
    if (cmp.invalid) throw new InvalidConfigurationError(cmp.reason);
    if (!cmp.ok) {
      return normalizeResult({
        ...base,
        status: 'FAILED',
        reason: 'That transaction did not transfer enough to meet this task.',
        evidence: { ...base.evidence, transferred_base_units: observed.toString(), requirement: config.requirement },
      }, ctx.adapter);
    }
  }

  return normalizeResult({
    ...base, status: 'VERIFIED',
    reason: `Transaction confirmed with ${confirmations} confirmation${confirmations === 1 ? '' : 's'}.`,
  }, ctx.adapter);
}

// Sum the ERC-20 Transfer amounts in a receipt's logs that move tokens from
// the participant's wallet (optionally to a specific recipient). Returns null
// when no matching transfer exists.
async function erc20TransferAmount(pool, receipt, tx, token, wallet, toConstraint) {
  const tokenAddr = normalizeAddr(token.contract_address);
  let total = 0n;
  for (const log of receipt.logs || []) {
    if (normalizeAddr(log.address) !== tokenAddr) continue;
    if (!log.topics || log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    const from = normalizeAddr('0x' + log.topics[1].slice(26));
    const to = normalizeAddr('0x' + log.topics[2].slice(26));
    if (wallet && wallet.address && from !== normalizeAddr(wallet.address)) continue;
    if (toConstraint && to !== toConstraint) continue;
    const value = hexToBigInt(log.data);
    if (value !== null) total += value;
  }
  return total > 0n ? total : null;
}

const METHODS = { native_balance: nativeBalance, erc20_balance: erc20Balance, transaction };

// The single entry point. `ctx.pool` is a test seam (an injected fake pool);
// production builds one from the network's endpoints.
async function verifyEvm(ctx) {
  const fn = METHODS[ctx.method];
  if (!fn) {
    const { normalizeResult: norm } = require('../chain-adapter');
    return norm({ status: 'MANUAL_REVIEW', reason: `Unsupported on-chain method: ${ctx.method}` }, ctx.adapter);
  }
  const pool = ctx.pool || (await require('./rpc-pool').rpcPoolFor(ctx.network.id));
  try {
    return await fn(ctx, pool);
  } catch (err) {
    if (err instanceof RpcUnavailableError) {
      return normalizeResult({ status: 'RPC_UNAVAILABLE', reason: 'The network could not be reached. Try again shortly.', rawEvidence: { tried: err.tried } }, ctx.adapter);
    }
    if (err instanceof IndexingDelayError) {
      return normalizeResult({ status: 'INDEXING_DELAY', reason: err.message }, ctx.adapter);
    }
    if (err instanceof InvalidConfigurationError) {
      return normalizeResult({ status: 'INVALID_CONFIGURATION', reason: err.message }, ctx.adapter);
    }
    // Unknown error: never a fabricated verdict.
    return normalizeResult({ status: 'MANUAL_REVIEW', reason: 'This check could not be completed automatically.' }, ctx.adapter);
  }
}

module.exports = { verifyEvm, METHODS, ERC20_ABI, finalityFor, erc20TransferAmount };
