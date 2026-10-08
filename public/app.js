// Questora SPA. Path-routed (the server catch-all serves index.html for
// every app path), so deep links work everywhere including share links.
(function () {
  'use strict';
  // ---- render orchestrator -------------------------------------------------
  // Every navigation bumps navSeq. A navigation's DOM commit only happens if
  // it is still the newest one, and the previous navigation's in-flight reads
  // are aborted, so a slow earlier fetch can never land on top of a newer page.
  let navSeq = 0;
  let navAbort = null;
  function beginNav() {
    navSeq += 1;
    if (navAbort) { try { navAbort.abort(); } catch (e) { /* already aborted */ } }
    navAbort = new AbortController();
    return { seq: navSeq, signal: navAbort.signal };
  }
  function isCurrent(seq) { return seq === navSeq; }

  function appEl() { return document.getElementById('app'); }

  // Shown once while a route's data loads; replaced in place, never doubled.
  function skeleton(html) {
    return window.QUI.el(html || '<div class="animate-pulse space-y-3"><div class="h-8 w-2/3 rounded bg-surface-container"></div><div class="h-24 rounded-xl bg-surface-container"></div></div>');
  }
  // The shared commit helper views use: mount once, and if the navigation is
  // stale or aborted, leave the DOM untouched. The active context (seq +
  // signal) lives on window.QV.__ctx so views and the api client can read it.
  function mount(node, seq) {
    const current = seq === undefined ? (window.QV && window.QV.__ctx && window.QV.__ctx.seq) : seq;
    if (current !== undefined && !isCurrent(current)) return false;
    const app = appEl();
    const prev = app.firstElementChild;
    // Swap the single child in place; replaceChildren is one synchronous
    // write, so there is no skeleton-then-content double paint.
    app.replaceChildren(node);
    return prev !== node;
  }
  // Error card a view swaps in when its load fails.
  function errorCard(message) {
    return window.QUI.el('<div class="rounded-2xl border border-line bg-surface p-6"><p class="text-content-secondary">' + window.QUI.escapeHtml(message) + '</p></div>');
  }
  // A cancelled request is not a failure: load-path catches return early on it.
  const isAbort = (e) => window.QuestoraAPI.isAbort(e);

  // ---- session store -------------------------------------------------------
  // One shared /users/me read: concurrent callers await the same request, the
  // result is cached, and a write invalidates it. The nav subscribes so the
  // Admin link appears as soon as the role is known, without a rebuild.
  const session = {
    data: null,
    loaded: false,
    inflight: null,
    listeners: new Set(),
    load() {
      if (this.loaded) return Promise.resolve(this.data);
      if (this.inflight) return this.inflight;
      // The session is app-wide, so it must not ride a navigation signal: an
      // aborted read here would be cached as signed out.
      this.inflight = window.QuestoraAPI.api.get('/api/v1/users/me', { signal: null })
        .then((d) => { this.data = d; this.loaded = true; this.emit(); return d; })
        .catch(() => { this.data = null; this.loaded = true; this.emit(); return null; })
        .finally(() => { this.inflight = null; });
      return this.inflight;
    },
    invalidate() {
      this.data = null; this.loaded = false; this.inflight = null;
      window.QuestoraAPI.api.invalidate();
      return this.load();
    },
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    emit() { for (const fn of this.listeners) { try { fn(this.data); } catch (e) { /* listener is best-effort */ } } },
    isAdmin() { return !!(this.data && this.data.user && this.data.user.role === 'admin'); },
  };

  // ---- nav -----------------------------------------------------------------
  // Destinations come from QuestoraNavMenu, one source for the desktop bar,
  // the mobile drawer and the bottom bar, so a control cannot exist in one
  // place and not the other.
  const NAV = window.QuestoraNavMenu.NAV;
  const BOTTOM_NAV = window.QuestoraNavMenu.BOTTOM_NAV;
  const UTILITY_NAV = window.QuestoraNavMenu.UTILITY_NAV;
  const navMatch = (dest, path) => window.QuestoraNavMenu.matchRe(dest).test(path);

  // One floating menu system for every header dropdown. Only one is open at a
  // time; a click anywhere outside closes it.
  const MENUS = new Map();
  function detachMenu(trigger, menu) {
    // Detaching also drops the panel's listeners, and removing the map entry
    // is what lets the SAME trigger open again later. Without it the next
    // click (or the ?menu= boot hook) would only toggle the stale entry shut.
    MENUS.delete(trigger);
    menu.remove();
    trigger.setAttribute('aria-expanded', 'false');
  }
  function closeMenus() {
    for (const [trigger, menu] of Array.from(MENUS)) detachMenu(trigger, menu);
  }
  function closeMenu(trigger) {
    const menu = MENUS.get(trigger);
    if (menu) detachMenu(trigger, menu);
    else trigger.setAttribute('aria-expanded', 'false');
  }
  function togglePop(trigger, panelHtml, onOpen) {
    if (MENUS.has(trigger)) { closeMenu(trigger); return null; }
    closeMenus();
    const menu = window.QUI.el(panelHtml);
    trigger.parentElement.appendChild(menu);
    MENUS.set(trigger, menu);
    trigger.setAttribute('aria-expanded', 'true');
    if (onOpen) onOpen(menu);
    return menu;
  }
  document.addEventListener('click', (e) => {
    // A click inside a menu keeps it open; a click on any menu trigger is
    // handled by that trigger's own listener.
    for (const [trigger, menu] of MENUS) {
      if (menu.contains(e.target) || trigger.contains(e.target)) return;
    }
    closeMenus();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

  // Menu panel chrome, anchored to the header trigger by default, or above it
  // (placement 'top') for the bottom navigation, whose trigger sits at the
  // foot of the screen where a downward menu would fall off it.
  function panel(alignClass, inner, widthClass, placement) {
    const pos = placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2';
    return '<div class="absolute ' + alignClass + ' ' + pos + ' ' + (widthClass || 'w-64') + ' rounded-xl border border-line-strong bg-surface-container shadow-lg z-50 p-1.5">' + inner + '</div>';
  }
  let navBuilt = false;
  function buildNav() {
    const desk = document.getElementById('desktop-nav');
    desk.replaceChildren();
    for (const item of NAV) {
      const a = document.createElement('a');
      a.href = item.path; a.dataset.path = item.path;
      a.className = 'px-3 py-2 rounded-lg font-medium inline-flex items-center gap-1.5';
      a.innerHTML = window.QUI.icon(item.icon) + '<span>' + window.QUI.escapeHtml(item.label) + '</span>';
      desk.appendChild(a);
    }
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.id = 'create-btn';
    createBtn.dataset.path = '/create';
    createBtn.setAttribute('aria-haspopup', 'menu');
    createBtn.setAttribute('aria-expanded', 'false');
    createBtn.className = 'px-3 py-2 rounded-lg font-medium inline-flex items-center gap-1.5 text-content-secondary hover:text-content-primary';
    createBtn.innerHTML = window.QUI.icon('add') + '<span>Create</span>' + window.QUI.icon('chevron_down', { class: 'w-4 h-4' });
    createBtn.addEventListener('click', (e) => { e.stopPropagation(); openCreateMenu(createBtn); });
    const wrap = document.createElement('span');
    wrap.className = 'relative inline-flex';
    wrap.appendChild(createBtn);
    desk.appendChild(wrap);
    navBuilt = true;
  }
  function paintNav(path) {
    for (const el of document.querySelectorAll('#desktop-nav a')) {
      const item = NAV.find((i) => i.path === el.dataset.path);
      const active = item && navMatch(item, path);
      el.className = 'px-3 py-2 rounded-lg font-medium inline-flex items-center gap-1.5 ' + (active ? 'text-accent-contrast bg-accent/20' : 'text-content-secondary hover:text-content-primary');
    }
    const createBtn = document.getElementById('create-btn');
    if (createBtn) {
      const active = /^\/create/.test(path) || /^\/dashboard\//.test(path);
      createBtn.className = 'px-3 py-2 rounded-lg font-medium inline-flex items-center gap-1.5 ' + (active ? 'text-accent-contrast bg-accent/20' : 'text-content-secondary hover:text-content-primary');
    }
  }
  function renderNav(path) {
    if (!navBuilt) buildNav();
    paintNav(path);
    paintBottomNav(path);
  }

  // ---- Create menu ---------------------------------------------------------
  // Project is always available. Campaign, Quest and Task need a project the
  // caller can manage, so they are only rendered once GET /api/v1/projects
  // reports one, and each opens the real create surface in that dashboard.
  let manageProjects = null;
  let manageProjectsRequest = null;
  function loadManageProjects() {
    if (manageProjects) return Promise.resolve(manageProjects);
    if (manageProjectsRequest) return manageProjectsRequest;
    manageProjectsRequest = window.QuestoraAPI.api.get('/api/v1/projects')
      .then((d) => {
        // Only projects the caller may actually create in: Creator or Admin.
        // A Moderator is an active member but cannot manage content, so an
        // option would only lead to a 403.
        manageProjects = (d.projects || []).filter((p) => p.viewer_role === 'creator' || p.viewer_role === 'admin');
        return manageProjects;
      })
      .catch(() => { manageProjects = []; return manageProjects; })
      .finally(() => { manageProjectsRequest = null; });
    return manageProjectsRequest;
  }
  const CREATE_KEY_ICON = { project: 'folder', campaign: 'campaign', quest: 'checklist', task: 'task_alt' };
  function openCreateMenu(trigger, placement, alignClass) {
    const menu = togglePop(trigger, panel(alignClass || 'left-0', '<p class="px-3 py-2 text-xs text-content-secondary">Create</p><div class="create-list"></div>', 'w-72', placement));
    if (!menu) return;
    const list = menu.querySelector('.create-list');
    const add = (label, href, hint, iconName) => {
      const b = window.QUI.el('<button type="button" class="w-full text-left px-3 py-2.5 rounded-lg hover:bg-surface-container-high inline-flex items-center gap-3 text-content-secondary"><span class="min-w-0"><span class="block text-sm text-content-primary">' + window.QUI.escapeHtml(label) + '</span>' + (hint ? '<span class="block text-xs text-content-secondary">' + window.QUI.escapeHtml(hint) + '</span>' : '') + '</span></button>');
      b.insertAdjacentHTML('afterbegin', window.QUI.icon(iconName || 'add'));
      b.addEventListener('click', () => { closeMenu(trigger); nav(href); });
      list.appendChild(b);
    };
    const model = window.QuestoraNavMenu.createMenuItems([]);
    add(model.project.label, model.project.href, model.project.hint, 'folder');
    const loading = window.QUI.el('<p class="px-3 py-2 text-xs text-content-tertiary">Loading your projects…</p>');
    list.appendChild(loading);
    loadManageProjects().then((projects) => {
      loading.remove();
      if (!menu.isConnected) return;
      const m = window.QuestoraNavMenu.createMenuItems(projects);
      if (m.hint) { list.appendChild(window.QUI.el('<p class="px-3 pt-1 pb-2 text-xs text-content-tertiary">' + window.QUI.escapeHtml(m.hint) + '</p>')); return; }
      if (!m.needsPicker) {
        for (const it of m.items) add(it.label, it.href, it.hint, CREATE_KEY_ICON[it.key]);
        return;
      }
      renderPicker(m.projects);
    });

    // With several manageable projects, choosing one swaps the menu to that
    // project's three create actions, with a way back.
    function renderPicker(projects) {
      list.replaceChildren();
      list.appendChild(window.QUI.el('<p class="px-3 pt-1 pb-1 text-xs text-content-secondary">Choose a project</p>'));
      for (const p of projects) {
        const b = window.QUI.el('<button type="button" class="w-full text-left px-3 py-2.5 rounded-lg hover:bg-surface-container-high inline-flex items-center gap-3 text-content-secondary">' + window.QUI.icon('folder') + '<span class="block text-sm text-content-primary">' + window.QUI.escapeHtml(p.name) + '</span></button>');
        b.addEventListener('click', () => {
          list.replaceChildren();
          const back = window.QUI.el('<button type="button" class="w-full text-left text-xs px-3 py-2 rounded-lg text-accent-text hover:bg-surface-container-high inline-flex items-center gap-2">' + window.QUI.icon('arrow_back', { class: 'w-4 h-4' }) + '<span>Back</span></button>');
          back.addEventListener('click', () => renderPicker(projects));
          list.appendChild(back);
          list.appendChild(window.QUI.el('<p class="px-3 py-2 text-xs text-content-secondary">' + window.QUI.escapeHtml(p.name) + '</p>'));
          for (const a of window.QuestoraNavMenu.projectActions(p)) add(a.label, a.href, null, CREATE_KEY_ICON[a.key]);
        });
        list.appendChild(b);
      }
    }
  }

  // ---- Account menu --------------------------------------------------------
  function openAccountMenu(trigger) {
    togglePop(trigger, panel('right-0', '<div class="account-list"></div>'), (menu) => {
      const list = menu.querySelector('.account-list');
      const put = (label, run, iconName) => {
        const b = window.QUI.el('<button type="button" class="w-full text-left text-sm px-3 py-2.5 rounded-lg hover:bg-surface-container-high inline-flex items-center gap-3 text-content-secondary">' + window.QUI.icon(iconName) + '<span class="text-content-primary">' + window.QUI.escapeHtml(label) + '</span></button>');
        b.addEventListener('click', () => { closeMenu(trigger); run(); });
        list.appendChild(b);
      };
      put('Profile', () => nav('/me'), 'person');
      put('Account Settings', () => nav('/settings'), 'settings');
      put('Connected Wallets', () => nav('/me?tab=wallets'), 'account_balance_wallet');
      put('My Projects', () => nav('/my-projects'), 'folder');
      if (session.isAdmin()) put('Admin', () => nav('/admin'), 'lock');
      if (window.usernode && window.usernode.isNative) {
        list.appendChild(window.QUI.el('<div class="my-1 border-t border-line"></div>'));
        put('Log out', () => { Promise.resolve(window.usernode.logout()).catch(() => window.QUI.toast('Could not log out', true)); }, 'logout');
      }
    });
  }

  // ---- Theme menu ----------------------------------------------------------
  function themeIcon() {
    const mode = window.QuestoraTheme.mode();
    if (mode === 'system') return window.QUI.icon('brightness_auto');
    return document.documentElement.classList.contains('dark') ? window.QUI.icon('light_mode') : window.QUI.icon('dark_mode');
  }
  function themeLabel() {
    const mode = window.QuestoraTheme.mode();
    if (mode === 'system') return 'Theme';
    return document.documentElement.classList.contains('dark') ? 'Switch to light mode' : 'Switch to dark mode';
  }
  function renderThemeButtons() {
    const btn = document.getElementById('theme-btn');
    if (btn) { btn.innerHTML = themeIcon(); window.QUI.setTooltip(btn, themeLabel()); }
    // The drawer Theme row keeps its visible label: only the icon slot is
    // repainted, unlike the desktop button which is icon-only.
    const drawerIcon = document.getElementById('drawer-theme-icon');
    if (drawerIcon) { drawerIcon.innerHTML = themeIcon(); }
    const dbtn = document.getElementById('drawer-theme-btn');
    if (dbtn) window.QUI.setTooltip(dbtn, themeLabel());
  }
  const THEME_OPTIONS = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']];
  // One renderer for the Light/Dark/System rows, shared by the desktop popover
  // and the drawer's inline expander so the two cannot drift.
  function themeOptionButtons(onPick) {
    const frag = document.createDocumentFragment();
    const current = window.QuestoraTheme.mode();
    for (const [mode, label] of THEME_OPTIONS) {
      const on = current === mode;
      const b = window.QUI.el('<button type="button" data-mode="' + mode + '" class="w-full text-left text-sm px-3 py-2.5 rounded-lg flex items-center justify-between ' + (on ? 'bg-accent/20 text-accent-contrast' : 'text-content-primary hover:bg-surface-container-high') + '"><span>' + label + '</span>' + (on ? '<span class="text-accent-text">' + window.QUI.icon('check', { class: 'w-4 h-4' }) + '</span>' : '') + '</button>');
      b.addEventListener('click', () => onPick(mode));
      frag.appendChild(b);
    }
    return frag;
  }
  function openThemeMenu(trigger) {
    togglePop(trigger, panel('right-0', '<div class="theme-list"></div>'), (menu) => {
      menu.querySelector('.theme-list').appendChild(themeOptionButtons((mode) => { closeMenu(trigger); chooseTheme(mode); }));
    });
  }
  function chooseTheme(mode) {
    window.QuestoraTheme.set(mode);
    renderThemeButtons();
    // Best-effort cross-device sync for signed-in users; the local pick stays
    // the source of truth for instant paint and this never blocks it.
    if (session.data && session.data.user) {
      window.QuestoraAPI.api.patch('/api/v1/users/me', { settings: { theme: mode } }).catch(() => {});
    }
  }

  // ---- Notifications -------------------------------------------------------
  const notifCache = { data: null };
  function invalidateNotifs() { notifCache.data = null; }
  function markBadge(unread) {
    for (const id of ['notif-badge', 'notif-badge-mobile']) {
      const b = document.getElementById(id);
      if (!b) continue;
      if (unread > 0) { b.textContent = unread > 9 ? '9+' : String(unread); b.classList.remove('hidden'); }
      else b.classList.add('hidden');
    }
  }
  async function pollNotifs() {
    try {
      const data = await window.QuestoraAPI.api.get('/api/v1/notifications');
      notifCache.data = data;
      markBadge(data.unread);
    } catch (e) { /* signed-out or offline: badge stays hidden */ }
  }
  function openNotifPanel(trigger) {
    pollNotifs();
    togglePop(trigger, panel('right-0', '<div class="notif-body"></div>', 'w-80 max-w-[calc(100vw-1rem)]'), (menu) => renderNotifBody(menu.querySelector('.notif-body'), trigger));
  }
  async function renderNotifBody(holder, trigger) {
    holder.replaceChildren(window.QUI.el('<p class="px-3 py-4 text-sm text-content-secondary animate-pulse">Loading notifications…</p>'));
    let data;
    try {
      data = await window.QuestoraAPI.api.get('/api/v1/notifications');
      notifCache.data = data;
      markBadge(data.unread);
    } catch (err) {
      if (isAbort(err)) return;
      holder.replaceChildren(window.QUI.el('<div class="px-3 py-4"><p class="text-sm text-error">' + window.QUI.escapeHtml(err.message) + '</p><button type="button" class="retry mt-2 text-sm text-accent-text font-medium">Try again</button></div>'));
      holder.querySelector('.retry').addEventListener('click', () => renderNotifBody(holder, trigger));
      appendNotifFooter(holder, trigger);
      return;
    }
    if (!data.notifications.length) {
      holder.replaceChildren(window.QUI.el('<div class="px-3 py-6 text-center"><p class="text-sm text-content-secondary">No notifications yet.</p><p class="text-xs text-content-tertiary mt-1">Complete quests and follow campaigns to hear about it here.</p></div>'));
    } else {
      const list = window.QUI.el('<div class="max-h-80 overflow-y-auto space-y-1"></div>');
      for (const n of data.notifications) {
        const row = window.QUI.notificationRow(n);
        row.addEventListener('click', async () => {
          closeMenu(trigger);
          try { await window.QuestoraAPI.api.post('/api/v1/notifications/' + n.id + '/read', {}); } catch (e) { /* best-effort */ }
          if (n.link) nav(n.link);
          pollNotifs();
        });
        list.appendChild(row);
      }
      holder.replaceChildren(list);
    }
    appendNotifFooter(holder, trigger);
  }
  function appendNotifFooter(holder, trigger) {
    const foot = window.QUI.el('<div class="mt-1 border-t border-line pt-1 flex items-center justify-between gap-2"><a href="/notifications" class="text-xs text-accent-text px-3 py-2">View all</a><button type="button" class="mark-all text-xs text-content-secondary px-3 py-2">Mark all read</button></div>');
    foot.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); closeMenu(trigger); nav('/notifications'); });
    foot.querySelector('.mark-all').addEventListener('click', async () => {
      try { await window.QuestoraAPI.api.post('/api/v1/notifications/read', {}); } catch (e) { /* best-effort */ }
      invalidateNotifs();
      renderNotifBody(holder, trigger);
    });
    holder.appendChild(foot);
  }

  // ---- Wallet control ------------------------------------------------------
  function walletShort(addr) { return addr && addr.length > 18 ? addr.slice(0, 8) + '…' + addr.slice(-6) : (addr || ''); }
  function walletState() {
    const W = window.QuestoraWallets;
    if (!W || !W.state) return { connected: [] };
    const S = W.state();
    const connected = [];
    for (const e of (W.ECOSYSTEMS || [])) {
      const s = S.eco[e.id] && S.eco[e.id].session;
      if (s && s.accounts && s.accounts.length) connected.push({ eco: e, address: s.accounts[0], network: s.network });
    }
    return { connected };
  }
  function renderWalletButton() {
    const label = document.getElementById('wallet-label');
    const btn = document.getElementById('wallet-btn');
    if (!label || !btn) return;
    const iconSlot = document.getElementById('wallet-icon');
    if (iconSlot && !iconSlot.firstChild) iconSlot.innerHTML = window.QUI.icon('account_balance_wallet');
    // Its visible label is the accessible name (it changes with state), so bind
    // the tooltip without forcing a fixed aria-label.
    window.QUI.tooltip(btn);
    const { connected } = walletState();
    if (!connected.length) { label.textContent = 'Connect wallet'; window.QUI.setTooltip(btn, 'Connect wallet'); return; }
    const first = connected[0];
    label.textContent = walletShort(first.address) + (first.network ? ' · ' + first.network : '');
    // The visible label is shortened; the tooltip carries the full address.
    window.QUI.setTooltip(btn, first.address);
  }
  function openWalletMenu(trigger) {
    const { connected } = walletState();
    if (!connected.length) {
      if (window.QuestoraWallets && window.QuestoraWallets.openModal) window.QuestoraWallets.openModal();
      return;
    }
    togglePop(trigger, panel('right-0', '<div class="wallet-list"></div>', 'w-72'), (menu) => {
      const list = menu.querySelector('.wallet-list');
      list.appendChild(window.QUI.el('<p class="px-3 py-2 text-xs text-content-secondary">Connected</p>'));
      connected.forEach((c, i) => {
        const active = i === 0;
        const b = window.QUI.el('<button type="button" class="w-full text-left px-3 py-2.5 rounded-lg ' + (active ? 'bg-accent/20 hover:bg-accent/30' : 'hover:bg-surface-container-high') + '"><span class="block text-xs text-content-secondary">' + window.QUI.escapeHtml(c.eco.label) + (c.network ? ' · ' + window.QUI.escapeHtml(c.network) : '') + '</span><span class="block font-mono text-sm text-content-primary">' + window.QUI.escapeHtml(walletShort(c.address)) + '</span></button>');
        b.addEventListener('click', async () => {
          closeMenu(trigger);
          const rec = window.QuestoraWallets.findSaved(c.eco.id, c.address);
          if (rec && !rec.is_active && window.QuestoraWallets.activate) {
            try { await window.QuestoraWallets.activate(rec.id); window.QUI.toast('Active address updated'); } catch (err) { window.QUI.toast(err.message || 'Could not switch address', true); }
          }
        });
        list.appendChild(b);
      });
      const manage = window.QUI.el('<a href="/me?tab=wallets" class="block text-sm px-3 py-2.5 mt-1 border-t border-line text-accent-text">Manage addresses</a>');
      manage.addEventListener('click', (e) => { e.preventDefault(); closeMenu(trigger); nav('/me?tab=wallets'); });
      list.appendChild(manage);
    });
  }

  // ---- router --------------------------------------------------------------
  const ROUTES = [
    [/^\/$/, (V) => V.viewDiscover()],
    [/^\/campaigns$/, (V, m, params) => V.viewCampaigns(params)],
    [/^\/projects$/, (V, m, params) => V.viewProjects(params)],
    [/^\/create$/, (V) => V.viewCreate()],
    [/^\/settings$/, (V) => V.viewSettings()],
    [/^\/my-projects$/, (V) => V.viewMyProjects()],
  ];

  async function routeFor(path, params, ctx) {
    const V = window.QV;
    for (const [re, fn] of ROUTES) { if (re.test(path)) return fn(V, null, params, ctx); }
    if (path === '/me') {
      const meData = await V.loadMe();
      return V.viewProfile(meData ? meData.user.username : 'me', params, ctx);
    }
    let m;
    if ((m = path.match(/^\/dashboard\/projects\/([^/]+)(?:\/(.*))?$/))) {
      return V.viewDashboard(decodeURIComponent(m[1]), m[2] || '', params, ctx);
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/campaigns\/([^/]+)\/quests\/([^/]+)\/leaderboard$/))) {
      return V.viewScopedLeaderboard({ projectSlug: decodeURIComponent(m[1]), campaignSlug: decodeURIComponent(m[2]), questSlug: decodeURIComponent(m[3]), metric: params.get('metric') || 'xp' }, ctx);
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/campaigns\/([^/]+)\/quests\/([^/]+)$/))) {
      return V.viewQuestDetail(decodeURIComponent(m[1]), decodeURIComponent(m[2]), decodeURIComponent(m[3]), ctx);
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/campaigns\/([^/]+)\/leaderboard$/))) {
      return V.viewScopedLeaderboard({ projectSlug: decodeURIComponent(m[1]), campaignSlug: decodeURIComponent(m[2]), metric: params.get('metric') || 'xp' }, ctx);
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/campaigns\/([^/]+)$/))) {
      return V.viewCampaignDetail(decodeURIComponent(m[1]), decodeURIComponent(m[2]), ctx);
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/leaderboard$/))) {
      return V.viewScopedLeaderboard({ projectSlug: decodeURIComponent(m[1]), metric: params.get('metric') || 'xp' }, ctx);
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/quests$/))) {
      return V.viewProjectQuests(decodeURIComponent(m[1]), params, ctx);
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/campaigns$/))) {
      return V.viewProjectCampaigns(decodeURIComponent(m[1]), params, ctx);
    }
    if ((m = path.match(/^\/projects\/([^/]+)$/))) {
      return V.viewProjectOverview(decodeURIComponent(m[1]), params, null, ctx);
    }
    if ((m = path.match(/^\/quest\/([^/]+)$/))) return V.viewQuest(decodeURIComponent(m[1]), ctx);
    // Legacy alias: /quests/:id is the same screen under the canonical
    // /quest/:id URL. Rewrite the address so shared links converge.
    if ((m = path.match(/^\/quests\/([^/]+)$/))) {
      window.history.replaceState({}, '', '/quest/' + m[1]);
      return V.viewQuest(decodeURIComponent(m[1]), ctx);
    }
    if ((m = path.match(/^\/campaigns\/([^/]+)$/))) {
      const s = await V.resolveCampaignPath(decodeURIComponent(m[1]));
      return V.viewCampaignDetail(s.projectSlug, decodeURIComponent(m[1]), ctx);
    }
    if ((m = path.match(/^\/p\/([^/]+)$/))) {
      return V.viewProjectOverview(decodeURIComponent(m[1]), params, params.get('tab'), ctx);
    }
    if ((m = path.match(/^\/u\/([^/]+)$/))) return V.viewProfile(decodeURIComponent(m[1]), params, ctx);
    if ((m = path.match(/^\/credentials\/([0-9a-fA-F-]{36})$/))) return V.viewCredential(m[1], ctx);
    if (path === '/join') return V.viewJoin(params, ctx);
    if (path === '/search') return V.viewSearch(params, ctx);
    if (path === '/notifications') return V.viewNotifications(ctx);
    if (path === '/admin') return V.viewAdmin(ctx);
    return V.viewNotFound(ctx);
  }

  let lastMenuKey = null;
  async function router() {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const ctx = beginNav();
    if (window.QV) window.QV.__ctx = ctx;
    renderNav(path);
    // The ?menu= boot hook opens a control once per URL. Without the guard, a
    // dismissed drawer's history.back() would land on the same ?menu= URL and
    // immediately reopen it.
    const menuName = params.get('menu');
    const menuKey = menuName ? window.location.href : null;
    if (menuName && lastMenuKey !== menuKey) openMenuByName(menuName);
    lastMenuKey = menuKey;
    // Warm the session without blocking the first paint; the nav repaints
    // when it resolves.
    session.load();
    try {
      await routeFor(path, params, ctx);
    } catch (err) {
      if (!isCurrent(ctx.seq)) return;
      if (isAbort(err)) return;
      appEl().replaceChildren(errorCard(err.message || 'Something went wrong'));
      console.error(err);
    }
  }

  // ---- header control wiring -------------------------------------------------
  function bindTrigger(id, fn) {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
    return !!b;
  }
  bindTrigger('theme-btn', openThemeMenu);
  bindTrigger('notif-btn', openNotifPanel);
  bindTrigger('notif-btn-mobile', openNotifPanel);
  bindTrigger('avatar-btn', openAccountMenu);
  bindTrigger('avatar-btn-mobile', openAccountMenu);
  bindTrigger('wallet-btn', openWalletMenu);

  // Every icon-only header control gets a tooltip and an accessible name. Text
  // labels stay on the mobile drawer and bottom bar, so a tooltip is never the
  // only explanation of an icon on touch.
  for (const [id, text] of [['theme-btn', 'Theme'], ['notif-btn', 'Notifications'], ['notif-btn-mobile', 'Notifications'], ['avatar-btn', 'Profile'], ['avatar-btn-mobile', 'Profile'], ['menu-btn', 'Open navigation']]) {
    const node = document.getElementById(id);
    if (!node) continue;
    if (!node.getAttribute('aria-label')) node.setAttribute('aria-label', text);
    window.QUI.tooltip(node, node.getAttribute('aria-label') || text);
  }

  // The mobile hamburger opens a proper M3 navigation drawer, not a squeezed
  // dropdown. It slides in from the left over a dimmed backdrop, closes on
  // item choice, backdrop tap, Escape and browser back, and highlights the
  // current destination. Every item comes from the shared nav lists.
  let drawerEl = null;
  // Returns true when it dismissed a pushed history entry (i.e. it started a
  // history.back()). A caller that is about to push a NEW location (nav) must
  // wait for that back to land first, or the pending back would unwind the new
  // entry and leave the visitor on the screen they came from.
  function closeDrawer(opts) {
    if (!drawerEl) return false;
    const node = drawerEl;
    drawerEl = null;
    node.classList.add('opacity-0');
    const panelEl = node.querySelector('.drawer-panel');
    if (panelEl) panelEl.classList.add('-translate-x-full');
    setTimeout(() => node.remove(), 200);
    let wentBack = false;
    if (drawerPushed) {
      drawerPushed = false;
      if (window.history.state && window.history.state.__drawer) { window.history.back(); wentBack = true; }
    }
    const menuBtn = document.getElementById('menu-btn');
    if (menuBtn) { menuBtn.setAttribute('aria-expanded', 'false'); if (!(opts && opts.silent)) { try { menuBtn.focus(); } catch (e) { /* not focusable */ } } }
    return wentBack;
  }
  let drawerPushed = false;
  // Leave the drawer and go to `href`: on a phone the drawer covered the
  // screen, so we dismiss it and come back BEFORE navigating.
  function drawerGo(href) {
    const wentBack = closeDrawer({ silent: true });
    if (wentBack) window.addEventListener('popstate', () => nav(href), { once: true });
    else nav(href);
  }
  function openDrawer() {
    if (drawerEl) return;
    const path = window.location.pathname;
    const row = (dest, iconName) => {
      const on = navMatch(dest, path);
      const cls = 'flex items-center gap-3 px-3 py-3 min-h-[48px] rounded-lg text-sm ' + (on ? 'bg-accent/20 text-accent-contrast' : 'text-content-primary hover:bg-surface-container-high');
      return '<a href="' + dest.path + '" data-path="' + dest.path + '" data-match="' + dest.match + '" data-drawer-link="1" class="' + cls + '">' + window.QUI.icon(iconName || dest.icon) + '<span>' + window.QUI.escapeHtml(dest.label) + '</span></a>';
    };
    const canLogout = !!(window.usernode && window.usernode.isNative);
    const node = window.QUI.el('<div class="fixed inset-0 z-50 transition-opacity duration-200" data-drawer>' +
      '<div class="drawer-backdrop absolute inset-0 bg-black/60" data-drawer-backdrop></div>' +
      '<div role="dialog" aria-modal="true" aria-label="Navigation" class="drawer-panel absolute left-0 top-0 h-full w-72 max-w-[85vw] -translate-x-full transition-transform duration-200 bg-background border-r border-line p-3 flex flex-col gap-1 overflow-y-auto" style="padding-bottom:calc(0.75rem + var(--un-safe-inset-bottom, env(safe-area-inset-bottom, 0px)))">' +
      '<div class="flex items-center justify-between px-2 py-1 mb-1"><a href="/" data-drawer-link="1" class="font-bold text-lg text-accent-text">Questora</a><button type="button" class="drawer-close ' + window.QUI.BTN_ICON + '" aria-label="Close navigation">' + window.QUI.icon('close') + '</button></div>' +
      NAV.map((d) => row(d, d.icon)).join('') +
      '<button type="button" data-drawer-create="1" class="flex items-center gap-3 px-3 py-3 min-h-[48px] rounded-lg text-sm text-content-primary hover:bg-surface-container-high text-left">' + window.QUI.icon('add') + '<span>Create</span></button>' +
      '<div class="my-2 border-t border-line"></div>' +
      UTILITY_NAV.map((d) => row(d, d.icon)).join('') +
      '<button type="button" id="drawer-theme-btn" data-drawer-theme="1" class="flex items-center gap-3 px-3 py-3 min-h-[48px] rounded-lg text-sm text-content-primary hover:bg-surface-container-high text-left"><span id="drawer-theme-icon" class="inline-flex">' + window.QUI.icon('brightness_auto') + '</span><span>Theme</span></button>' +
      '<div id="drawer-theme-options" class="pl-9 pr-1 space-y-0.5"></div>' +
      (canLogout ? '<div class="my-2 border-t border-line"></div><button type="button" data-drawer-logout="1" class="flex items-center gap-3 px-3 py-3 min-h-[48px] rounded-lg text-sm text-content-primary hover:bg-surface-container-high text-left">' + window.QUI.icon('logout') + '<span>Log out</span></button>' : '') +
      '</div></div>');
    document.body.appendChild(node);
    drawerEl = node;
    requestAnimationFrame(() => {
      node.classList.remove('opacity-0');
      const panelEl = node.querySelector('.drawer-panel');
      if (panelEl) panelEl.classList.remove('-translate-x-full');
    });
    const setStatus = document.getElementById('menu-btn');
    if (setStatus) setStatus.setAttribute('aria-expanded', 'true');
    renderThemeButtons();
    node.querySelector('.drawer-close').addEventListener('click', closeDrawer);
    node.querySelector('[data-drawer-backdrop]').addEventListener('click', closeDrawer);
    for (const a of node.querySelectorAll('a[data-drawer-link]')) {
      a.addEventListener('click', (e) => { e.preventDefault(); drawerGo(a.getAttribute('href')); });
    }
    const createBtn = node.querySelector('[data-drawer-create]');
    if (createBtn) createBtn.addEventListener('click', () => drawerGo('/create'));
    // The drawer Theme row expands its options inline. A popover anchored to
    // the row would open below the full-height drawer panel, off-screen.
    const themeBtn = node.querySelector('[data-drawer-theme]');
    const themeSlot = node.querySelector('#drawer-theme-options');
    if (themeBtn && themeSlot) themeBtn.addEventListener('click', () => {
      if (themeSlot.childElementCount) { themeSlot.replaceChildren(); themeBtn.setAttribute('aria-expanded', 'false'); return; }
      themeSlot.appendChild(themeOptionButtons((mode) => { chooseTheme(mode); themeSlot.replaceChildren(); themeBtn.setAttribute('aria-expanded', 'false'); }));
      themeBtn.setAttribute('aria-expanded', 'true');
    });
    const logoutBtn = node.querySelector('[data-drawer-logout]');
    if (logoutBtn) logoutBtn.addEventListener('click', () => { closeDrawer(); Promise.resolve(window.usernode.logout()).catch(() => window.QUI.toast('Could not log out', true)); });
    if (!drawerPushed) { drawerPushed = true; try { window.history.pushState({ __drawer: 1 }, '', window.location.href); } catch (e) { drawerPushed = false; } }
    try { const first = node.querySelector('.drawer-close'); if (first) first.focus(); } catch (e) { /* not focusable */ }
  }
  // Exposed so the ?menu=mobile boot hook and the dapp.json test can reach it.
  function openMobileMenu() { openDrawer(); }
  bindTrigger('menu-btn', openMobileMenu);

  // ---- Mobile bottom navigation --------------------------------------------
  // A fixed bar on phones with the four high-frequency destinations. Create
  // opens the same Create menu as the desktop button; active state uses the
  // same match rules as the desktop bar, so the three surfaces cannot drift.
  let bottomNavBuilt = false;
  function buildBottomNav() {
    const bar = document.getElementById('bottom-nav');
    if (!bar) return;
    bar.replaceChildren();
    for (const dest of BOTTOM_NAV) {
      const isCreate = dest.path === '/create';
      const tag = isCreate ? 'button' : 'a';
      const node = document.createElement(tag);
      if (isCreate) { node.type = 'button'; node.setAttribute('aria-haspopup', 'menu'); node.setAttribute('aria-expanded', 'false'); }
      else node.href = dest.path;
      node.dataset.path = dest.path;
      node.dataset.match = dest.match;
      node.className = 'bottomnav-item flex flex-col items-center justify-center gap-0.5 flex-1 min-h-[56px] px-1 text-[11px] ' + (isCreate ? '' : '');
      node.innerHTML = window.QUI.icon(dest.icon) + '<span class="leading-none">' + window.QUI.escapeHtml(dest.label) + '</span>';
      // Centred above the bar so a w-72 panel stays inside a narrow phone.
      if (isCreate) node.addEventListener('click', (e) => { e.stopPropagation(); openCreateMenu(node, 'top', 'left-1/2 -translate-x-1/2'); });
      bar.appendChild(node);
    }
    bottomNavBuilt = true;
  }
  function paintBottomNav(path) {
    if (!bottomNavBuilt) buildBottomNav();
    for (const el of document.querySelectorAll('#bottom-nav [data-path]')) {
      const dest = BOTTOM_NAV.find((d) => d.path === el.dataset.path);
      const active = dest && navMatch(dest, path);
      el.classList.toggle('text-accent-text', !!active);
      el.classList.toggle('text-content-secondary', !active);
      if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    }
  }

  // A URL can open one header menu at boot (?menu=account|theme|create|
  // notifications|wallet|mobile). It is a pure UI state link: no writes, the
  // same in every environment, and it makes the menu reachable for tests and
  // before/after shots.
  function openMenuByName(name) {
    const mobile = window.matchMedia('(max-width: 767px)').matches;
    const map = {
      account: mobile ? ['avatar-btn-mobile', openAccountMenu] : ['avatar-btn', openAccountMenu],
      notifications: mobile ? ['notif-btn-mobile', openNotifPanel] : ['notif-btn', openNotifPanel],
      theme: ['theme-btn', openThemeMenu],
      create: ['create-btn', openCreateMenu],
      wallet: ['wallet-btn', openWalletMenu],
      mobile: ['menu-btn', openMobileMenu],
    };
    const entry = map[name];
    if (!entry) return;
    const trigger = document.getElementById(entry[0]);
    if (trigger) entry[1](trigger);
  }

  // The avatar shows the signed-in user's initials, and the wallet control
  // reflects live wallet sessions.
  let themeAdopted = false;
  function renderAvatar() {
    const u = session.data && session.data.user;
    const initials = u ? String(u.display_name || u.username || '?').slice(0, 2).toUpperCase() : '?';
    const avatarUrl = u && u.avatar_url ? String(u.avatar_url) : '';
    const initialsEl = document.getElementById('avatar-initials');
    if (initialsEl) {
      if (avatarUrl) initialsEl.innerHTML = '<img src="' + window.QUI.escapeHtml(avatarUrl) + '" alt="" class="w-8 h-8 rounded-full object-cover">';
      else initialsEl.textContent = initials;
    }
    const mobileEl = document.getElementById('avatar-btn-mobile');
    if (mobileEl) mobileEl.textContent = initials;
    renderWalletButton();
    // Adopt a synced theme once, only when this device has no local pick, so
    // paint has already happened and nothing is blocked.
    if (!themeAdopted && session.data) {
      themeAdopted = true;
      const s = session.data.settings;
      if (s && (s.theme === 'light' || s.theme === 'dark') && window.QuestoraTheme.mode() === 'system') {
        window.QuestoraTheme.set(s.theme);
        renderThemeButtons();
      }
    }
  }
  session.subscribe(renderAvatar);
  if (window.QuestoraWallets && window.QuestoraWallets.subscribe) window.QuestoraWallets.subscribe(renderWalletButton);
  renderAvatar();
  renderThemeButtons();

  function nav(path) {
    window.history.pushState({}, '', path);
    router();
  }

  window.addEventListener('popstate', () => { closeDrawer(); router(); });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('#') || a.target === '_blank') return;
    e.preventDefault();
    nav(href);
  });

  // Escape closes the drawer before it closes any header menu.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerEl) { e.stopPropagation(); closeDrawer(); } }, true);

  // Views call this after a write to refresh the session-backed nav.
  window.QuestoraNav = { go: nav, refresh: router, invalidateSession: () => session.invalidate(), themeChanged: renderThemeButtons };

  window.QV = window.QV || {};
  window.QV.Render = { skeleton, mount, errorCard };
  window.QV.session = session;

  pollNotifs();
  router();
  setInterval(pollNotifs, 30000);
})();
