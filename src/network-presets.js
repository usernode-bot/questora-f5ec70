// Network preset catalog for the Task Creator. Picking a preset fills the
// network row (and its RPC endpoints) so a creator never types RPC, chain id,
// token or explorer details by hand; every field stays editable as an override.
//
// Sources: EVM chain ids, tokens and RPCs from chainlist.org/rpcs.json; the
// Sepolia endpoints are the ones already used by the staging seed; non-EVM
// parameters from each network's own docs; wallet names from
// public/wallets/connectors.js.
//
// Rules for this file:
//   - RPCs are https only, need no API key and embed no credentials.
//   - Only EVM presets carry a chainId. Non-EVM networks have no EIP-155 chain
//     id, so chainId is null and their own identifier is in `networkId`.
//   - Anything not confirmed from a source above is null (or an empty rpcs
//     list) and named in `unverified`. Never fill one in by guessing.

const EVM_WALLETS = ['MetaMask', 'Rabby', 'Coinbase Wallet', 'OKX Wallet', 'Phantom', 'Backpack'];
const EVM_ADDRESS = '0x + 40 hex (EIP-55 checksum)';

function evm(id, name, chainId, symbol, rpcs, explorer, opts = {}) {
  return {
    id, name, type: 'EVM', namespace: 'eip155', chainId, networkId: String(chainId),
    nativeToken: { name: opts.tokenName || symbol, symbol, decimals: 18 },
    rpcs,
    explorer: {
      url: explorer,
      txUrl: explorer + '/tx/{tx}',
      addressUrl: explorer + '/address/{address}',
    },
    addressFormat: EVM_ADDRESS,
    wallets: EVM_WALLETS,
    isTestnet: !!opts.testnet,
    finalityModel: 'n_confirmations',
    unverified: [],
  };
}

const PRESETS = [
  evm('ethereum', 'Ethereum', 1, 'ETH',
    ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'], 'https://etherscan.io', { tokenName: 'Ether' }),
  evm('base', 'Base', 8453, 'ETH',
    ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'], 'https://basescan.org', { tokenName: 'Ether' }),
  evm('bsc', 'BNB Smart Chain', 56, 'BNB',
    ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'], 'https://bscscan.com', { tokenName: 'BNB' }),
  evm('arbitrum', 'Arbitrum One', 42161, 'ETH',
    ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'], 'https://arbiscan.io', { tokenName: 'Ether' }),
  evm('polygon', 'Polygon', 137, 'POL',
    ['https://polygon-bor-rpc.publicnode.com'], 'https://polygonscan.com', { tokenName: 'POL' }),
  evm('optimism', 'Optimism', 10, 'ETH',
    ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'], 'https://optimistic.etherscan.io', { tokenName: 'Ether' }),
  evm('avalanche', 'Avalanche C-Chain', 43114, 'AVAX',
    ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'], 'https://snowtrace.io', { tokenName: 'Avalanche' }),
  evm('sepolia', 'Sepolia', 11155111, 'ETH',
    ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'], 'https://sepolia.etherscan.io',
    { tokenName: 'Sepolia Ether', testnet: true }),

  {
    id: 'solana', name: 'Solana', type: 'Solana', namespace: 'solana', chainId: null, networkId: 'mainnet-beta',
    nativeToken: { name: 'Solana', symbol: 'SOL', decimals: 9 },
    rpcs: ['https://api.mainnet-beta.solana.com'],
    explorer: { url: 'https://explorer.solana.com', txUrl: 'https://explorer.solana.com/tx/{tx}', addressUrl: 'https://explorer.solana.com/address/{address}' },
    addressFormat: 'base58, 32-byte Ed25519 public key',
    wallets: ['Phantom', 'Solflare', 'Backpack', 'OKX Wallet'],
    isTestnet: false, finalityModel: 'finalized', unverified: [],
  },
  {
    id: 'solana-devnet', name: 'Solana Devnet', type: 'Solana', namespace: 'solana', chainId: null, networkId: 'devnet',
    nativeToken: { name: 'Solana', symbol: 'SOL', decimals: 9 },
    rpcs: ['https://api.devnet.solana.com'],
    explorer: {
      url: 'https://explorer.solana.com?cluster=devnet',
      txUrl: 'https://explorer.solana.com/tx/{tx}?cluster=devnet',
      addressUrl: 'https://explorer.solana.com/address/{address}?cluster=devnet',
    },
    addressFormat: 'base58, 32-byte Ed25519 public key',
    wallets: ['Phantom', 'Solflare', 'Backpack', 'OKX Wallet'],
    isTestnet: true, finalityModel: 'finalized', unverified: [],
  },
  {
    id: 'sui', name: 'Sui', type: 'Sui', namespace: 'sui', chainId: null, networkId: 'mainnet',
    nativeToken: { name: 'Sui', symbol: 'SUI', decimals: 9 },
    rpcs: ['https://fullnode.mainnet.sui.io:443'],
    explorer: { url: 'https://suivision.xyz', txUrl: null, addressUrl: null },
    addressFormat: '0x + 64 hex',
    wallets: ['Slush', 'Phantom', 'Backpack', 'OKX Wallet', 'Nightly', 'Ethos Wallet'],
    isTestnet: false, finalityModel: 'checkpoint_finalized',
    unverified: ['explorer.txUrl', 'explorer.addressUrl'],
  },
  {
    id: 'aptos', name: 'Aptos', type: 'Aptos', namespace: 'aptos', chainId: null, networkId: '1',
    nativeToken: { name: 'Aptos Coin', symbol: 'APT', decimals: 8 },
    rpcs: ['https://fullnode.mainnet.aptoslabs.com/v1'],
    explorer: { url: 'https://explorer.aptoslabs.com', txUrl: null, addressUrl: null },
    addressFormat: '0x + up to 64 hex',
    wallets: ['Petra', 'Nightly', 'Backpack', 'OKX Wallet', 'Pontem Wallet'],
    isTestnet: false, finalityModel: null,
    unverified: ['explorer.txUrl', 'explorer.addressUrl', 'finalityModel'],
  },
  // Octra: docs.octra.org publishes no public RPC URL, chain id or explorer, and
  // no native decimals. They stay unset so the creator confirms them with an
  // official source (the RPC is JSON-RPC 2.0 over POST /rpc).
  {
    id: 'octra', name: 'Octra Mainnet Alpha', type: 'Octra', namespace: 'octra', chainId: null, networkId: null,
    nativeToken: { name: 'Octra', symbol: 'OCT', decimals: null },
    rpcs: [],
    explorer: { url: null, txUrl: null, addressUrl: null },
    addressFormat: 'oct + base58 (47 characters), ed25519 keys',
    wallets: ['0xio Wallet'],
    isTestnet: false, finalityModel: null,
    unverified: ['rpcs', 'networkId', 'nativeToken.decimals', 'explorer', 'finalityModel'],
  },
  {
    id: 'octra-testnet', name: 'Octra Testnet', type: 'Octra', namespace: 'octra', chainId: null, networkId: null,
    nativeToken: { name: 'Octra', symbol: 'OCT', decimals: null },
    rpcs: [],
    explorer: { url: null, txUrl: null, addressUrl: null },
    addressFormat: 'oct + base58 (47 characters), ed25519 keys',
    wallets: ['0xio Wallet'],
    isTestnet: true, finalityModel: null,
    unverified: ['rpcs', 'networkId', 'nativeToken.decimals', 'explorer', 'finalityModel'],
  },
];

function getPreset(id) { return PRESETS.find((p) => p.id === id) || null; }

// The columns a preset fills on task_networks (the shape POST /networks takes).
function presetToNetworkFields(p) {
  return {
    name: p.name, chain_namespace: p.namespace, chain_id: p.chainId,
    native_symbol: p.nativeToken.symbol, native_decimals: p.nativeToken.decimals,
    explorer_url: p.explorer.url, explorer_tx_url: p.explorer.txUrl, explorer_address_url: p.explorer.addressUrl,
    is_testnet: p.isTestnet, finality_model: p.finalityModel, address_format: p.addressFormat,
  };
}

module.exports = { PRESETS, getPreset, presetToNetworkFields };
