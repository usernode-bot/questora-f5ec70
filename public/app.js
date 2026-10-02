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
  let navItems = null;

  // The Admin link only exists for admins; role comes from the server.
  async function currentNavItems() {
    if (navItems) return navItems;
    const items = BASE_NAV.slice();
    try {
      const meData = await window.QV.loadMe();
      if (meData && meData.user && meData.user.role === 'admin') {
        items.push({ label: 'Admin', path: '/admin', match: /^\/admin/ });
      }
    } catch { /* signed out: plain nav */ }
    navItems = items;
    return items;
  }

  async function renderNav() {
    const path = window.location.pathname;
    const items = await currentNavItems();
    const desk = document.getElementById('desktop-nav');
    const bottom = document.getElementById('bottom-nav-items');
    desk.replaceChildren();
    bottom.replaceChildren();
    for (const item of items) {
      const active = item.match.test(path);
      desk.appendChild(Object.assign(document.createElement('a'), {
        href: item.path, textContent: item.label,
        className: 'px-3 py-2 rounded-lg font-medium ' + (active ? 'text-white bg-violet-600/20' : 'text-zinc-400 hover:text-white'),
      }));
      bottom.appendChild(Object.assign(document.createElement('a'), {
        href: item.path, textContent: item.label,
        // flex-1 so all items share the viewport width: 7 fixed-width items
        // overflow a 390px phone and clip the last link out of reach.
        className: 'flex flex-col items-center justify-center gap-0.5 min-w-0 flex-1 px-0.5 min-h-[44px] text-center text-[11px] leading-tight font-medium ' + (active ? 'text-violet-300' : 'text-zinc-500'),
      }));
    }
  }

  function appEl() { return document.getElementById('app'); }

  async function router() {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    renderNav();
    const V = window.QV;
    try {
      if (path === '/' || path === '') return await V.viewDiscover();
      if (path === '/leaderboard') return await V.viewLeaderboardHub(params);
      if (path === '/campaigns') return await V.viewCampaigns(params);
      if (path === '/projects') return await V.viewProjects(params);
      if (path === '/teams') return await V.viewTeams(params);
      if (path === '/create') return await V.viewCreate();
      if (path === '/me') {
        const meData = await V.loadMe();
        return await V.viewProfile(meData ? meData.user.username : 'me', params);
      }
      // The dashboard is its own shell: /dashboard/projects/:slug/<section>.
      let m;
      if ((m = path.match(/^\/dashboard\/projects\/([^/]+)(?:\/(.*))?$/))) {
        return await V.viewDashboard(decodeURIComponent(m[1]), m[2] || '', params);
      }
      // Hierarchical public routes. The campaign and quest segment forms come
      // first because they are more specific than the project overview.
      if ((m = path.match(/^\/projects\/([^/]+)\/campaigns\/([^/]+)\/quests\/([^/]+)\/leaderboard$/))) {
        return await V.viewScopedLeaderboard({ projectSlug: decodeURIComponent(m[1]), campaignSlug: decodeURIComponent(m[2]), questSlug: decodeURIComponent(m[3]), metric: params.get('metric') || 'xp' });
      }
      if ((m = path.match(/^\/projects\/([^/]+)\/campaigns\/([^/]+)\/quests\/([^/]+)$/))) {
        return await V.viewQuestDetail(decodeURIComponent(m[1]), decodeURIComponent(m[2]), decodeURIComponent(m[3]));
      }
      if ((m = path.match(/^\/projects\/([^/]+)\/campaigns\/([^/]+)\/leaderboard$/))) {
        return await V.viewScopedLeaderboard({ projectSlug: decodeURIComponent(m[1]), campaignSlug: decodeURIComponent(m[2]), metric: params.get('metric') || 'xp' });
      }
      if ((m = path.match(/^\/projects\/([^/]+)\/campaigns\/([^/]+)$/))) {
        return await V.viewCampaignDetail(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      }
      if ((m = path.match(/^\/projects\/([^/]+)\/leaderboard$/))) {
        return await V.viewScopedLeaderboard({ projectSlug: decodeURIComponent(m[1]), metric: params.get('metric') || 'xp' });
      }
      if ((m = path.match(/^\/projects\/([^/]+)\/quests$/))) {
        return await V.viewProjectQuests(decodeURIComponent(m[1]), params);
      }
      if ((m = path.match(/^\/projects\/([^/]+)\/campaigns$/))) {
        return await V.viewProjectCampaigns(decodeURIComponent(m[1]), params);
      }
      if ((m = path.match(/^\/projects\/([^/]+)$/))) {
        return await V.viewProjectOverview(decodeURIComponent(m[1]), params);
      }
      if ((m = path.match(/^\/quest\/(\d+)$/))) return await V.viewQuest(m[1]);
      if ((m = path.match(/^\/quests\/(\d+)$/))) return await V.viewQuest(m[1]);
      // Legacy flat links: resolve to the owning project, then hand off.
      if ((m = path.match(/^\/campaigns\/([^/]+)$/))) {
        const s = await V.resolveCampaignPath(decodeURIComponent(m[1]));
        return await V.viewCampaignDetail(s.projectSlug, decodeURIComponent(m[1]));
      }
      if ((m = path.match(/^\/p\/([^/]+)$/))) {
        const tab = params.get('tab');
        return await V.viewProjectOverview(decodeURIComponent(m[1]), params, tab);
      }
      if ((m = path.match(/^\/u\/([^/]+)$/))) return await V.viewProfile(decodeURIComponent(m[1]), params);
      if ((m = path.match(/^\/credentials\/([0-9a-fA-F-]{36})$/))) return await V.viewCredential(m[1]);
      if (path === '/join') return await V.viewJoin(params);
      if (path === '/search') return await V.viewSearch(params);
      if (path === '/notifications') return await V.viewNotifications();
      if (path === '/admin') return await V.viewAdmin();
      return await V.viewDiscover();
    } catch (err) {
      appEl().replaceChildren();
      appEl().append(err.message);
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

  // Theme toggle: sun in dark mode, moon in light mode. The pick is stored
  // per device (QuestoraTheme) and wins over the platform theme.
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
  document.getElementById('theme-btn').addEventListener('click', toggleTheme);
  document.getElementById('theme-btn-mobile').addEventListener('click', toggleTheme);
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

  pollNotifs();
  router();
  setInterval(pollNotifs, 30000);
})();
