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
    return window.QUI.el(html || '<div class="animate-pulse space-y-3"><div class="h-8 w-2/3 rounded bg-zinc-900"></div><div class="h-24 rounded-xl bg-zinc-900"></div></div>');
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
    return window.QUI.el('<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6"><p class="text-zinc-300">' + window.QUI.escapeHtml(message) + '</p></div>');
  }

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
      this.inflight = window.QuestoraAPI.api.get('/api/v1/users/me')
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
  // One NAV constant drives the desktop bar and the mobile drawer, so a
  // control cannot exist in one place and not the other.
  const NAV = [
    { label: 'Projects', path: '/projects', match: /^\/projects/ },
    { label: 'Campaigns', path: '/campaigns', match: /^\/campaigns/ },
  ];
  const CREATE_ICON = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>';
  const CHEVRON = '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';

  // One floating menu system for every header dropdown. Only one is open at a
  // time; a click anywhere outside closes it.
  const MENUS = new Map();
  function closeMenus() {
    for (const [trigger, menu] of MENUS) {
      menu.remove();
      trigger.setAttribute('aria-expanded', 'false');
    }
  }
  function closeMenu(trigger) {
    const menu = MENUS.get(trigger);
    if (menu) menu.remove();
    trigger.setAttribute('aria-expanded', 'false');
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

  // Menu panel chrome, anchored under the header trigger.
  function panel(alignClass, inner) {
    return '<div class="absolute ' + alignClass + ' top-full mt-2 w-64 rounded-xl border border-zinc-700 bg-zinc-900 shadow-lg z-50 p-1.5">' + inner + '</div>';
  }
  let navBuilt = false;
  function buildNav() {
    const desk = document.getElementById('desktop-nav');
    desk.replaceChildren();
    for (const item of NAV) {
      const a = document.createElement('a');
      a.href = item.path; a.textContent = item.label; a.dataset.path = item.path;
      desk.appendChild(a);
    }
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.id = 'create-btn';
    createBtn.dataset.path = '/create';
    createBtn.setAttribute('aria-haspopup', 'menu');
    createBtn.setAttribute('aria-expanded', 'false');
    createBtn.className = 'px-3 py-2 rounded-lg font-medium inline-flex items-center gap-1.5 text-zinc-400 hover:text-white';
    createBtn.innerHTML = CREATE_ICON + '<span>Create</span>';
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
      const active = item && item.match.test(path);
      el.className = 'px-3 py-2 rounded-lg font-medium ' + (active ? 'text-white bg-violet-600/20' : 'text-zinc-400 hover:text-white');
    }
    const createBtn = document.getElementById('create-btn');
    if (createBtn) {
      const active = /^\/create/.test(path) || /^\/dashboard\//.test(path);
      createBtn.className = 'px-3 py-2 rounded-lg font-medium inline-flex items-center gap-1.5 ' + (active ? 'text-white bg-violet-600/20' : 'text-zinc-400 hover:text-white');
    }
  }
  function renderNav(path) {
    if (!navBuilt) buildNav();
    paintNav(path);
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
  function openCreateMenu(trigger) {
    const menu = togglePop(trigger, panel('left-0', '<p class="px-3 py-2 text-xs text-zinc-500">Create</p><div class="create-list"></div>'));
    if (!menu) return;
    const list = menu.querySelector('.create-list');
    const add = (label, href, hint) => {
      const b = window.QUI.el('<button type="button" class="w-full text-left px-3 py-2.5 rounded-lg hover:bg-zinc-800"><span class="block text-sm text-zinc-200">' + window.QUI.escapeHtml(label) + '</span>' + (hint ? '<span class="block text-xs text-zinc-500">' + window.QUI.escapeHtml(hint) + '</span>' : '') + '</button>');
      b.addEventListener('click', () => { closeMenu(trigger); nav(href); });
      list.appendChild(b);
    };
    const model = window.QuestoraNavMenu.createMenuItems([]);
    add(model.project.label, model.project.href, model.project.hint);
    const loading = window.QUI.el('<p class="px-3 py-2 text-xs text-zinc-600">Loading your projects…</p>');
    list.appendChild(loading);
    loadManageProjects().then((projects) => {
      loading.remove();
      if (!menu.isConnected) return;
      const m = window.QuestoraNavMenu.createMenuItems(projects);
      if (m.hint) { list.appendChild(window.QUI.el('<p class="px-3 pt-1 pb-2 text-xs text-zinc-600">' + window.QUI.escapeHtml(m.hint) + '</p>')); return; }
      if (!m.needsPicker) {
        for (const it of m.items) add(it.label, it.href, it.hint);
        return;
      }
      renderPicker(m.projects);
    });

    // With several manageable projects, choosing one swaps the menu to that
    // project's three create actions, with a way back.
    function renderPicker(projects) {
      list.replaceChildren();
      list.appendChild(window.QUI.el('<p class="px-3 pt-1 pb-1 text-xs text-zinc-500">Choose a project</p>'));
      for (const p of projects) {
        const b = window.QUI.el('<button type="button" class="w-full text-left px-3 py-2.5 rounded-lg hover:bg-zinc-800"><span class="block text-sm text-zinc-200">' + window.QUI.escapeHtml(p.name) + '</span></button>');
        b.addEventListener('click', () => {
          list.replaceChildren();
          const back = window.QUI.el('<button type="button" class="w-full text-left text-xs px-3 py-2 rounded-lg text-violet-300 hover:bg-zinc-800">← Back</button>');
          back.addEventListener('click', () => renderPicker(projects));
          list.appendChild(back);
          list.appendChild(window.QUI.el('<p class="px-3 py-2 text-xs text-zinc-500">' + window.QUI.escapeHtml(p.name) + '</p>'));
          for (const a of window.QuestoraNavMenu.projectActions(p)) add(a.label, a.href);
        });
        list.appendChild(b);
      }
    }
  }

  // ---- Account menu --------------------------------------------------------
  function openAccountMenu(trigger) {
    togglePop(trigger, panel('right-0', '<div class="account-list"></div>'), (menu) => {
      const list = menu.querySelector('.account-list');
      const put = (label, run) => {
        const b = window.QUI.el('<button type="button" class="w-full text-left text-sm px-3 py-2.5 rounded-lg text-zinc-200 hover:bg-zinc-800">' + window.QUI.escapeHtml(label) + '</button>');
        b.addEventListener('click', () => { closeMenu(trigger); run(); });
        list.appendChild(b);
      };
      put('Profile', () => nav('/me'));
      put('Account Settings', () => nav('/settings'));
      put('Connected Wallets', () => nav('/me?tab=wallets'));
      put('My Projects', () => nav('/my-projects'));
      if (session.isAdmin()) put('Admin', () => nav('/admin'));
      if (window.usernode && window.usernode.isNative) {
        list.appendChild(window.QUI.el('<div class="my-1 border-t border-zinc-800"></div>'));
        put('Log out', () => { Promise.resolve(window.usernode.logout()).catch(() => window.QUI.toast('Could not log out', true)); });
      }
    });
  }

  // ---- Theme menu ----------------------------------------------------------
  const SUN_SVG = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path></svg>';
  const MOON_SVG = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
  function themeIcon() {
    const mode = window.QuestoraTheme.mode();
    if (mode === 'system') return '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20h8"></path></svg>';
    return document.documentElement.classList.contains('dark') ? SUN_SVG : MOON_SVG;
  }
  function renderThemeButtons() {
    const btn = document.getElementById('theme-btn');
    if (btn) btn.innerHTML = themeIcon();
  }
  const THEME_OPTIONS = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']];
  function openThemeMenu(trigger) {
    togglePop(trigger, panel('right-0', '<div class="theme-list"></div>'), (menu) => {
      const list = menu.querySelector('.theme-list');
      const current = window.QuestoraTheme.mode();
      for (const [mode, label] of THEME_OPTIONS) {
        const on = current === mode;
        const b = window.QUI.el('<button type="button" data-mode="' + mode + '" class="w-full text-left text-sm px-3 py-2.5 rounded-lg flex items-center justify-between ' + (on ? 'bg-violet-600/20 text-white' : 'text-zinc-200 hover:bg-zinc-800') + '"><span>' + label + '</span>' + (on ? '<span class="text-violet-300">✓</span>' : '') + '</button>');
        b.addEventListener('click', () => { closeMenu(trigger); chooseTheme(mode); });
        list.appendChild(b);
      }
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
    togglePop(trigger, panel('right-0 w-80', '<div class="notif-body"></div>'), (menu) => renderNotifBody(menu.querySelector('.notif-body'), trigger));
  }
  async function renderNotifBody(holder, trigger) {
    holder.replaceChildren(window.QUI.el('<p class="px-3 py-4 text-sm text-zinc-500 animate-pulse">Loading notifications…</p>'));
    let data;
    try {
      data = await window.QuestoraAPI.api.get('/api/v1/notifications');
      notifCache.data = data;
      markBadge(data.unread);
    } catch (err) {
      holder.replaceChildren(window.QUI.el('<div class="px-3 py-4"><p class="text-sm text-red-400">' + window.QUI.escapeHtml(err.message) + '</p><button type="button" class="retry mt-2 text-sm text-violet-400 font-medium">Try again</button></div>'));
      holder.querySelector('.retry').addEventListener('click', () => renderNotifBody(holder, trigger));
      appendNotifFooter(holder, trigger);
      return;
    }
    if (!data.notifications.length) {
      holder.replaceChildren(window.QUI.el('<div class="px-3 py-6 text-center"><p class="text-sm text-zinc-400">No notifications yet.</p><p class="text-xs text-zinc-600 mt-1">Complete quests and follow campaigns to hear about it here.</p></div>'));
    } else {
      const list = window.QUI.el('<div class="max-h-80 overflow-y-auto space-y-1"></div>');
      for (const n of data.notifications) {
        const row = window.QUI.el('<button type="button" class="w-full text-left px-3 py-2.5 rounded-lg ' + (n.read_at ? 'hover:bg-zinc-800' : 'bg-violet-600/10 hover:bg-violet-600/20') + '"><span class="block text-sm font-medium text-zinc-100">' + window.QUI.escapeHtml(n.title) + '</span><span class="block text-xs text-zinc-400">' + window.QUI.escapeHtml(n.body || '') + '</span></button>');
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
    const foot = window.QUI.el('<div class="mt-1 border-t border-zinc-800 pt-1 flex items-center justify-between gap-2"><a href="/notifications" class="text-xs text-violet-300 px-3 py-2">View all</a><button type="button" class="mark-all text-xs text-zinc-400 px-3 py-2">Mark all read</button></div>');
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
    const { connected } = walletState();
    if (!connected.length) { label.textContent = 'Connect wallet'; return; }
    const first = connected[0];
    label.textContent = walletShort(first.address) + (first.network ? ' · ' + first.network : '');
  }
  function openWalletMenu(trigger) {
    const { connected } = walletState();
    if (!connected.length) {
      if (window.QuestoraWallets && window.QuestoraWallets.openModal) window.QuestoraWallets.openModal();
      return;
    }
    togglePop(trigger, panel('right-0 w-72', '<div class="wallet-list"></div>'), (menu) => {
      const list = menu.querySelector('.wallet-list');
      list.appendChild(window.QUI.el('<p class="px-3 py-2 text-xs text-zinc-500">Connected</p>'));
      connected.forEach((c, i) => {
        const active = i === 0;
        const b = window.QUI.el('<button type="button" class="w-full text-left px-3 py-2.5 rounded-lg ' + (active ? 'bg-violet-600/20 hover:bg-violet-600/30' : 'hover:bg-zinc-800') + '"><span class="block text-xs text-zinc-500">' + window.QUI.escapeHtml(c.eco.label) + (c.network ? ' · ' + window.QUI.escapeHtml(c.network) : '') + '</span><span class="block font-mono text-sm text-zinc-200">' + window.QUI.escapeHtml(walletShort(c.address)) + '</span></button>');
        b.addEventListener('click', async () => {
          closeMenu(trigger);
          const rec = window.QuestoraWallets.findSaved(c.eco.id, c.address);
          if (rec && !rec.is_active && window.QuestoraWallets.activate) {
            try { await window.QuestoraWallets.activate(rec.id); window.QUI.toast('Active address updated'); } catch (err) { window.QUI.toast(err.message || 'Could not switch address', true); }
          }
        });
        list.appendChild(b);
      });
      const manage = window.QUI.el('<a href="/me?tab=wallets" class="block text-sm px-3 py-2.5 mt-1 border-t border-zinc-800 text-violet-300">Manage addresses</a>');
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

  async function router() {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const ctx = beginNav();
    if (window.QV) window.QV.__ctx = ctx;
    renderNav(path);
    const menuName = params.get('menu');
    if (menuName) openMenuByName(menuName);
    // Warm the session without blocking the first paint; the nav repaints
    // when it resolves.
    session.load();
    try {
      await routeFor(path, params, ctx);
    } catch (err) {
      if (!isCurrent(ctx.seq)) return;
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

  // The mobile hamburger opens the same primary navigation as the keyboard /
  // desktop bar would: Projects, Campaigns, Create.
  function openMobileMenu(trigger) {
    togglePop(trigger, panel('left-0', '<div class="mobile-list"></div>'), (menu) => {
      const list = menu.querySelector('.mobile-list');
      const path = window.location.pathname;
      const put = (label, href, match) => {
        const on = match.test(path);
        const a = window.QUI.el('<a href="' + href + '" class="block text-sm px-3 py-2.5 rounded-lg ' + (on ? 'bg-violet-600/20 text-white' : 'text-zinc-200 hover:bg-zinc-800') + '">' + window.QUI.escapeHtml(label) + '</a>');
        a.addEventListener('click', (e) => { e.preventDefault(); closeMenu(trigger); nav(href); });
        list.appendChild(a);
      };
      put('Projects', '/projects', /^\/projects/);
      put('Campaigns', '/campaigns', /^\/campaigns/);
      put('Create', '/create', /^\/create/);
      list.appendChild(window.QUI.el('<div class="my-1 border-t border-zinc-800"></div>'));
      put('Settings', '/settings', /^\/settings/);
      put('My Projects', '/my-projects', /^\/my-projects/);
    });
  }
  bindTrigger('menu-btn', openMobileMenu);

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
    for (const id of ['avatar-initials', 'avatar-btn-mobile']) {
      const e = document.getElementById(id);
      if (e) e.textContent = initials;
    }
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

  window.addEventListener('popstate', router);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('#') || a.target === '_blank') return;
    e.preventDefault();
    nav(href);
  });

  // Views call this after a write to refresh the session-backed nav.
  window.QuestoraNav = { go: nav, refresh: router, invalidateSession: () => session.invalidate(), themeChanged: renderThemeButtons };

  window.QV = window.QV || {};
  window.QV.Render = { skeleton, mount, errorCard };
  window.QV.session = session;

  pollNotifs();
  router();
  setInterval(pollNotifs, 30000);
})();
