// Multi-chain wallet linking. Each connector knows how to find its injected
// provider, read an address, and sign the exact challenge message the server
// sent. The server rebuilds that message from the stored challenge and
// verifies the signature, so a connector only ever proves ownership; it never
// touches the Homeroom session.
'use strict';
(function () {
  const CHAINS = [
    { chain: 'eip155', label: 'EVM' },
    { chain: 'solana', label: 'Solana' },
    { chain: 'sui', label: 'Sui' },
    { chain: 'aptos', label: 'Aptos' },
    { chain: 'octra', label: 'Octra' },
  ];

  function bytesToBase64(bytes) {
    let binary = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
    return btoa(binary);
  }
  // Wallets differ: some hand back a hex/base64 string, others a raw byte
  // array. JSON.stringify would turn a byte array into a numeric-keyed object,
  // so make every signature a string the server can read.
  function sigToString(sig) {
    if (typeof sig === 'string') return sig;
    if (sig instanceof Uint8Array || (sig && sig.buffer instanceof ArrayBuffer)) return bytesToBase64(new Uint8Array(sig.buffer || sig));
    return String(sig == null ? '' : sig);
  }

  // EVM (window.ethereum). personal_sign over the message text.
  const evm = {
    label: 'EVM',
    async connect() {
      if (!window.ethereum) throw new Error('No EVM wallet found. Install MetaMask or open Questora in a wallet browser.');
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const address = accounts && accounts[0];
      if (!address) throw new Error('Connect a wallet account first');
      return { address };
    },
    sign(address, message) { return window.QuestoraAPI.signMessage(address, message); },
  };

  // Solana (window.solana / Phantom). Signs the UTF-8 message bytes.
  const solana = {
    label: 'Solana',
    provider() { return window.solana || (window.phantom && window.phantom.solana); },
    async connect() {
      const p = this.provider();
      if (!p) throw new Error('No Solana wallet found. Install Phantom or open Questora in a wallet browser.');
      const res = await p.connect();
      const address = (res && res.publicKey && res.publicKey.toString()) || (p.publicKey && p.publicKey.toString());
      if (!address) throw new Error('Connect a wallet account first');
      return { address };
    },
    async sign(message) {
      const p = this.provider();
      const encoded = new TextEncoder().encode(message);
      const res = await p.signMessage(encoded, 'utf8');
      const sig = (res && res.signature) || res;
      return sigToString(sig);
    },
  };

  // Sui (Wallet Standard / window.suiWallet). signMessage returns a base64
  // signature and the signer's public key.
  const sui = {
    label: 'Sui',
    async connect() {
      const p = window.suiWallet;
      if (!p) throw new Error('No Sui wallet found. Install Slush or open Questora in a wallet browser.');
      const accounts = await p.requestAccounts();
      const address = accounts && (accounts[0].address || accounts[0]);
      if (!address) throw new Error('Connect a wallet account first');
      return { address };
    },
    async sign(message) {
      const p = window.suiWallet;
      const res = await p.signMessage({ message: new TextEncoder().encode(message) });
      const publicKey = bytesToBase64(res.publicKey || []);
      return { signature: sigToString(res.signature), publicKey };
    },
  };

  // Aptos (Petra, window.aptos). Returns the signature and the message bytes
  // it actually signed.
  const aptos = {
    label: 'Aptos',
    async connect() {
      const p = window.aptos;
      if (!p) throw new Error('No Aptos wallet found. Install Petra or open Questora in a wallet browser.');
      const res = await p.connect();
      const address = res && res.address;
      if (!address) throw new Error('Connect a wallet account first');
      return { address };
    },
    async sign(message) {
      const p = window.aptos;
      const res = await p.signMessage({ message, nonce: 'questora' });
      const signed = res.fullMessage
        ? (typeof res.fullMessage === 'string' ? res.fullMessage : new TextDecoder().decode(res.fullMessage))
        : message;
      const publicKey = res.publicKey ? bytesToBase64(res.publicKey) : '';
      return { signature: sigToString(res.signature), publicKey, signedMessage: signed };
    },
  };

  // Octra via the 0xio provider. The provider returns the Ed25519 public key
  // alongside the signature, so no address derivation is needed.
  const octra = {
    label: 'Octra',
    provider() { return window.octra || window.wallet0xio || null; },
    async connect() {
      const p = this.provider();
      if (!p) throw new Error('No Octra wallet found. Install the 0xio wallet or open Questora in a wallet browser.');
      const res = p.connect ? await p.connect() : p;
      const address = (res && res.address) || p.address;
      if (!address) throw new Error('Connect a wallet account first');
      return { address };
    },
    async sign(message) {
      const p = this.provider();
      const res = await p.signMessage(message);
      const signature = typeof res === 'string' ? res : sigToString(res.signature);
      const publicKey = res && res.publicKey ? bytesToBase64(res.publicKey) : (p.publicKey ? bytesToBase64(p.publicKey) : '');
      return { signature, publicKey };
    },
  };

  const CONNECTORS = { eip155: evm, solana, sui, aptos, octra };

  // Connect, get a server nonce, sign the returned message, and verify.
  async function link(chain) {
    const connector = CONNECTORS[chain];
    if (!connector) throw new Error('Choose a supported chain');
    const { address } = await connector.connect();
    const ch = await window.QuestoraAPI.api.post('/api/v1/wallets/challenge', { chain, address });
    let signature, publicKey, signedMessage;
    const signed = await connector.sign(address, ch.message);
    if (typeof signed === 'string') signature = signed;
    else ({ signature, publicKey, signedMessage } = signed);
    const body = { chain, address, signature, nonce: ch.nonce };
    if (publicKey) body.publicKey = publicKey;
    // Aptos (and any wallet that wraps the message) returns what it actually
    // signed; the server verifies over it only if it still carries this
    // challenge's nonce and address.
    if (signedMessage) body.signedMessage = signedMessage;
    return window.QuestoraAPI.api.post('/api/v1/wallets/verify', body);
  }

  window.QuestoraWallets = { CHAINS, CONNECTORS, link };
})();
