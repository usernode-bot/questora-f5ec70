// The EVM (EIP-155) chain adapter. This is where every EVM assumption lives:
// chain id, ABI, receipts, logs, ERC-20, gas, confirmations. It declares its
// capabilities through the universal interface and returns a normalized
// result; the engine never sees any of the EVM specifics below.

const { ChainAdapter, emptyCapabilities, normalizeResult } = require('../chain-adapter');
const { verifyEvm, METHODS } = require('./evm-verifier');

class EVMAdapter extends ChainAdapter {
  capabilities() {
    return {
      ...emptyCapabilities(),
      nativeBalance: true,
      fungibleBalance: true,
      transactions: true,
      // Contract calls are verifiable only through the transaction method in
      // this slice; no arbitrary ABI call is exposed yet.
      contractCalls: true,
    };
  }

  supportedMethods() {
    return Object.keys(METHODS);
  }

  // ctx carries a chain-neutral context (network, token, wallet, submission,
  // config) already loaded and project-scoped by the engine. The EVM-specific
  // work happens inside verifyEvm.
  async verify(ctx) {
    if (!ctx.method || !METHODS[ctx.method]) {
      return normalizeResult({
        status: 'MANUAL_REVIEW',
        reason: `Unsupported on-chain method: ${ctx.method}`,
      }, this);
    }
    return verifyEvm(ctx);
  }

  // EVM explorer links (spec: explorer links are adapter-specific). The
  // network row holds the templates; a chain without one returns null rather
  // than a guessed /tx/{hash} path.
  getTransactionExplorerUrl(transactionOrId, network) {
    const id = typeof transactionOrId === 'string' ? transactionOrId : (transactionOrId && transactionOrId.transactionId);
    return fillTemplate(network && network.explorer_tx_url, id);
  }
  getAddressExplorerUrl(address, network) {
    return fillTemplate(network && network.explorer_address_url, address);
  }
  getBlockExplorerUrl(blockOrPos, network) {
    const value = blockOrPos && blockOrPos.value !== undefined ? blockOrPos.value : blockOrPos;
    return fillTemplate(network && network.explorer_block_url, value);
  }
}

EVMAdapter.adapterName = 'EVMAdapter';
EVMAdapter.adapterVersion = '1';
EVMAdapter.namespace = 'eip155';

function fillTemplate(template, value) {
  if (!template || value === undefined || value === null) return null;
  return String(template)
    .replace('{tx}', String(value)).replace('{hash}', String(value))
    .replace('{address}', String(value)).replace('{block}', String(value));
}

module.exports = { EVMAdapter, fillTemplate };
