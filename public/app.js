// Questora SPA. Path-routed (the server catch-all serves index.html for
// every app path), so deep links work everywhere including share links.
(function () {
  'use strict';
  const BASE_NAV = [
    { label: 'Explore', path: '/', match: /^\/$/ },
    { label: 'Projects', path: '/projects', match: /^\/projects/ },
    { label: 'Campaigns', path: '/campaigns', match: /^\/campaigns$/ },
    { label: 'Leaderboard', path: '/leaderboard', match: /^\/leaderboard/ },
    { label: 'Teams', path: '/teams', match: /^\/teams/ },
    { label: 'Profile', path: '/me', match: /^\/(me|u\/)/ },
    { label: 'Create', path: '/create', match: /^\/create/ },
  ];
  const ADMIN_NAV = { label: 'Admin', path: '/admin', match: /^\/admin/ };

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
  let navBuilt = false;
  function navItems() {
    const items = BASE_NAV.slice();
    if (session.isAdmin()) items.push(ADMIN_NAV);
    return items;
  }
  function buildNav(items) {
    const desk = document.getElementById('desktop-nav');
    const bottom = document.getElementById('bottom-nav-items');
    desk.replaceChildren();
    bottom.replaceChildren();
    for (const item of items) {
      const d = document.createElement('a');
      d.href = item.path; d.textContent = item.label; d.dataset.path = item.path;
      desk.appendChild(d);
      const b = document.createElement('a');
      b.href = item.path; b.textContent = item.label; b.dataset.path = item.path;
      bottom.appendChild(b);
    }
    navBuilt = true;
  }
  function paintNav(path) {
    // Idempotent: toggle the active classes on the existing links instead of
    // rebuilding them, so link highlighting never jumps.
    for (const el of document.querySelectorAll('#desktop-nav a')) {
      const item = navItems().find((i) => i.path === el.dataset.path);
      const active = item && item.match.test(path);
      el.className = 'px-3 py-2 rounded-lg font-medium ' + (active ? 'text-white bg-violet-600/20' : 'text-zinc-400 hover:text-white');
    }
    for (const el of document.querySelectorAll('#bottom-nav-items a')) {
      const item = navItems().find((i) => i.path === el.dataset.path);
      const active = item && item.match.test(path);
      el.className = 'flex flex-col items-center justify-center gap-0.5 min-w-0 flex-1 px-0.5 min-h-[44px] text-center text-[11px] leading-tight font-medium ' + (active ? 'text-violet-300' : 'text-zinc-500');
    }
  }
  async function renderNav(path) {
    const items = navItems();
    if (!navBuilt || items.length !== document.querySelectorAll('#desktop-nav a').length) buildNav(items);
    paintNav(path);
  }

  // The Admin link appears when the session resolves; repaint rather than
  // rebuild once the role is known.
  session.subscribe((data) => {
    if (navBuilt) {
      const items = navItems();
      if (items.length !== document.querySelectorAll('#desktop-nav a').length) buildNav(items);
      paintNav(window.location.pathname);
    }
  });

  const ROUTES = [
    [/^\/$/, (V) => V.viewDiscover()],
    [/^\/leaderboard$/, (V, m, params) => V.viewLeaderboardHub(params)],
    [/^\/campaigns$/, (V, m, params) => V.viewCampaigns(params)],
    [/^\/projects$/, (V, m, params) => V.viewProjects(params)],
    [/^\/teams$/, (V, m, params) => V.viewTeams(params)],
    [/^\/create$/, (V) => V.viewCreate()],
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
    if ((m = path.match(/^\/quest\/(\d+)$/))) return V.viewQuest(m[1], ctx);
    if ((m = path.match(/^\/quests\/(\d+)$/))) return V.viewQuest(m[1], ctx);
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
    return V.viewDiscover(ctx);
  }

  async function router() {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const ctx = beginNav();
    if (window.QV) window.QV.__ctx = ctx;
    renderNav(path);
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

  // Notifications badge
  async function pollNotifs() {
    try {
      const data = await window.QuestoraAPI.api.get('/api/v1/notifications');
      for (const id of ['notif-badge', 'notif-badge-mobile']) {
        const b = document.getElementById(id);
        if (!b) continue;
        if (data.unread > 0) { b.textContent = data.unread > 9 ? '9+' : data.unread; b.classList.remove('hidden'); }
        else b.classList.add('hidden');
      }
    } catch (e) { /* signed-out or offline: badge stays hidden */ }
  }

  document.getElementById('notif-btn').addEventListener('click', () => nav('/notifications'));
  document.getElementById('notif-btn-mobile').addEventListener('click', () => nav('/notifications'));

  // Theme toggle: sun in dark mode, moon in light mode. The pick is stored per
  // device (QuestoraTheme) and wins over the platform theme.
  const SUN_SVG = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path></svg>';
  const MOON_SVG = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
  function renderThemeButtons() {
    const isDark = document.documentElement.classList.contains('dark');
    for (const id of ['theme-btn', 'theme-btn-mobile']) {
      const b = document.getElementById(id);
      if (b) b.innerHTML = isDark ? SUN_SVG : MOON_SVG;
    }
  }
  function toggleTheme() {
    const isDark = document.documentElement.classList.contains('dark');
    window.QuestoraTheme.set(isDark ? 'light' : 'dark');
    renderThemeButtons();
  }
  const themeBtn = document.getElementById('theme-btn');
  const themeBtnMobile = document.getElementById('theme-btn-mobile');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
  if (themeBtnMobile) themeBtnMobile.addEventListener('click', toggleTheme);
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
  window.QuestoraNav = { go: nav, refresh: router, invalidateSession: () => session.invalidate() };

  window.QV = window.QV || {};
  window.QV.Render = { skeleton, mount, errorCard };
  window.QV.session = session;

  pollNotifs();
  router();
  setInterval(pollNotifs, 30000);
})();
