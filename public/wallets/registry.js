// Wallet discovery. Two browser standards cover almost every wallet:
//   - Wallet Standard (Solana, Sui, Aptos AIP-62): wallets announce themselves
//     with a `wallet-standard:register-wallet` event, and an app announces it
//     is listening with `wallet-standard:app-ready`. Wallets that loaded first
//     register on app-ready, wallets that load later fire register-wallet, so
//     both directions are handled and registration order never matters.
//   - EIP-6963 (EVM): wallets answer `eip6963:requestProvider` with an
//     `eip6963:announceProvider` event carrying a provider and its identity.
// Nothing here assumes a wallet-specific global.
'use strict';
(function () {
  const QW = (window.QW = window.QW || {});
  const t0 = performance.now();
  const standard = new Set();
  const eip = new Map();
  const listeners = new Set();
  const timing = [];
  const note = (what) => { if (timing.length < 40) timing.push({ at: Math.round(performance.now() - t0), what }); };
  const changed = () => listeners.forEach((fn) => { try { fn(); } catch (e) { QW.devLog && QW.devLog('registry listener', e); } });

  function register(...wallets) {
    let added = false;
    for (const w of wallets) {
      if (w && !standard.has(w)) { standard.add(w); added = true; note('standard:' + w.name); }
    }
    if (added) changed();
    return function unregister() { wallets.forEach((w) => standard.delete(w)); changed(); };
  }
  const api = Object.freeze({ register });

  window.addEventListener('wallet-standard:register-wallet', (ev) => {
    try { if (typeof ev.detail === 'function') ev.detail(api); } catch (e) { QW.devLog && QW.devLog('register-wallet', e); }
  });
  window.addEventListener('eip6963:announceProvider', (ev) => {
    const d = ev.detail;
    if (!d || !d.info || !d.info.uuid || !d.provider || typeof d.provider.request !== 'function') return;
    if (!eip.has(d.info.uuid)) note('eip6963:' + (d.info.name || d.info.rdns));
    eip.set(d.info.uuid, { info: d.info, provider: d.provider });
    changed();
  });

  // Ask again. Cheap and idempotent: a wallet that registered already is
  // ignored, one that missed the first request answers this one.
  function requestAll() {
    try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api })); } catch (e) { /* ignore */ }
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (e) { /* ignore */ }
  }

  QW.registry = {
    standardWallets: () => Array.from(standard),
    eipProviders: () => Array.from(eip.values()),
    requestAll,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    timing: () => timing.slice(),
  };
  note('registry ready');
  requestAll();
})();
