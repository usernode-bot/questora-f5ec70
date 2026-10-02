// The universal blockchain abstraction. The verification engine talks ONLY
// to this interface: it never calls an EVM API, never reads a chain id, an
// ABI, a receipt or a log, and never assumes an asset standard. Each chain
// family ships an adapter that declares which capabilities it supports and
// returns a normalized result with raw evidence. EVM is the first adapter;
// Solana, Sui, Aptos, Octra, Cosmos, Bitcoin and custom adapters plug in
// here later without the engine, task or completion layers changing.

// Capability vocabulary (spec: chain capability system). An adapter returns a
// plain object with these boolean flags; the task builder can read it to show
// only the features a chain actually has.
const CAPABILITIES = {
  nativeBalance: 'Native balance',
  fungibleBalance: 'Fungible / token balance',
  nftOwnership: 'NFT or object ownership',
  multiToken: 'Multi-token balances',
  transactions: 'Transaction verification',
  transactionHistory: 'Transaction history',
  contractCalls: 'Contract calls',
  programCalls: 'Program / module calls',
  events: 'Event verification',
  historicalState: 'Historical state',
  signatures: 'Signature verification',
  staking: 'Staking',
  governance: 'Governance',
  bridge: 'Bridge',
  utxo: 'UTXO model',
};

function emptyCapabilities() {
  const caps = {};
  for (const key of Object.keys(CAPABILITIES)) caps[key] = false;
  return caps;
}

// Chain position (spec: block / slot / checkpoint abstraction). A chain names
// its position differently; the adapter normalizes it to a kind plus a value.
const POSITION_KINDS = ['block', 'slot', 'version', 'checkpoint', 'epoch', 'height', 'round', 'sequence', 'custom'];

function chainPosition(kind, value, label) {
  return {
    kind: POSITION_KINDS.includes(kind) ? kind : 'custom',
    value: value === undefined || value === null ? null : value,
    label: label || null,
  };
}

function formatPosition(pos) {
  if (!pos) return null;
  if (pos.label) return pos.label;
  if (pos.value === null || pos.value === undefined) return null;
  const noun = pos.kind.charAt(0).toUpperCase() + pos.kind.slice(1);
  return `${noun} ${pos.value}`;
}

// Finality vocabulary (spec: finality abstraction). Never a hardcoded
// confirmations count.
const FINALITY_STATES = [
  'processed', 'confirmed', 'safe', 'finalized', 'irreversible',
  'n_confirmations', 'epoch_finalized', 'checkpoint_finalized', 'block_finalized', 'unknown',
];

// The single normalized shape every adapter returns. The engine and every
// downstream layer (task, completion, XP) read only these fields; the raw
// chain response is preserved untouched under rawEvidence.
function normalizeResult(raw, adapter) {
  raw = raw || {};
  const status = raw.status || 'MANUAL_REVIEW';
  const network = raw.network || null;
  const pos = raw.chainPosition || null;
  return {
    status,
    verified: raw.verified !== undefined ? !!raw.verified : status === 'VERIFIED',
    reason: raw.reason || null,
    // Chain-neutral transaction identity (spec: transaction id abstraction).
    transactionId: raw.transactionId === undefined ? null : raw.transactionId,
    logIndex: raw.logIndex === undefined ? null : raw.logIndex,
    network,
    chainNamespace: raw.chainNamespace || (network && network.namespace) || (adapter && adapter.namespace) || null,
    chainId: raw.chainId !== undefined ? raw.chainId : (network && network.chainId),
    chainPosition: pos,
    chainPositionLabel: formatPosition(pos),
    confirmations: raw.confirmations === undefined ? null : raw.confirmations,
    finality: raw.finality || 'unknown',
    // Human-facing evidence (a small, safe summary) and the untouched raw
    // chain data kept for auditability and future verification rules.
    evidence: raw.evidence || {},
    rawEvidence: raw.rawEvidence || {},
    steps: Array.isArray(raw.steps) ? raw.steps : [],
    method: raw.method || null,
    adapterName: (adapter && adapter.name) || raw.adapterName || 'unknown',
    adapterVersion: (adapter && adapter.version) || raw.adapterVersion || null,
  };
}

// The abstract adapter. Subclasses override capabilities() and verify(); every
// other method of the conceptual interface has a default that reports the
// capability as unavailable rather than pretending.
class ChainAdapter {
  constructor() {
    if (new.target === ChainAdapter) {
      throw new Error('ChainAdapter is abstract; subclass it and implement verify()');
    }
    this.name = this.constructor.adapterName || this.constructor.name;
    this.version = this.constructor.adapterVersion || '1';
    this.namespace = this.constructor.namespace || null;
  }

  capabilities() { return emptyCapabilities(); }
  supports(capability) { return !!this.capabilities()[capability]; }

  // Which engine methods this adapter can verify. Defaults to empty so an
  // adapter must name them explicitly.
  supportedMethods() { return []; }
  supportsMethod(method) { return this.supportedMethods().includes(method); }

  // The one method every adapter must implement. Returns a normalized result
  // (use normalizeResult) for the given { method, config, network, token,
  // wallet, submission } context.
  verify() { throw new Error(`${this.name} must implement verify()`); }

  // The wider conceptual interface. Adapters implement the ones their chain
  // supports; the rest report unavailability, never a fake answer.
  async getNetworkInfo() { return this.unsupported('getNetworkInfo'); }
  async getLatestBlock() { return this.unsupported('getLatestBlock'); }
  async getFinalityStatus() { return this.unsupported('getFinalityStatus'); }
  async getAccountBalance() { return this.unsupported('getAccountBalance'); }
  async getTokenBalance() { return this.unsupported('getTokenBalance'); }
  async getAssetOwnership() { return this.unsupported('getAssetOwnership'); }
  async getTransaction() { return this.unsupported('getTransaction'); }
  async getTransactionStatus() { return this.unsupported('getTransactionStatus'); }
  async getTransactionHistory() { return this.unsupported('getTransactionHistory'); }
  async getProgramOrContract() { return this.unsupported('getProgramOrContract'); }
  async getTransactionInstructions() { return this.unsupported('getTransactionInstructions'); }
  async getEvents() { return this.unsupported('getEvents'); }
  async getState() { return this.unsupported('getState'); }
  async verifySignature() { return this.unsupported('verifySignature'); }
  async verifyAddress() { return this.unsupported('verifyAddress'); }

  // Explorer links: never assume a universal URL shape.
  getTransactionExplorerUrl() { return null; }
  getAddressExplorerUrl() { return null; }
  getBlockExplorerUrl() { return null; }

  unsupported(method) {
    return { supported: false, capability: method, adapter: this.name };
  }
}

// Phase 1 shipped with no RPC-backed adapter at all; this class is kept as the
// explicit "nothing is supported here" adapter and as the base the registry
// falls back to. It never reports verified.
class NullChainAdapter extends ChainAdapter {
  constructor() {
    super();
    this.name = 'NullChainAdapter';
    this.version = '1';
  }
  capabilities() { return emptyCapabilities(); }
  supportedMethods() { return []; }
  async verify() {
    return normalizeResult({
      status: 'MANUAL_REVIEW',
      reason: 'This on-chain verification method is not currently supported.',
    }, this);
  }
}

// The registry maps a chain namespace (chain_namespace) to the adapter that
// verifies it. Adding a chain is a registration, not an engine change.
const registry = new Map();
let loaded = false;

// Adapters register themselves lazily so the module graph stays acyclic: the
// EVM adapter requires this file, so we cannot require it at load time.
function loadAdapters() {
  if (loaded) return;
  loaded = true;
  registerAdapter(require('./evm/evm-adapter').EVMAdapter && new (require('./evm/evm-adapter').EVMAdapter)());
}

function registerAdapter(adapter) {
  if (!adapter || !adapter.namespace) throw new Error('A chain adapter needs a namespace');
  registry.set(adapter.namespace, adapter);
  return adapter;
}

function adapterFor(namespace) {
  loadAdapters();
  return registry.get(namespace) || null;
}

function adapterNamespaces() {
  loadAdapters();
  return [...registry.keys()];
}

function allAdapters() {
  loadAdapters();
  return [...registry.values()];
}

module.exports = {
  CAPABILITIES, emptyCapabilities, POSITION_KINDS, chainPosition, formatPosition,
  FINALITY_STATES, normalizeResult, ChainAdapter, NullChainAdapter,
  registerAdapter, loadAdapters, adapterFor, adapterNamespaces, allAdapters,
};
