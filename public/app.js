// Questora SPA. Path-routed (the server catch-all serves index.html for
// every app path), so deep links work everywhere including share links.
(function () {
  'use strict';
  const NAV_ITEMS = [
    { label: 'Explore', path: '/', match: /^\/$/ },
    { label: 'Quests', path: '/quests', match: /^\/quests/ },
    { label: 'Leaderboard', path: '/leaderboard', match: /^\/leaderboard/ },
    { label: 'Profile', path: '/me', match: /^\/(me|u\/)/ },
    { label: 'Create', path: '/create', match: /^\/create/ },
  ];

  function renderNav() {
    const path = window.location.pathname;
    const desk = document.getElementById('desktop-nav');
    const bottom = document.getElementById('bottom-nav-items');
    desk.replaceChildren();
    bottom.replaceChildren();
    for (const item of NAV_ITEMS) {
      const active = item.match.test(path);
      desk.appendChild(Object.assign(document.createElement('a'), {
        href: item.path, textContent: item.label,
        className: 'px-3 py-2 rounded-lg font-medium ' + (active ? 'text-white bg-violet-600/20' : 'text-zinc-400 hover:text-white'),
      }));
      bottom.appendChild(Object.assign(document.createElement('a'), {
        href: item.path, textContent: item.label,
        className: 'flex flex-col items-center justify-center gap-0.5 min-w-[64px] min-h-[44px] text-[11px] font-medium ' + (active ? 'text-violet-300' : 'text-zinc-500'),
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
      if (path === '/quests') return await viewQuestsList();
      if (path === '/leaderboard') return await V.viewLeaderboard(params);
      if (path === '/create') return await V.viewCreate();
      if (path === '/me') {
        const meData = await V.loadMe();
        return await V.viewProfile(meData ? meData.user.username : 'me');
      }
      let m;
      if ((m = path.match(/^\/campaigns\/([^/]+)$/))) return await V.viewCampaign(decodeURIComponent(m[1]));
      if ((m = path.match(/^\/quest\/(\d+)$/))) return await V.viewQuest(m[1]);
      if ((m = path.match(/^\/u\/([^/]+)$/))) return await V.viewProfile(decodeURIComponent(m[1]));
      if ((m = path.match(/^\/p\/([^/]+)$/))) return await V.viewProject(decodeURIComponent(m[1]));
      if (path === '/notifications') return await V.viewNotifications();
      if (path === '/admin') return await V.viewAdmin();
      return await V.viewDiscover();
    } catch (err) {
      appEl().replaceChildren();
      appEl().append(err.message);
      console.error(err);
    }
  }

  // /quests is a convenience list: reuse the discover data grouped flat.
  async function viewQuestsList() {
    const el = window.QUI.el;
    const escapeHtml = window.QUI.escapeHtml;
    const wrap = el('<div></div>');
    appEl().replaceChildren(wrap);
    wrap.appendChild(el('<h1 class="text-2xl font-bold mb-4">Quests</h1>'));
    let data;
    try { data = await window.QuestoraAPI.api.get('/api/v1/discover'); }
    catch (err) { wrap.appendChild(el('<p class="text-zinc-400">' + escapeHtml(err.message) + '</p>')); return; }
    const all = [];
    const seen = new Set();
    for (const key of ['featured', 'trending', 'fresh', 'ending']) {
      for (const c of data[key]) { if (!seen.has(c.id)) { seen.add(c.id); all.push(c); } }
    }
    if (!all.length) { wrap.appendChild(el('<p class="text-sm text-zinc-600">No live campaigns with quests yet.</p>')); return; }
    const list = el('<div class="space-y-2"></div>');
    for (const c of all) {
      list.appendChild(el('<a href="/campaigns/' + c.slug + '" class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40"><span class="flex-1 min-w-0"><span class="block font-medium truncate">' + escapeHtml(c.name) + '</span><span class="block text-xs text-zinc-600">' + escapeHtml(c.project_name) + ' · ' + c.quest_count + ' quests</span></span><span class="text-sm text-violet-300 font-medium">+' + c.total_xp + ' XP</span></a>'));
    }
    wrap.appendChild(list);
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
