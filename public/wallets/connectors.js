// One connector per ecosystem. Each speaks only its own ecosystem's native
// standard; the manager (manager.js) and the UI only see this shared shape:
//
//   discover()                      -> wallets that are present right now
//   connect(walletId, { silent })   -> session { walletId, walletName, accounts, chainId, network, ... }
//   sign(session, address, message, { nonce }) -> proof body fields for /wallets/verify
//   disconnect(session)
//   watch(session, cb)              -> unsubscribe; cb({ type: 'accounts' | 'network' | 'disconnect', ... })
//
// Secrets never pass through here: a connector only ever asks a wallet for
// public addresses and for a signature over text the user is shown.
'use strict';
(function () {
  const QW = (window.QW = window.QW || {});

  class WalletError extends Error {
    constructor(code, message, cause) { super(message); this.code = code; this.cause = cause; }
  }
  QW.WalletError = WalletError;

  // ---- byte helpers -------------------------------------------------------
  const enc = encodeURIComponent;
  const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Wallets hand back keys and signatures as raw bytes, hex, base64, or an SDK
  // object (Aptos). Single-key wrappers carry a 2-byte variant+length prefix.
  function toBytes(v) {
    if (!v) return null;
    let bytes = null;
    if (v instanceof Uint8Array) bytes = v;
    else if (Array.isArray(v)) bytes = Uint8Array.from(v);
    else if (typeof v === 'string') {
      const h = v.replace(/^0x/i, '');
      if (/^[0-9a-fA-F]+$/.test(h) && h.length % 2 === 0) bytes = Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
      else { try { bytes = Uint8Array.from(atob(v), (c) => c.charCodeAt(0)); } catch (e) { bytes = null; } }
    } else if (typeof v.toUint8Array === 'function') bytes = v.toUint8Array();
    else if (v.data) return toBytes(v.data);
    if (bytes && bytes.length === 34 && bytes[0] === 0 && bytes[1] === 32) bytes = bytes.slice(2);
    if (bytes && bytes.length === 66 && bytes[0] === 0 && bytes[1] === 64) bytes = bytes.slice(2);
    return bytes;
  }

  // Same canonical forms the server uses, so "already linked" is decided
  // identically on both sides. Always compared together with the ecosystem.
  function normalize(eco, address) {
    const a = String(address || '').trim();
    if (eco === 'evm') return a.toLowerCase();
    if (eco === 'sui' || eco === 'aptos') return '0x' + a.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
    return a;
  }

  // Wallet errors differ by ecosystem; map them to codes the UI can explain.
  function toWalletError(err) {
    if (err instanceof WalletError) return err;
    const code = err && (err.code != null ? err.code : err.name);
    const msg = String((err && err.message) || err || '');
    if (code === 4001 || code === 'USER_REJECTED' || /reject|denied|declin|cancel/i.test(msg)) {
      return new WalletError('rejected', 'The request was declined in the wallet.', err);
    }
    if (code === -32002) return new WalletError('pending', 'The wallet already has a request open. Finish or close it, then try again.', err);
    if (code === 'WALLET_LOCKED' || /locked/i.test(msg)) return new WalletError('locked', 'The wallet is locked. Unlock it, then try again.', err);
    if (code === 'EXTENSION_NOT_FOUND') return new WalletError('not_detected', 'The wallet did not respond.', err);
    return new WalletError('unknown', 'The wallet could not complete that request. Try again.', err);
  }
  QW.toWalletError = toWalletError;
  QW.normalize = normalize;

  const here = () => location.origin + location.pathname; // never carries the session token
  const hasChain = (w, prefix) => (w.chains || []).some((c) => String(c).startsWith(prefix));
  const feat = (w, name) => w.features && w.features[name];

  // ---- EVM: EIP-6963 discovery, EIP-1193 provider -------------------------
  const EVM_CHAINS = { '0x1': 'Ethereum', '0xa': 'Optimism', '0x38': 'BNB Chain', '0x89': 'Polygon', '0x2105': 'Base', '0xa4b1': 'Arbitrum One' };
  const evmName = (id) => EVM_CHAINS[String(id).toLowerCase()] || ('Chain ' + parseInt(id, 16));
  const evmFlags = [['isRabby', 'Rabby', 'io.rabby'], ['isOkxWallet', 'OKX Wallet', 'com.okex.wallet'], ['isCoinbaseWallet', 'Coinbase Wallet', 'com.coinbase.wallet'],
    ['isPhantom', 'Phantom', 'app.phantom'], ['isBackpack', 'Backpack', 'app.backpack'], ['isMetaMask', 'MetaMask', 'io.metamask']];

  const evm = {
    id: 'evm', ns: 'eip155', label: 'EVM', unit: 'EVM',
    explorer: (a) => 'https://etherscan.io/address/' + a,
    catalog: [
      { id: 'io.metamask', name: 'MetaMask', install: 'https://metamask.io/download/', mobile: (u) => 'https://metamask.app.link/dapp/' + u.replace(/^https?:\/\//, '') },
      { id: 'com.okex.wallet', name: 'OKX Wallet', install: 'https://www.okx.com/web3', mobile: (u) => 'okx://wallet/dapp/url?dappUrl=' + enc(u) },
      { id: 'com.coinbase.wallet', name: 'Coinbase Wallet', install: 'https://www.coinbase.com/wallet', mobile: (u) => 'https://go.cb-w.com/dapp?cb_url=' + enc(u) },
      { id: 'app.phantom', name: 'Phantom', install: 'https://phantom.com/download', mobile: (u) => 'https://phantom.app/ul/browse/' + enc(u) + '?ref=' + enc(location.origin) },
      { id: 'io.rabby', name: 'Rabby', install: 'https://rabby.io/' },
      { id: 'app.backpack', name: 'Backpack', install: 'https://backpack.app/download' },
    ],
    discover() {
      const out = [];
      const seen = new Set();
      for (const { info, provider } of QW.registry.eipProviders()) {
        const id = info.rdns || slug(info.name);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name: info.name || id, icon: info.icon, provider, source: 'EIP-6963' });
      }
      // Fallback for wallets that predate EIP-6963: only providers that were
      // not announced above, so a multi-wallet browser never loses a choice.
      const legacy = [];
      const eth = window.ethereum;
      if (eth) (Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth]).forEach((p) => legacy.push(p));
      legacy.forEach((p, i) => {
        if (!p || typeof p.request !== 'function' || out.some((o) => o.provider === p)) return;
        const hit = evmFlags.find((f) => p[f[0]]);
        const id = hit ? hit[2] : 'injected' + (i ? '-' + i : '');
        if (!seen.has(id)) { seen.add(id); out.push({ id, name: hit ? hit[1] : 'Browser wallet', provider: p, source: 'window.ethereum (legacy)' }); }
      });
      return out;
    },
    async connect(walletId, { silent } = {}) {
      const w = this.discover().find((x) => x.id === walletId);
      if (!w) throw new WalletError('not_detected', 'That wallet is not available in this browser.');
      const accounts = await w.provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' });
      if (!accounts || !accounts.length) {
        if (silent) return null;
        throw new WalletError('locked', 'The wallet did not share an account. Unlock it and choose an account.');
      }
      const chainId = await w.provider.request({ method: 'eth_chainId' }).catch(() => null);
      return { walletId, walletName: w.name, provider: w.provider, accounts, chainId, network: chainId ? evmName(chainId) : '' };
    },
    async sign(session, address, message) {
      const current = await session.provider.request({ method: 'eth_accounts' });
      if (!current.some((a) => normalize('evm', a) === normalize('evm', address))) {
        throw new WalletError('switched', 'Select that account in your wallet, then try again.');
      }
      const hex = '0x' + hexOf(new TextEncoder().encode(message));
      return { signature: await session.provider.request({ method: 'personal_sign', params: [hex, address] }) };
    },
    async disconnect() { /* EIP-1193 has no disconnect: Questora simply stops using the session. */ },
    watch(session, cb) {
      const p = session.provider;
      if (!p.on) return () => {};
      const onAcc = (accounts) => cb(accounts && accounts.length ? { type: 'accounts', accounts } : { type: 'disconnect' });
      const onChain = (chainId) => cb({ type: 'network', chainId, network: evmName(chainId) });
      const onDis = () => cb({ type: 'disconnect' });
      p.on('accountsChanged', onAcc); p.on('chainChanged', onChain); p.on('disconnect', onDis);
      const off = p.removeListener ? 'removeListener' : 'off';
      return () => { try { p[off]('accountsChanged', onAcc); p[off]('chainChanged', onChain); p[off]('disconnect', onDis); } catch (e) { /* ignore */ } };
    },
  };

  // ---- Wallet Standard (Solana, Sui) --------------------------------------
  function standardConnector(cfg) {
    const accountsOf = (w, list) => (list || w.accounts || []).filter((a) => !a.chains || !a.chains.length || a.chains.some((c) => String(c).startsWith(cfg.prefix)));
    const pick = (id) => QW.registry.standardWallets().filter((w) => feat(w, 'standard:connect') && hasChain(w, cfg.prefix)).find((w) => slug(w.name) === id);
    return {
      id: cfg.id, ns: cfg.ns, label: cfg.label, unit: cfg.label, explorer: cfg.explorer, catalog: cfg.catalog,
      discover() {
        const out = [];
        const seen = new Set();
        for (const w of QW.registry.standardWallets()) {
          if (!feat(w, 'standard:connect') || !hasChain(w, cfg.prefix) || seen.has(slug(w.name))) continue;
          seen.add(slug(w.name));
          out.push({ id: slug(w.name), name: w.name, icon: w.icon, source: 'Wallet Standard', unsupported: feat(w, cfg.signFeature) ? '' : 'This wallet cannot sign messages for ' + cfg.label + '.' });
        }
        return out;
      },
      async connect(walletId, { silent } = {}) {
        const w = pick(walletId);
        if (!w) throw new WalletError('not_detected', 'That wallet is not available in this browser.');
        const res = await feat(w, 'standard:connect').connect(silent ? { silent: true } : undefined);
        const accounts = accountsOf(w, res && res.accounts && res.accounts.length ? res.accounts : null);
        if (!accounts.length) {
          if (silent) return null;
          throw new WalletError('locked', 'The wallet did not share an account. Unlock it and choose an account.');
        }
        const chain = (accounts[0].chains || w.chains || []).find((c) => String(c).startsWith(cfg.prefix)) || '';
        return { walletId, walletName: w.name, wallet: w, accountObjs: accounts, accounts: accounts.map((a) => a.address), chainId: chain, network: chain.replace(cfg.prefix, '') };
      },
      async sign(session, address, message) {
        const account = session.accountObjs.find((a) => normalize(cfg.id, a.address) === normalize(cfg.id, address));
        const f = feat(session.wallet, cfg.signFeature);
        if (!account || !f) throw new WalletError('unsupported', 'This wallet cannot sign messages for ' + cfg.label + '.');
        return cfg.sign(f, account, new TextEncoder().encode(message));
      },
      async disconnect(session) {
        const f = feat(session.wallet, 'standard:disconnect');
        if (f) await f.disconnect();
      },
      watch(session, cb) {
        const f = feat(session.wallet, 'standard:events');
        if (!f) return () => {};
        let last = session.accounts.join(',');
        let lastChain = session.chainId;
        return f.on('change', (c) => {
          if (c.accounts) {
            const list = accountsOf(session.wallet, c.accounts);
            session.accountObjs = list;
            const key = list.map((a) => a.address).join(',');
            if (key !== last) {
              last = key;
              cb(list.length ? { type: 'accounts', accounts: list.map((a) => a.address) } : { type: 'disconnect' });
            }
          }
          const chain = ((c.accounts && c.accounts[0] && c.accounts[0].chains) || c.chains || []).find((x) => String(x).startsWith(cfg.prefix));
          if (chain && chain !== lastChain) { lastChain = chain; cb({ type: 'network', chainId: chain, network: chain.replace(cfg.prefix, '') }); }
        });
      },
    };
  }

  const solana = standardConnector({
    id: 'solana', ns: 'solana', label: 'Solana', prefix: 'solana:', signFeature: 'solana:signMessage',
    explorer: (a) => 'https://solscan.io/account/' + a,
    catalog: [
      { id: 'phantom', name: 'Phantom', install: 'https://phantom.com/download', mobile: (u) => 'https://phantom.app/ul/browse/' + enc(u) + '?ref=' + enc(location.origin) },
      { id: 'solflare', name: 'Solflare', install: 'https://solflare.com/download', mobile: (u) => 'https://solflare.com/ul/v1/browse/' + enc(u) + '?ref=' + enc(location.origin) },
      { id: 'backpack', name: 'Backpack', install: 'https://backpack.app/download' },
      { id: 'okx-wallet', name: 'OKX Wallet', install: 'https://www.okx.com/web3', mobile: (u) => 'okx://wallet/dapp/url?dappUrl=' + enc(u) },
    ],
    async sign(f, account, bytes) {
      const out = await f.signMessage({ account, message: bytes });
      const first = Array.isArray(out) ? out[0] : out;
      return { signature: b64(toBytes(first.signature)) };
    },
  });

  const sui = standardConnector({
    id: 'sui', ns: 'sui', label: 'Sui', prefix: 'sui:', signFeature: 'sui:signPersonalMessage',
    explorer: (a) => 'https://suiscan.xyz/mainnet/account/' + a,
    catalog: [
      { id: 'slush', name: 'Slush', install: 'https://slush.app/' },
      { id: 'phantom', name: 'Phantom', install: 'https://phantom.com/download', mobile: (u) => 'https://phantom.app/ul/browse/' + enc(u) + '?ref=' + enc(location.origin) },
      { id: 'backpack', name: 'Backpack', install: 'https://backpack.app/download' },
      { id: 'okx-wallet', name: 'OKX Wallet', install: 'https://www.okx.com/web3', mobile: (u) => 'okx://wallet/dapp/url?dappUrl=' + enc(u) },
      { id: 'nightly', name: 'Nightly', install: 'https://nightly.app/' },
      { id: 'ethos-wallet', name: 'Ethos Wallet', install: 'https://ethoswallet.xyz/' },
    ],
    // The serialized Sui signature already carries the public key.
    async sign(f, account, bytes) {
      const out = await f.signPersonalMessage({ account, message: bytes });
      return { signature: typeof out.signature === 'string' ? out.signature : b64(toBytes(out.signature)) };
    },
  });

  // ---- Aptos: AIP-62 Wallet Standard --------------------------------------
  const aptosWallets = () => QW.registry.standardWallets().filter((w) => feat(w, 'aptos:connect'));
  const addrOf = (info) => String(info && info.address && info.address.toString ? info.address.toString() : (info && info.address) || '');
  const aptos = {
    id: 'aptos', ns: 'aptos', label: 'Aptos', unit: 'Aptos',
    explorer: (a) => 'https://explorer.aptoslabs.com/account/' + a,
    catalog: [
      { id: 'petra', name: 'Petra', install: 'https://petra.app/', mobile: (u) => 'https://petra.app/explore?link=' + enc(u) },
      { id: 'nightly', name: 'Nightly', install: 'https://nightly.app/' },
      { id: 'backpack', name: 'Backpack', install: 'https://backpack.app/download' },
      { id: 'okx-wallet', name: 'OKX Wallet', install: 'https://www.okx.com/web3', mobile: (u) => 'okx://wallet/dapp/url?dappUrl=' + enc(u) },
      { id: 'pontem-wallet', name: 'Pontem Wallet', install: 'https://pontem.network/pontem-wallet' },
    ],
    discover() {
      const seen = new Set();
      const out = [];
      for (const w of aptosWallets()) {
        if (seen.has(slug(w.name))) continue;
        seen.add(slug(w.name));
        out.push({ id: slug(w.name), name: w.name, icon: w.icon, source: 'AIP-62', unsupported: feat(w, 'aptos:signMessage') ? '' : 'This wallet cannot sign messages.' });
      }
      return out;
    },
    async connect(walletId, { silent } = {}) {
      const w = aptosWallets().find((x) => slug(x.name) === walletId);
      if (!w) throw new WalletError('not_detected', 'That wallet is not available in this browser.');
      const res = await feat(w, 'aptos:connect').connect(!!silent);
      if (!res || res.status === 'Rejected') {
        if (silent) return null;
        throw new WalletError('rejected', 'The request was declined in the wallet.');
      }
      const address = addrOf(res.args || res);
      const keys = {};
      keys[normalize('aptos', address)] = toBytes((res.args || res).publicKey);
      const net = feat(w, 'aptos:network') ? await feat(w, 'aptos:network').network().catch(() => null) : null;
      return { walletId, walletName: w.name, wallet: w, keys, accounts: [address], chainId: net ? String(net.chainId || '') : '', network: net ? String(net.name || '') : '' };
    },
    async sign(session, address, message, { nonce }) {
      const f = feat(session.wallet, 'aptos:signMessage');
      if (!f) throw new WalletError('unsupported', 'This wallet cannot sign messages.');
      const acc = feat(session.wallet, 'aptos:account') ? await feat(session.wallet, 'aptos:account').account().catch(() => null) : null;
      if (acc && normalize('aptos', addrOf(acc)) !== normalize('aptos', address)) {
        throw new WalletError('switched', 'Select that account in your wallet, then try again.');
      }
      const res = await f.signMessage({ message, nonce });
      if (!res || res.status === 'Rejected') throw new WalletError('rejected', 'The request was declined in the wallet.');
      const out = res.args || res;
      const key = (acc && toBytes(acc.publicKey)) || session.keys[normalize('aptos', address)];
      if (!key) throw new WalletError('unsupported', 'This wallet did not share a public key.');
      const full = typeof out.fullMessage === 'string' ? out.fullMessage : '';
      return { signature: b64(toBytes(out.signature)), publicKey: b64(key), signedMessage: full };
    },
    async disconnect(session) {
      const f = feat(session.wallet, 'aptos:disconnect');
      if (f) await f.disconnect();
    },
    watch(session, cb) {
      let alive = true; // AIP-62 listeners have no unsubscribe
      const a = feat(session.wallet, 'aptos:onAccountChange');
      const n = feat(session.wallet, 'aptos:onNetworkChange');
      if (a) a.onAccountChange((info) => {
        if (!alive) return;
        if (!info || !info.address) return cb({ type: 'disconnect' });
        const address = addrOf(info);
        session.keys[normalize('aptos', address)] = toBytes(info.publicKey);
        cb({ type: 'accounts', accounts: [address] });
      });
      if (n) n.onNetworkChange((net) => { if (alive) cb({ type: 'network', chainId: String(net.chainId || ''), network: String(net.name || '') }); });
      return () => { alive = false; };
    },
  };

  // ---- Octra: the 0xio wallet and its SDK ---------------------------------
  // 0xio runs as a browser extension (private message channel), inside 0xio
  // Desktop (iframe relay) and inside the 0xio app (WebView bridge). The
  // official SDK picks the transport, so the connector loads it on demand and
  // talks only to the SDK. It is not EVM: addresses are oct + base58.
  let sdkLoad = null;
  function loadSdk() {
    if (window.ZeroXIOWalletSDK) return Promise.resolve(window.ZeroXIOWalletSDK);
    if (!sdkLoad) {
      sdkLoad = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/vendor/0xio-sdk.js';
        s.onload = () => (window.ZeroXIOWalletSDK ? resolve(window.ZeroXIOWalletSDK) : reject(new Error('0xio SDK missing')));
        s.onerror = () => { sdkLoad = null; reject(new Error('0xio SDK failed to load')); };
        document.head.appendChild(s);
      });
    }
    return sdkLoad;
  }
  const octraMarkers = () => !!(window.wallet0xio || window.ZeroXIOWallet || (window.octra && window.octra.isOctra));
  // Pre-announced signals only; the in-app and desktop transports cannot be
  // seen synchronously, which is why connect() always tries the SDK.
  const octraWalletBrowser = () => /0xio/i.test(navigator.userAgent || '') || !!(window.wallet0xio && window.wallet0xio.isInApp);

  const octra = {
    id: 'octra', ns: 'octra', label: 'Octra', unit: 'Octra',
    explorer: (a) => 'https://octrascan.io/addresses/' + a,
    walletBrowser: octraWalletBrowser,
    catalog: [{ id: '0xio', name: '0xio Wallet', install: 'https://0xio.xyz/install', openInWallet: true }],
    discover() {
      const out = [];
      if (octraMarkers() || octraWalletBrowser()) out.push({ id: '0xio', name: '0xio Wallet', source: octraWalletBrowser() ? 'wallet browser' : 'extension' });
      else if (window.octra && typeof window.octra.request === 'function') out.push({ id: 'octra-provider', name: 'Octra wallet', source: 'RFC-O-1 window.octra' });
      return out;
    },
    async connect(walletId, { silent } = {}) {
      let sdk;
      try { sdk = await loadSdk(); } catch (e) { throw new WalletError('sdk', 'The Octra wallet connector could not load. Check your connection and retry.', e); }
      const wallet = new sdk.ZeroXIOWallet({ appName: 'Questora', appDescription: 'Quests and campaigns', requiredPermissions: ['accounts', 'public_transactions'] });
      try { await wallet.initialize(); } catch (e) {
        throw new WalletError('not_detected', 'Questora could not reach an Octra wallet in this browser.', e);
      }
      let info;
      if (silent) {
        info = await wallet.getConnectionStatus().catch(() => null);
        if (!info || !info.isConnected) return null;
      } else info = await wallet.connect();
      const address = info.address || (wallet.getAddress && await wallet.getAddress());
      if (!address) throw new WalletError('locked', 'The wallet did not share an account. Unlock it and choose an account.');
      const net = info.networkInfo || {};
      return { walletId, walletName: '0xio Wallet', wallet, accounts: [address], publicKey: info.publicKey || null, chainId: net.id || '', network: net.name || net.id || '' };
    },
    async sign(session, address, message) {
      const signature = await session.wallet.signMessage(message);
      let publicKey = session.publicKey;
      if (!publicKey && session.wallet.getPublicKey) publicKey = await session.wallet.getPublicKey();
      if (!publicKey) throw new WalletError('unsupported', 'This wallet did not share a public key.');
      return { signature: typeof signature === 'string' ? signature : String(signature && signature.signature), publicKey };
    },
    async disconnect(session) { try { await session.wallet.disconnect(); } catch (e) { /* the wallet may already be disconnected */ } },
    watch(session, cb) {
      const w = session.wallet;
      if (!w.on) return () => {};
      const get = (e, k) => (e && e.data && e.data[k]) || (e && e[k]);
      const onAcc = (e) => { const a = get(e, 'newAddress'); if (a) { session.accounts = [a]; if (get(e, 'publicKey')) session.publicKey = get(e, 'publicKey'); cb({ type: 'accounts', accounts: [a] }); } };
      const onNet = (e) => { const n = get(e, 'newNetwork') || {}; cb({ type: 'network', chainId: n.id || '', network: n.name || n.id || '' }); };
      const onDis = () => cb({ type: 'disconnect' });
      w.on('accountChanged', onAcc); w.on('networkChanged', onNet); w.on('disconnect', onDis);
      return () => { try { w.off && (w.off('accountChanged', onAcc), w.off('networkChanged', onNet), w.off('disconnect', onDis)); } catch (e) { /* ignore */ } };
    },
  };

  QW.connectors = { evm, solana, sui, aptos, octra };
  QW.ECOSYSTEMS = [
    { id: 'evm', label: 'EVM', ns: 'eip155' },
    { id: 'solana', label: 'Solana', ns: 'solana' },
    { id: 'sui', label: 'Sui', ns: 'sui' },
    { id: 'aptos', label: 'Aptos', ns: 'aptos' },
    { id: 'octra', label: 'Octra', ns: 'octra' },
  ];
  QW.deepLinkBase = here;
})();
