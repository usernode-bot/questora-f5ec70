// The one wallet layer the app talks to. It owns, per ecosystem:
//   - an explicit connection state: idle | detecting | available | connecting |
//     connected | switching | disconnecting | error
//   - a mutex, so connect / disconnect / switch never overlap
//   - the live wallet session (what the wallet is exposing right now)
// and, across ecosystems, the saved addresses. The server's `wallets` table
// is the record of what is saved and verified; nothing here treats a stored
// address as proof of ownership. An address counts as "connected" only while a
// live wallet session currently exposes it, and as "verified" only because the
// server checked a signature.
'use strict';
(function () {
  const QW = (window.QW = window.QW || {});
  const ECOS = QW.ECOSYSTEMS;
  const api = () => window.QuestoraAPI.api;
  const DETECT_WINDOW_MS = 3000;

  const S = {
    limit: 3, saved: [], loaded: false, dev: false, debug: false,
    eco: {}, pending: {}, startedAt: Date.now(), lastDetect: null,
  };
  const live = {};      // per ecosystem: { unwatch }
  const tails = {};     // per ecosystem: promise chain (the mutex)
  const inflight = {};  // per ecosystem: the connect currently running
  const attempted = new Set();
  const devErrors = [];
  const listeners = new Set();
  const connector = (eco) => QW.connectors[eco];
  const nsOf = (eco) => connector(eco).ns;
  ECOS.forEach((e) => { S.eco[e.id] = { op: null, error: null, detected: [], sig: null, session: null }; });

  // Detailed errors stay in a dev-only buffer; users see plain-language text.
  QW.devLog = function (label, err) {
    devErrors.push({ at: new Date().toISOString(), label, message: String((err && err.message) || err || '').slice(0, 200) });
    if (devErrors.length > 30) devErrors.shift();
    if (S.debug) console.debug('[wallets]', label, err);
  };

  // ---- state + subscriptions ----------------------------------------------
  let emitQueued = false;
  function emit() {
    if (emitQueued) return;
    emitQueued = true;
    queueMicrotask(() => { emitQueued = false; listeners.forEach((fn) => { try { fn(); } catch (e) { QW.devLog('subscriber', e); } }); });
  }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  const detecting = () => Date.now() - S.startedAt < DETECT_WINDOW_MS;
  function status(eco) {
    const e = S.eco[eco];
    if (e.op) return e.op;
    if (e.error) return 'error';
    if (e.session) return 'connected';
    if (e.detected.length) return 'available';
    return detecting() ? 'detecting' : 'idle';
  }
  const wrongNetwork = (eco) => {
    const allowed = (window.QuestoraWalletConfig && window.QuestoraWalletConfig.allowedNetworks || {})[eco];
    const s = S.eco[eco].session;
    return !!(allowed && s && s.chainId && !allowed.includes(String(s.chainId).toLowerCase()));
  };
  const savedFor = (eco) => S.saved.filter((r) => r.chain_namespace === nsOf(eco));
  const count = (eco) => savedFor(eco).length;
  const atLimit = (eco) => count(eco) >= S.limit;
  const findSaved = (eco, address) => savedFor(eco).find((r) => QW.normalize(eco, r.address) === QW.normalize(eco, address));
  const isLive = (rec) => {
    const eco = ECOS.find((e) => e.ns === rec.chain_namespace).id;
    const s = S.eco[eco].session;
    return !!(s && s.accounts.some((a) => QW.normalize(eco, a) === QW.normalize(eco, rec.address)));
  };
  const limitText = (eco) => `Maximum ${S.limit} ${connector(eco).label} addresses connected. Disconnect an existing ${connector(eco).label} address before connecting another.`;

  // ---- mutex ----------------------------------------------------------------
  // Everything that touches an ecosystem's wallet runs one at a time. A second
  // connect while one is running joins it instead of starting another prompt.
  function exclusive(eco, fn) {
    const run = (tails[eco] || Promise.resolve()).catch(() => {}).then(fn);
    tails[eco] = run;
    return run;
  }
  function setOp(eco, op) { S.eco[eco].op = op; if (op) S.eco[eco].error = null; emit(); }
  function fail(eco, err) {
    const we = QW.toWalletError(err);
    QW.devLog(eco + ' ' + we.code, we.cause || err);
    // A declined prompt is the user's choice, not a fault to display.
    S.eco[eco].error = we.code === 'rejected' ? null : { code: we.code, message: we.message };
    emit();
    return we;
  }

  // ---- saved addresses (server) ----------------------------------------------
  async function loadSaved() {
    try {
      const r = await api().get('/api/v1/wallets');
      S.saved = r.wallets || [];
      if (r.limit) S.limit = r.limit;
      S.loaded = true;
    } catch (e) { QW.devLog('load saved', e); }
    emit();
  }
  async function loadConfig() {
    try {
      const c = await api().get('/api/v1/wallets/chains');
      if (c.limit) S.limit = c.limit;
      S.dev = !!c.dev;
    } catch (e) { /* the limit default matches the server */ }
    let flag = false;
    try { flag = localStorage.getItem('questora.wallet.debug') === '1'; } catch (e) { /* storage may be blocked */ }
    S.debug = S.dev || flag || /[?&]walletDebug=1/.test(location.search);
    emit();
  }

  // ---- detection -------------------------------------------------------------
  let detectTimer = null;
  function detect(reason) {
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => runDetect(reason), 60);
  }
  function runDetect(reason) {
    QW.registry.requestAll();
    let changed = false;
    for (const e of ECOS) {
      const list = connector(e.id).discover();
      const sig = list.map((w) => w.id + (w.unsupported ? '!' : '')).join('|');
      const st = S.eco[e.id];
      if (sig !== st.sig) { st.sig = sig; st.detected = list; changed = true; }
      // A session whose wallet disappeared is no longer live.
      if (st.session && !list.some((w) => w.id === st.session.walletId) && e.id !== 'octra') drop(e.id);
    }
    S.lastDetect = { reason, at: new Date().toISOString() };
    if (changed) emit();
    restore();
  }

  // Reconnect saved wallets without prompting: only wallets already detected,
  // only a silent request, and only once per wallet until the page comes back
  // from the background. A match to a saved address makes it live; nothing is
  // signed and nothing is trusted from storage.
  function restore() {
    for (const e of ECOS) {
      const st = S.eco[e.id];
      if (st.session || st.op) continue;
      const ids = new Set(savedFor(e.id).map((r) => r.wallet_id).filter(Boolean));
      for (const id of ids) {
        const key = e.id + ':' + id;
        if (attempted.has(key) || !st.detected.some((w) => w.id === id && !w.unsupported)) continue;
        attempted.add(key);
        exclusive(e.id, async () => {
          if (S.eco[e.id].session) return;
          try {
            const s = await connector(e.id).connect(id, { silent: true });
            if (s && s.accounts.some((a) => findSaved(e.id, a))) adopt(e.id, s);
          } catch (err) { QW.devLog('restore ' + e.id, err); }
        });
      }
    }
  }
  function retryRestore() { for (const k of Array.from(attempted)) { const eco = k.split(':')[0]; if (!S.eco[eco].session) attempted.delete(k); } }

  // ---- sessions ----------------------------------------------------------------
  function drop(eco) {
    const l = live[eco];
    if (l && l.unwatch) { try { l.unwatch(); } catch (e) { /* ignore */ } }
    live[eco] = null;
    S.eco[eco].session = null;
    emit();
  }
  function adopt(eco, session) {
    drop(eco);
    S.eco[eco].session = session;
    live[eco] = { unwatch: connector(eco).watch(session, (ev) => onWalletEvent(eco, session, ev)) };
    emit();
  }

  // The user changed account / network / disconnected inside the wallet.
  function onWalletEvent(eco, session, ev) {
    if (S.eco[eco].session !== session) return;
    if (ev.type === 'disconnect') { drop(eco); return; }
    if (ev.type === 'network') { session.chainId = ev.chainId; session.network = ev.network; emit(); return; }
    if (ev.type !== 'accounts') return;
    session.accounts = ev.accounts;
    const address = ev.accounts[0];
    const rec = findSaved(eco, address);
    if (rec) {
      delete S.pending[eco];
      if (!rec.is_active) exclusive(eco, async () => { setOp(eco, 'switching'); try { await activate(rec.id); } finally { setOp(eco, null); } });
    } else {
      // Never replaced or added silently: the user decides.
      S.pending[eco] = { address, walletId: session.walletId, walletName: session.walletName, atLimit: atLimit(eco) };
    }
    emit();
  }

  // ---- operations --------------------------------------------------------------
  async function linkAddress(eco, session, address) {
    const c = connector(eco);
    const ch = await api().post('/api/v1/wallets/challenge', { chain: c.ns, address });
    const proof = await c.sign(session, address, ch.message, { nonce: ch.nonce });
    await api().post('/api/v1/wallets/verify', { chain: c.ns, address, nonce: ch.nonce, walletId: session.walletId, walletName: session.walletName, ...proof });
    await loadSaved();
    const rec = findSaved(eco, address);
    if (rec && !rec.is_active) await activate(rec.id);
    delete S.pending[eco];
    return { status: 'added', record: rec };
  }
  const isLimitErr = (err) => err && err.code === 'wallet_limit';

  // Connect a wallet and save one of its addresses (user gesture required).
  function addAddress(eco, walletId) {
    if (inflight[eco]) return inflight[eco];
    const p = exclusive(eco, async () => {
      if (atLimit(eco)) return { status: 'limit' };
      setOp(eco, 'connecting');
      try {
        const session = await connector(eco).connect(walletId);
        adopt(eco, session);
        // Prefer an account that is not saved yet when the wallet shares several.
        const address = session.accounts.find((a) => !findSaved(eco, a)) || session.accounts[0];
        const existing = findSaved(eco, address);
        if (existing) { if (!existing.is_active) await activate(existing.id); return { status: 'existing', record: existing }; }
        return await linkAddress(eco, session, address);
      } catch (err) {
        if (isLimitErr(err)) { await loadSaved(); return { status: 'limit' }; }
        throw fail(eco, err);
      } finally { setOp(eco, null); }
    });
    inflight[eco] = p;
    const clear = () => { if (inflight[eco] === p) inflight[eco] = null; };
    p.then(clear, clear);
    return p;
  }

  // Save the address the user just switched to in their wallet.
  function addPending(eco) {
    return exclusive(eco, async () => {
      const pend = S.pending[eco];
      const session = S.eco[eco].session;
      if (!pend || !session) return { status: 'none' };
      if (atLimit(eco)) return { status: 'limit' };
      setOp(eco, 'connecting');
      try { return await linkAddress(eco, session, pend.address); }
      catch (err) { if (isLimitErr(err)) { await loadSaved(); return { status: 'limit' }; } throw fail(eco, err); }
      finally { setOp(eco, null); }
    });
  }

  // Bring a saved address back to a live session (user gesture; may prompt).
  function reconnect(id) {
    const rec = S.saved.find((r) => r.id === id);
    if (!rec) return Promise.resolve({ status: 'none' });
    const eco = ECOS.find((e) => e.ns === rec.chain_namespace).id;
    const st = S.eco[eco];
    const walletId = rec.wallet_id || (st.detected.length === 1 ? st.detected[0].id : null);
    if (!walletId) return Promise.reject(new QW.WalletError('choose', 'Choose the wallet that holds this address.'));
    return exclusive(eco, async () => {
      setOp(eco, 'connecting');
      try {
        const session = await connector(eco).connect(walletId);
        if (!session.accounts.some((a) => QW.normalize(eco, a) === QW.normalize(eco, rec.address))) {
          adopt(eco, session);
          throw new QW.WalletError('wrong_account', 'Your wallet is not sharing this address. Select it in the wallet, then reconnect.');
        }
        adopt(eco, session);
        attempted.add(eco + ':' + walletId);
        return { status: 'connected', record: rec };
      } catch (err) { throw fail(eco, err); }
      finally { setOp(eco, null); }
    });
  }

  async function activate(id) {
    await api().patch('/api/v1/wallets/' + id, { active: true });
    await loadSaved();
  }
  async function rename(id, label) {
    await api().patch('/api/v1/wallets/' + id, { label });
    await loadSaved();
  }

  function disconnectRecord(id) {
    const rec = S.saved.find((r) => r.id === id);
    if (!rec) return Promise.resolve();
    const eco = ECOS.find((e) => e.ns === rec.chain_namespace).id;
    return exclusive(eco, async () => {
      setOp(eco, 'disconnecting');
      try {
        await api().del('/api/v1/wallets/' + id);
        await loadSaved();
        // Only end the wallet session when none of its accounts is still saved;
        // other saved addresses on the same wallet stay connected.
        const s = S.eco[eco].session;
        if (s && !s.accounts.some((a) => findSaved(eco, a))) { try { await connector(eco).disconnect(s); } catch (e) { QW.devLog('disconnect', e); } drop(eco); }
        delete S.pending[eco];
      } catch (err) { throw fail(eco, err); }
      finally { setOp(eco, null); }
    });
  }
  async function disconnectAll() {
    await api().del('/api/v1/wallets');
    await loadSaved();
    await Promise.all(ECOS.map((e) => exclusive(e.id, async () => {
      const s = S.eco[e.id].session;
      if (s) { try { await connector(e.id).disconnect(s); } catch (err) { QW.devLog('disconnect', err); } drop(e.id); }
      delete S.pending[e.id];
    })));
  }
  function clearError(eco) { S.eco[eco].error = null; emit(); }

  // ---- diagnostics (developer panel) ---------------------------------------------
  function diagnostics() {
    const names = (eco) => S.eco[eco].detected.map((w) => w.name);
    const ua = navigator.userAgent || '';
    return {
      evmProviderDetected: S.eco.evm.detected.length > 0,
      evmProviders: S.eco.evm.detected.map((w) => w.name + ' (' + w.source + ')'),
      solanaWallets: names('solana'),
      suiWallets: names('sui'),
      aptosWallets: names('aptos'),
      aptosAip62Wallets: QW.registry.standardWallets().filter((w) => w.features && w.features['aptos:connect']).map((w) => w.name),
      octraProviderDetected: S.eco.octra.detected.length > 0,
      mobileEnvironment: /Android|iPhone|iPad|iPod/i.test(ua),
      walletBrowser: connector('octra').walletBrowser() ? 'detected' : 'not detected',
      registrationTiming: QW.registry.timing(),
      lastDetect: S.lastDetect,
      errors: devErrors.slice(-10),
      sessions: ECOS.map((e) => {
        const s = S.eco[e.id].session;
        return { ecosystem: e.id, state: status(e.id), wallet: s ? s.walletName : null, network: s ? s.network : null, chainId: s ? s.chainId : null, activeAddress: s ? s.accounts[0] : null };
      }),
    };
  }

  // ---- boot ------------------------------------------------------------------------
  function init() {
    if (QW.started) return;
    QW.started = true;
    loadConfig();
    loadSaved().then(restore);
    QW.registry.onChange(() => detect('registration'));
    // Wallets can register at any point: after load, after focus, on return
    // from a wallet app. Re-ask on each, and a few times early on.
    const retry = (reason) => { retryRestore(); detect(reason); };
    window.addEventListener('focus', () => retry('focus'));
    window.addEventListener('pageshow', () => retry('pageshow'));
    window.addEventListener('load', () => detect('load'));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retry('visibilitychange'); });
    runDetect('init');
    [250, 750, 1500, DETECT_WINDOW_MS + 50].forEach((ms) => setTimeout(() => { runDetect('timer ' + ms); emit(); }, ms));
  }

  window.QuestoraWallets = {
    CHAINS: ECOS.map((e) => ({ chain: e.ns, label: e.label, id: e.id })),
    ECOSYSTEMS: ECOS,
    init, subscribe, state: () => S, status, count, atLimit, limitText, savedFor, isLive, wrongNetwork, findSaved,
    detect: (reason) => runDetect(reason || 'manual'),
    addAddress, addPending, reconnect, activate, rename, disconnectRecord, disconnectAll, clearError, reload: loadSaved,
    diagnostics,
    // True when the user has at least one verified address; the quest flow
    // reads the server, this is only for the UI.
    hasVerified: () => S.saved.some((r) => r.verified_at),
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
