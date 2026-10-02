// Minimal base58 (Bitcoin alphabet) codec.
//
// The chain adapters need it to read Solana public keys and Octra oct1
// addresses as raw 32-byte Ed25519 keys. Implemented in-repo rather than
// pulling a dependency for a single encode/decode pair.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = {};
for (let i = 0; i < ALPHABET.length; i++) MAP[ALPHABET[i]] = i;

function decode(str) {
  if (typeof str !== 'string' || str.length === 0) return Buffer.alloc(0);
  let bytes = [0];
  for (const ch of str) {
    const value = MAP[ch];
    if (value === undefined) throw new Error('Invalid base58 character');
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // Leading '1's are leading zero bytes.
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

function encode(buffer) {
  const bytes = Buffer.from(buffer);
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

module.exports = { decode, encode };
