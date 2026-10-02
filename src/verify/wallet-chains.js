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
const { blake2b, uleb } = require('./blake2b');
const { ethers } = require('ethers');

const ED25519_PUBLIC_KEY_LEN = 32;
const ED25519_SIGNATURE_LEN = 64;
const { MAX_ADDRESSES_PER_CHAIN } = require('../wallet-limits');

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
  // `message` is text, or already-hashed bytes (Sui signs a digest).
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
    return crypto.verify(null, Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf8'), keyObject, sig);
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

// Sui. Addresses are 0x + 64 hex: blake2b-256(flag || publicKey). The wallet
// standard's signPersonalMessage returns a serialized signature
// (flag || signature || publicKey, base64) over blake2b-256 of the intent
// message [3, 0, 0] || bcs(vector<u8> message). Only Ed25519 (flag 0) is
// accepted; the key is read from the signature and must derive the address,
// so a signature by someone else's key cannot vouch for a claimed address.
function suiAddressFromKey(publicKey) {
  return '0x' + blake2b(Buffer.concat([Buffer.from([0]), publicKey]), 32).toString('hex');
}
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
  verify({ address, message, signature }) {
    const raw = normalizeSignatureBytes(signature);
    if (raw.length !== 1 + ED25519_SIGNATURE_LEN + ED25519_PUBLIC_KEY_LEN || raw[0] !== 0) return false;
    const sig = raw.subarray(1, 1 + ED25519_SIGNATURE_LEN);
    const publicKey = raw.subarray(1 + ED25519_SIGNATURE_LEN);
    if (suiAddressFromKey(publicKey) !== this.normalizeAddress(address)) return false;
    const msg = Buffer.from(message, 'utf8');
    const digest = blake2b(Buffer.concat([Buffer.from([3, 0, 0]), uleb(msg.length), msg]), 32);
    return verifyEd25519(publicKey, digest, sig);
  },
};

// Aptos. Addresses are 0x + up to 64 hex: the account's authentication key,
// sha3-256 of the key plus a scheme byte. Wallets following AIP-62 sign the
// "APTOS ... message" wrapper (fullMessage) with Ed25519 and expose the public
// key. We accept the legacy Ed25519 scheme (0x00) and the SingleKey scheme
// (0x02), and require the key to derive the address. An account that rotated
// its authentication key to a different key cannot be verified here.
function aptosAuthKeys(publicKey) {
  const legacy = crypto.createHash('sha3-256').update(Buffer.concat([publicKey, Buffer.from([0x00])])).digest('hex');
  const single = crypto.createHash('sha3-256')
    .update(Buffer.concat([Buffer.from([0x00, 0x20]), publicKey, Buffer.from([0x02])])).digest('hex');
  return ['0x' + legacy, '0x' + single];
}
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
  verify({ address, message, signature, publicKey }) {
    const key = normalizeSignatureBytes(publicKey);
    if (key.length !== ED25519_PUBLIC_KEY_LEN) return false;
    if (!aptosAuthKeys(key).includes(this.normalizeAddress(address))) return false;
    return verifyEd25519(key, message, signature);
  },
};

// Octra, via the 0xio wallet. An address is "oct" + base58(sha256(publicKey))
// (47 characters). 0xio never signs the raw text: it frames it as
// "Octra Signed Message:\n<utf8 byte length>\n<message>" and returns a base64
// Ed25519 signature plus the base64 public key. The key must derive the
// address.
function octraAddressFromKey(publicKey) {
  return 'oct' + bs58.encode(crypto.createHash('sha256').update(publicKey).digest());
}
function octraFrame(message) {
  const text = String(message);
  return `Octra Signed Message:\n${Buffer.byteLength(text, 'utf8')}\n${text}`;
}
const octraAdapter = {
  namespace: 'octra',
  label: 'Octra',
  validateAddress(address) {
    return typeof address === 'string' && /^oct[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(address);
  },
  normalizeAddress(address) { return String(address); },
  buildMessage(address, nonce) {
    return `Questora wallet verification\n\nAddress: ${address}\nNonce: ${nonce}`;
  },
  verify({ address, message, signature, publicKey }) {
    if (!publicKey) return false;
    const key = Buffer.from(String(publicKey), 'base64');
    if (key.length !== ED25519_PUBLIC_KEY_LEN) return false;
    if (octraAddressFromKey(key) !== String(address)) return false;
    return verifyEd25519(key, octraFrame(message), Buffer.from(String(signature), 'base64'));
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

module.exports = { MAX_ADDRESSES_PER_CHAIN, adapterFor, chainChoices, ADAPTERS, verifyEd25519, normalizeSignatureBytes };
