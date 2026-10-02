// Per-chain wallet address validation, challenge-message builders and
// signature verification for the signed-nonce wallet link flow
// (src/routes/wallets.js).
//
// Every adapter implements:
//   namespace        - the value stored in wallets.chain_namespace
//   label            - the plain-language chain name the UI shows
//   validateAddress  - is this a well-formed address for the chain?
//   buildMessage     - the exact string the user signs (rebuilt at verify)
//   verify           - { address, message, signature, publicKey } -> bool
//
// Verification NEVER trusts a client-supplied address: it either recovers
// the signer (EVM) or verifies the signature against the public key the
// challenge is bound to, so a signature by a different key cannot vouch for
// a claimed address.

const crypto = require('crypto');
const bs58 = require('./bs58');
const { ethers } = require('ethers');

const ED25519_PUBLIC_KEY_LEN = 32;
const ED25519_SIGNATURE_LEN = 64;

// The signature the chain actually signed, which is what we verify over.
// EVM's personal_sign is over the message we sent, so this is identity.
function normalizeSignatureBytes(signature) {
  if (Buffer.isBuffer(signature)) return signature;
  if (signature instanceof Uint8Array) return Buffer.from(signature);
  if (typeof signature === 'string') {
    const s = signature.startsWith('0x') ? signature.slice(2) : signature;
    if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return Buffer.from(s, 'hex');
    try { return Buffer.from(s, 'base64'); } catch { return Buffer.from(s); }
  }
  return Buffer.alloc(0);
}

// Ed25519 verification shared by every non-EVM chain. `publicKey` is either
// a raw 32-byte key or, for chains that name the key by address, derived from
// the address by the adapter before it gets here.
function verifyEd25519(publicKey, message, signature) {
  // Accept a raw Buffer/Uint8Array or the base64/hex string a connector sends.
  const key = normalizeSignatureBytes(publicKey);
  if (key.length !== ED25519_PUBLIC_KEY_LEN) return false;
  const sig = normalizeSignatureBytes(signature);
  if (sig.length !== ED25519_SIGNATURE_LEN) return false;
  try {
    // Node's crypto verifies raw Ed25519 signatures when the key is wrapped
    // in a SubjectPublicKeyInfo DER (prefixed with the fixed Ed25519 OID).
    const der = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      key,
    ]);
    const keyObject = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), keyObject, sig);
  } catch {
    return false;
  }
}

// EVM (EIP-155). Addresses are 0x + 40 hex; personal_sign over UTF-8 text.
const evmAdapter = {
  namespace: 'eip155',
  label: 'EVM',
  validateAddress(address) {
    return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address);
  },
  // Storage and message-building use the lowercase form so a checksummed
  // address handed out by a wallet reconstructs the same signed string.
  normalizeAddress(address) { return String(address).toLowerCase(); },
  buildMessage(address, nonce) {
    return `Questora wallet verification\n\nAddress: ${address}\nNonce: ${nonce}`;
  },
  verify({ address, message, signature }) {
    try {
      return ethers.verifyMessage(message, signature).toLowerCase() === String(address).toLowerCase();
    } catch {
      return false;
    }
  },
};

// Solana. Addresses are base58-encoded 32-byte Ed25519 public keys, so the
// address IS the public key; case is significant.
const solanaAdapter = {
  namespace: 'solana',
  label: 'Solana',
  validateAddress(address) {
    if (typeof address !== 'string' || address.length < 32 || address.length > 44) return false;
    try { return bs58.decode(address).length === ED25519_PUBLIC_KEY_LEN; } catch { return false; }
  },
  normalizeAddress(address) { return String(address); },
  buildMessage(address, nonce) {
    return `Questora wallet verification\n\nAddress: ${address}\nNonce: ${nonce}`;
  },
  verify({ address, message, signature }) {
    try {
      return verifyEd25519(bs58.decode(address), message, signature);
    } catch {
      return false;
    }
  },
};

// Sui. Addresses are a 0x-prefixed 64-hex string. The signature is Ed25519
// over the personal-message bytes; the signer's public key is passed back so
// verification does not have to derive it from the address.
const suiAdapter = {
  namespace: 'sui',
  label: 'Sui',
  validateAddress(address) {
    return typeof address === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(address);
  },
  normalizeAddress(address) {
    const hex = String(address).replace(/^0x/i, '').toLowerCase();
    return '0x' + hex.padStart(64, '0');
  },
  buildMessage(address, nonce) {
    return `Questora wallet verification\n\nAddress: ${address}\nNonce: ${nonce}`;
  },
  verify({ publicKey, message, signature }) {
    return verifyEd25519(publicKey, message, signature);
  },
};

// Aptos. Addresses are 0x + up to 64 hex; Petra signs the message with
// Ed25519 and returns both the signature and the message it signed.
const aptosAdapter = {
  namespace: 'aptos',
  label: 'Aptos',
  validateAddress(address) {
    return typeof address === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(address);
  },
  normalizeAddress(address) {
    const hex = String(address).replace(/^0x/i, '').toLowerCase();
    return '0x' + hex.padStart(64, '0');
  },
  buildMessage(address, nonce) {
    return `Questora wallet verification\n\nAddress: ${address}\nNonce: ${nonce}`;
  },
  verify({ publicKey, message, signature }) {
    return verifyEd25519(publicKey, message, signature);
  },
};

// Octra, via the 0xio provider. Addresses are oct1-prefixed base58. The
// provider signs with Ed25519 and returns the public key alongside the
// signature, so verification is against that key.
const octraAdapter = {
  namespace: 'octra',
  label: 'Octra',
  // Octra addresses are oct1-prefixed. The exact payload encoding is not
  // pinned here: the provider returns the signer's public key, so
  // verification does not have to derive it from the address text. Accept a
  // conservative oct1 + bech32/base58-shaped body.
  validateAddress(address) {
    return typeof address === 'string' && /^oct1[0-9a-z]{20,80}$/.test(address);
  },
  normalizeAddress(address) { return String(address); },
  buildMessage(address, nonce) {
    return `Questora wallet verification\n\nAddress: ${address}\nNonce: ${nonce}`;
  },
  verify({ publicKey, message, signature }) {
    if (!publicKey) return false;
    return verifyEd25519(normalizeSignatureBytes(publicKey), message, signature);
  },
};

const ADAPTERS = {
  [evmAdapter.namespace]: evmAdapter,
  [solanaAdapter.namespace]: solanaAdapter,
  [suiAdapter.namespace]: suiAdapter,
  [aptosAdapter.namespace]: aptosAdapter,
  [octraAdapter.namespace]: octraAdapter,
};

function adapterFor(namespace) {
  return ADAPTERS[namespace] || null;
}

function chainChoices() {
  return Object.keys(ADAPTERS).map((k) => ({ chain: k, label: ADAPTERS[k].label }));
}

module.exports = { adapterFor, chainChoices, ADAPTERS, verifyEd25519, normalizeSignatureBytes };
