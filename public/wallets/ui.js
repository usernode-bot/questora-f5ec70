// Wallet UI: the Connect wallet modal (grouped by network), the saved-address
// manager shown on the profile's Wallets tab, and the developer diagnostics
// panel. Pure rendering over QuestoraWallets state; every class is a whole
// literal so the precompiled stylesheet covers it.
'use strict';
(function () {
  const QW = window.QW;
  const W = () => window.QuestoraWallets;
  const { el, escapeHtml: esc, toast, icon, BTN_SECONDARY, BTN_ICON } = window.QUI;
  const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');

  const PILL = {
    ok: 'bg-emerald-500/15 text-emerald-300',
    warn: 'bg-amber-500/15 text-amber-300',
    info: 'bg-sky-500/15 text-sky-300',
    mute: 'bg-zinc-800 text-zinc-400',
    bad: 'bg-red-500/15 text-red-300',
  };
  const pill = (text, tone) => `<span class="inline-block text-xs font-medium px-2 py-0.5 rounded-full ${PILL[tone || 'mute']}">${esc(text)}</span>`;
  // Shared with the rest of the app via QUI, so the wallet UI cannot drift.
  const BTN = BTN_SECONDARY;
  const LINK_BTN = BTN_SECONDARY;
  const short = (a) => (a.length > 18 ? a.slice(0, 8) + '…' + a.slice(-6) : a);
  const ecoOf = (rec) => W().ECOSYSTEMS.find((e) => e.ns === rec.chain_namespace);
  const connectorOf = (id) => QW.connectors[id];

  const STATUS_PILL = {
    detecting: ['Looking for wallets', 'mute'], idle: ['No wallet detected', 'mute'], available: ['Available', 'ok'],
    connecting: ['Connecting', 'info'], connected: ['Connected', 'ok'], switching: ['Switching account', 'info'],
    disconnecting: ['Disconnecting', 'info'], error: ['Needs attention', 'bad'],
  };
  function statusPill(eco) {
    if (W().wrongNetwork(eco)) return pill('Wrong network', 'warn');
    const [t, tone] = STATUS_PILL[W().status(eco)];
    return pill(t, tone);
  }

  // The reason shown for a failed connect: what actually happened, never a
  // claim that no wallet exists unless detection really found nothing.
  function errorBlock(eco) {
    const e = W().state().eco[eco];
    if (!e.error) return null;
    const c = connectorOf(eco);
    const msg = e.error.code === 'not_detected'
      ? `Questora couldn't detect ${/^[AEIOU]/i.test(c.label) ? 'an' : 'a'} ${c.label} wallet provider yet.`
      : e.error.message;
    const box = el(`<div class="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200" role="alert">
      <p>${esc(msg)}</p>
      <div class="mt-2 flex flex-wrap gap-2"><button class="retry ${BTN}">Retry detection</button></div></div>`);
    box.querySelector('.retry').addEventListener('click', () => { W().clearError(eco); W().detect('retry'); });
    return box;
  }

  function copy(text) {
    const done = () => toast('Address copied');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => toast('Could not copy the address', true));
    else toast('Could not copy the address', true);
  }
  function openInWallet(link) { window.open(link, '_blank', 'noopener'); }

  // ---- saved address row ------------------------------------------------------
  function savedRow(rec, ctx) {
    const eco = ecoOf(rec).id;
    const c = connectorOf(eco);
    const liveNow = W().isLive(rec);
    const busy = ['connecting', 'switching', 'disconnecting'].includes(W().status(eco));
    const name = rec.nickname || rec.wallet_name || c.label + ' address';
    const row = el(`<div class="saved-row rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div class="flex flex-wrap items-center gap-2">
        <span class="name font-medium min-w-0 truncate">${esc(name)}</span>
        ${pill('Verified', 'ok')}${rec.is_active ? pill('Active', 'info') : ''}${liveNow ? pill('Connected', 'ok') : pill('Disconnected', 'mute')}
      </div>
      <p class="font-mono text-sm text-zinc-300 mt-1 break-all" title="${esc(rec.address)}">${esc(short(rec.address))}</p>
      <div class="actions mt-2 flex flex-wrap gap-2"></div></div>`);
    const acts = row.querySelector('.actions');
    const add = (label, cls, fn) => { const b = el(`<button class="${cls || BTN}"${busy ? ' disabled' : ''}>${esc(label)}</button>`); b.addEventListener('click', fn); acts.appendChild(b); return b; };
    const guard = (p, okMsg) => p.then(() => okMsg && toast(okMsg), (err) => {
      if (err && err.code === 'choose') { ctx.openModal(eco); return; }
      toast(err.message || 'Something went wrong. Try again.', true);
    });
    if (!rec.is_active) add('Make active', BTN, () => guard(W().activate(rec.id), 'Active address updated'));
    if (!liveNow) add('Reconnect', BTN, () => guard(W().reconnect(rec.id), 'Wallet reconnected'));
    add('Rename', BTN, () => {
      const input = el(`<input type="text" maxlength="40" value="${esc(rec.nickname || '')}" placeholder="Label" aria-label="Address label" class="px-3 py-2 min-h-[44px] rounded-lg bg-zinc-950 border border-zinc-700 text-sm w-full md:w-56">`);
      const nameEl = row.querySelector('.name');
      nameEl.replaceWith(input);
      input.focus();
      let done = false;
      const finish = (save) => {
        if (done) return; done = true;
        if (save && input.value.trim() !== (rec.nickname || '')) guard(W().rename(rec.id, input.value.trim()), 'Label saved');
        else ctx.rerender();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
      input.addEventListener('blur', () => finish(true));
    });
    add('Copy', BTN, () => copy(rec.address));
    const ex = el(`<a class="${LINK_BTN}" href="${esc(c.explorer(rec.address))}" target="_blank" rel="noopener">${icon('open_in_new', { class: 'w-4 h-4' })}<span>Explorer</span></a>`);
    acts.appendChild(ex);
    add('Disconnect', BTN + ' !text-red-300', () => guard(W().disconnectRecord(rec.id), 'Address disconnected'));
    return row;
  }

  // ---- network section of the saved-address manager ------------------------------
  function managerSection(e, ctx) {
    const w = W();
    const recs = w.savedFor(e.id);
    const sec = el(`<section class="space-y-2" aria-label="${esc(e.label)} addresses">
      <div class="flex flex-wrap items-center gap-2"><h3 class="font-semibold">${esc(e.label)}</h3>
        <span class="text-sm text-zinc-400">${recs.length} of ${w.state().limit} addresses</span>${statusPill(e.id)}</div></section>`);
    const eb = errorBlock(e.id);
    if (eb) sec.appendChild(eb);
    const pend = w.state().pending[e.id];
    if (pend) {
      const box = el(`<div class="pending rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm">
        <p>${pend.atLimit ? esc(`Your ${w.state().limit} ${e.label} address limit has been reached.`) : 'You switched accounts in your wallet.'}</p>
        <p class="font-mono text-zinc-300 mt-1 break-all">${esc(short(pend.address))}</p></div>`);
      if (!pend.atLimit) {
        const b = el(`<button class="mt-2 ${BTN}">Add this address to Questora</button>`);
        b.addEventListener('click', () => w.addPending(e.id).then((r) => r.status === 'added' && toast('Address verified'), (err) => toast(err.message, true)));
        box.appendChild(b);
      }
      sec.appendChild(box);
    }
    if (!recs.length) sec.appendChild(el(`<p class="text-sm text-zinc-500">No ${esc(e.label)} addresses yet.</p>`));
    recs.forEach((r) => sec.appendChild(savedRow(r, ctx)));
    const full = w.atLimit(e.id);
    const b = el(`<button class="connect-another ${BTN}"${full ? ' disabled' : ''}>Connect another ${esc(e.label)} address</button>`);
    b.addEventListener('click', () => ctx.openModal(e.id));
    sec.appendChild(b);
    if (full) sec.appendChild(el(`<p class="text-sm text-amber-300">${esc(w.limitText(e.id))}</p>`));
    return sec;
  }

  function renderManager(root, ctx) {
    const w = W();
    const frag = document.createDocumentFragment();
    const top = el(`<div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm text-zinc-400">Link up to ${w.state().limit} addresses on each network. Questora asks your wallet to sign a message to verify each one. It never asks for a private key or seed phrase.</p></div>`);
    const connect = el('<button class="connect-wallet font-medium px-5 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white">Connect wallet</button>');
    connect.addEventListener('click', () => ctx.openModal());
    top.appendChild(connect);
    frag.appendChild(top);
    w.ECOSYSTEMS.forEach((e) => frag.appendChild(managerSection(e, ctx)));
    if (w.state().saved.length) {
      const all = el(`<button class="disconnect-all ${BTN} !text-red-300">Disconnect all addresses</button>`);
      let armed = false;
      all.addEventListener('click', () => {
        if (!armed) { armed = true; all.textContent = 'Confirm: disconnect all addresses'; setTimeout(() => { armed = false; all.textContent = 'Disconnect all addresses'; }, 4000); return; }
        w.disconnectAll().then(() => toast('All addresses disconnected'), (err) => toast(err.message, true));
      });
      frag.appendChild(all);
    }
    if (w.state().debug) frag.appendChild(debugPanel());
    root.replaceChildren(frag);
  }

  // Mount the manager into `container`; it follows wallet state until removed.
  function mountPanel(container) {
    const root = el('<div class="wallet-manager wallet-ui space-y-5"></div>');
    container.appendChild(root);
    const ctx = { openModal, rerender: () => renderManager(root, ctx) };
    const off = W().subscribe(() => {
      if (!root.isConnected) { off(); return; }
      // Leave an open rename field alone: re-rendering would drop the text.
      if (root.querySelector('input')) return;
      ctx.rerender();
    });
    ctx.rerender();
    W().reload();
    return root;
  }

  // ---- connect modal -----------------------------------------------------------
  let openModalRef = null;
  function openModal(focusEco, opts) {
    if (openModalRef) { openModalRef.focus(focusEco); return openModalRef; }
    const w = W();
    const prevFocus = document.activeElement;
    const overlay = el(`<div class="wallet-ui fixed inset-0 z-50 bg-black/60 flex items-end md:items-center justify-center" data-wallet-modal>
      <div role="dialog" aria-modal="true" aria-labelledby="wallet-modal-title" class="w-full md:max-w-xl max-h-[90vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-zinc-900 border border-zinc-800 p-5" style="padding-bottom:calc(1.25rem + var(--un-safe-inset-bottom, env(safe-area-inset-bottom, 0px)))">
        <div class="flex items-center justify-between gap-3 mb-1"><h2 id="wallet-modal-title" class="text-lg font-semibold">Connect wallet</h2>
          <button class="close ${BTN_ICON}" aria-label="Close">${icon('close')}</button></div>
        <p class="text-sm text-zinc-400 mb-4">Choose a network, then a wallet. You sign one message to prove you own the address.</p>
        <div class="body space-y-6"></div></div></div>`);
    const dialog = overlay.firstElementChild;
    const body = overlay.querySelector('.body');
    let focusedEco = focusEco;
    const ctx = { openModal: (eco) => { focusedEco = eco; render(); }, rerender: () => render() };

    function walletRows(e) {
      const c = connectorOf(e.id);
      const st = w.state().eco[e.id];
      const busy = ['connecting', 'switching', 'disconnecting'].includes(w.status(e.id));
      const rows = [];
      const detectedIds = new Set(st.detected.map((d) => d.id));
      const link = QW.deepLinkBase();
      const make = ({ name, id, tone, label, button, onClick, href, note, disabled }) => {
        const connectedHere = st.session && st.session.walletId === id;
        const r = el(`<div class="wallet-row flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 px-4 py-3" data-wallet="${esc(id)}">
          <span class="min-w-0"><span class="block font-medium">${esc(name)}</span>${note ? `<span class="block text-xs text-zinc-500">${esc(note)}</span>` : ''}</span>
          <span class="flex items-center gap-2">${connectedHere ? pill('Connected', 'ok') : pill(label, tone)}<span class="slot"></span></span></div>`);
        const slot = r.querySelector('.slot');
        if (href) slot.appendChild(el(`<a class="${LINK_BTN}" href="${esc(href)}" target="_blank" rel="noopener">${esc(button)}</a>`));
        else if (button) {
          const b = el(`<button class="${BTN}"${disabled || busy ? ' disabled' : ''}>${esc(button)}</button>`);
          b.addEventListener('click', onClick);
          slot.appendChild(b);
        }
        return r;
      };
      for (const d of st.detected) {
        rows.push(make({
          name: d.name, id: d.id, tone: d.unsupported ? 'warn' : 'ok', label: d.unsupported ? 'Unsupported' : 'Available',
          button: d.unsupported ? '' : 'Connect', note: d.unsupported || '',
          onClick: () => connect(e.id, d.id),
        }));
      }
      for (const item of c.catalog) {
        if (detectedIds.has(item.id)) continue;
        if (item.openInWallet) {
          // 0xio: its in-app and desktop transports are not visible before
          // connecting, so an attempt is always offered.
          rows.push(make({ name: item.name, id: item.id, tone: 'mute', label: c.walletBrowser() ? 'Open in Wallet' : 'Not detected yet', button: 'Connect', note: 'Works in the 0xio extension, desktop app and in-app browser.', onClick: () => connect(e.id, item.id) }));
          continue;
        }
        if (isMobile() && item.mobile) rows.push(make({ name: item.name, id: item.id, tone: 'info', label: 'Mobile', button: 'Open in wallet', onClick: () => openInWallet(item.mobile(link)) }));
        else rows.push(make({ name: item.name, id: item.id, tone: 'mute', label: 'Not installed', button: 'Install', href: item.install }));
      }
      return rows;
    }

    async function connect(eco, walletId) {
      try {
        const r = await w.addAddress(eco, walletId);
        if (r.status === 'limit') { render(); return; }
        toast(r.status === 'existing' ? 'That address is already connected. It is now active.' : 'Address verified');
        close();
      } catch (err) {
        if (err && err.code !== 'rejected') toast(err.message || 'Something went wrong. Try again.', true);
      }
    }

    function section(e) {
      const st = w.state().eco[e.id];
      const sec = el(`<section class="space-y-2" aria-label="${esc(e.label)}" data-eco="${esc(e.id)}">
        <div class="flex flex-wrap items-center gap-2"><h3 class="font-semibold">${esc(e.label)}</h3>
          <span class="text-sm text-zinc-400">${w.count(e.id)} of ${w.state().limit} addresses</span>${statusPill(e.id)}</div></section>`);
      if (w.atLimit(e.id)) {
        const box = el(`<div class="limit rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          <p class="font-medium">${esc(w.limitText(e.id))}</p><div class="mt-2 space-y-2 list"></div>
          <div class="mt-2 flex flex-wrap gap-2"><a class="manage ${LINK_BTN}" href="/me?tab=wallets">Manage addresses</a></div></div>`);
        const list = box.querySelector('.list');
        w.savedFor(e.id).forEach((rec) => {
          const r = el(`<div class="flex items-center justify-between gap-2"><span class="font-mono text-xs break-all">${esc(short(rec.address))}</span></div>`);
          const b = el(`<button class="${BTN}">Disconnect</button>`);
          b.addEventListener('click', () => w.disconnectRecord(rec.id).then(() => toast('Address disconnected'), (err) => toast(err.message, true)));
          r.appendChild(b);
          list.appendChild(r);
        });
        box.querySelector('.manage').addEventListener('click', () => close());
        sec.appendChild(box);
        return sec;
      }
      const eb = errorBlock(e.id);
      if (eb) sec.appendChild(eb);
      if (w.status(e.id) === 'detecting' && !st.detected.length) sec.appendChild(el('<p class="text-sm text-zinc-500">Looking for wallets…</p>'));
      walletRows(e).forEach((r) => sec.appendChild(r));
      if (!st.detected.length && w.status(e.id) !== 'detecting') {
        const note = el(`<div class="text-sm text-zinc-400"><p>Questora has not detected ${/^[AEIOU]/i.test(e.label) ? 'an' : 'a'} ${esc(e.label)} wallet in this browser yet. Wallets can take a moment to register. You can install one, open Questora inside a wallet app, or check again.</p>
          <div class="mt-2 flex flex-wrap gap-2"><button class="retry ${BTN}">Retry detection</button></div></div>`);
        if (e.id === 'octra') {
          const cp = el(`<button class="${BTN}">${icon('content_copy', { class: 'w-4 h-4' })}<span>Copy link for the 0xio browser</span></button>`);
          cp.addEventListener('click', () => { const l = QW.deepLinkBase(); if (navigator.clipboard) navigator.clipboard.writeText(l).then(() => toast('Link copied. Open it in the 0xio app browser.'), () => toast('Could not copy the link', true)); });
          note.querySelector('.flex').appendChild(cp);
        }
        note.querySelector('.retry').addEventListener('click', () => { w.detect('retry'); toast('Checked for wallets again'); });
        sec.appendChild(note);
      }
      return sec;
    }

    function render() {
      const order = w.ECOSYSTEMS.slice().sort((a, b) => (a.id === focusedEco ? -1 : b.id === focusedEco ? 1 : 0));
      const scroll = dialog.scrollTop;
      body.replaceChildren(...order.map(section));
      dialog.scrollTop = scroll;
    }
    const off = w.subscribe(render);
    function close() {
      off();
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      openModalRef = null;
      if (opts && opts.onClose) opts.onClose();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    }
    function onKey(ev) {
      if (ev.key === 'Escape') close();
      if (ev.key === 'Tab') {
        const f = Array.from(dialog.querySelectorAll('button:not([disabled]),a[href],input')).filter((n) => n.offsetParent !== null);
        if (!f.length) return;
        const first = f[0]; const last = f[f.length - 1];
        if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      }
    }
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
    overlay.querySelector('.close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    w.detect('modal-open');
    w.reload();
    render();
    overlay.querySelector('.close').focus();
    openModalRef = { close, focus: (eco) => { focusedEco = eco; render(); } };
    return openModalRef;
  }

  // ---- developer diagnostics ----------------------------------------------------
  function debugPanel() {
    const d = W().diagnostics();
    const yn = (v) => (v ? 'yes' : 'no');
    const lines = [
      ['EVM provider detected', yn(d.evmProviderDetected)], ['EVM providers', d.evmProviders.join(', ') || 'none'],
      ['Solana wallets detected', d.solanaWallets.join(', ') || 'none'], ['Sui wallets detected', d.suiWallets.join(', ') || 'none'],
      ['Aptos wallets detected', d.aptosWallets.join(', ') || 'none'], ['Aptos AIP-62 wallets', d.aptosAip62Wallets.join(', ') || 'none'],
      ['Octra provider detected', yn(d.octraProviderDetected)], ['Mobile environment', yn(d.mobileEnvironment)], ['Wallet browser', d.walletBrowser],
      ['Last detection', d.lastDetect ? d.lastDetect.reason + ' at ' + d.lastDetect.at : 'none'],
    ];
    const sessions = d.sessions.map((s) => `${s.ecosystem}: ${s.state}${s.wallet ? ` | ${s.wallet} | network ${s.network || '-'} | chain ${s.chainId || '-'} | active ${s.activeAddress || '-'}` : ''}`);
    const box = el(`<details class="debug rounded-xl border border-zinc-800 p-4 text-sm"><summary class="cursor-pointer font-medium">Wallet diagnostics (developer)</summary>
      <dl class="mt-3 space-y-1">${lines.map(([k, v]) => `<div><dt class="inline text-zinc-500">${esc(k)}: </dt><dd class="inline">${esc(v)}</dd></div>`).join('')}</dl>
      <p class="mt-3 text-zinc-500">Sessions</p><pre class="whitespace-pre-wrap break-all text-xs">${esc(sessions.join('\n'))}</pre>
      <p class="mt-3 text-zinc-500">Provider registration timing (ms)</p><pre class="whitespace-pre-wrap break-all text-xs">${esc(d.registrationTiming.map((t) => t.at + ' ' + t.what).join('\n'))}</pre>
      <p class="mt-3 text-zinc-500">Recent connection errors</p><pre class="whitespace-pre-wrap break-all text-xs">${esc(d.errors.map((x) => x.at + ' ' + x.label + ': ' + x.message).join('\n') || 'none')}</pre>
      <button class="mt-3 ${BTN}">Refresh</button></details>`);
    box.querySelector('button').addEventListener('click', () => { W().detect('debug-refresh'); box.open = false; });
    return box;
  }

  W().openModal = openModal;
  W().mountPanel = mountPanel;
})();
