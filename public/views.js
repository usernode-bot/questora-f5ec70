window.QV = (function () {
'use strict';
var el, escapeHtml, toast, campaignCard, sectionRow, timeLeft, levelRing, badgePill, statePill, breadcrumb, statCard, pager, emptyState, permissionList, dangerZone;
// Resolve the orchestrator's helpers at call time: app.js loads after this
// file, so a bind-time capture would freeze the fallbacks.
var mount, errorCard, Render;
function bindRender() {
  mount = function (n) { var R = window.QV && window.QV.Render; return R && R.mount ? R.mount(n) : app().replaceChildren(n); };
  errorCard = function (m) { var R = window.QV && window.QV.Render; return R && R.errorCard ? R.errorCard(m) : el('<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6"><p class="text-zinc-300">' + escapeHtml(m) + '</p></div>'); };
}
function bindQUI() { var q = window.QUI; el = q.el; escapeHtml = q.escapeHtml; toast = q.toast; campaignCard = q.campaignCard; sectionRow = q.sectionRow; timeLeft = q.timeLeft; levelRing = q.levelRing; badgePill = q.badgePill; statePill = q.statePill; breadcrumb = q.breadcrumb; statCard = q.statCard; pager = q.pager; emptyState = q.emptyState; permissionList = q.permissionList; dangerZone = q.dangerZone; }
bindQUI();
bindRender();
// View renderers. Each returns a DocumentFragment-ish element appended by
// app.js. Data comes from /api/v1 via api.js; nothing renders a completion
// state the server did not send.

const app = () => document.getElementById('app');
// Session is owned by the orchestrator in app.js (one shared /users/me read,
// with dedupe and invalidation). Views read it through this shim.
async function loadMe() {
  if (window.QV && window.QV.session) return window.QV.session.load();
  return null;
}

// ---------- discovery ----------
async function viewDiscover() {
  const wrap = el('<div></div>');
  mount(wrap);
  wrap.appendChild(el('<div><h1 class="text-2xl font-bold mb-1">Explore</h1><p class="text-sm text-zinc-500 mb-4">Campaigns you can join right now.</p></div>'));
  const searchForm = el(`
    <form action="/search" method="get" class="flex gap-2 mb-6 max-w-xl">
      <input type="search" name="q" value="${escapeHtml(new URLSearchParams(window.location.search).get('q') || '')}" placeholder="Search projects, campaigns, quests, people" class="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500">
      <button type="submit" class="font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Search</button>
    </form>`);
  wrap.appendChild(searchForm);
  let data;
  try {
    data = await window.QuestoraAPI.api.get('/api/v1/discover');
  } catch (err) {
    wrap.replaceChildren(el(`<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 text-center"><p class="text-zinc-300 mb-2">${escapeHtml(err.message)}</p><button class="retry text-violet-400 text-sm font-medium">Try again</button></div>`));
    wrap.querySelector('.retry').addEventListener('click', viewDiscover);
    return;
  }
  const mk = (cards) => cards;
  wrap.appendChild(sectionRow('Featured', mk(data.featured), 'No featured campaigns yet'));
  wrap.appendChild(sectionRow('Trending', mk(data.trending), 'No campaigns yet. Create the first one.'));
  wrap.appendChild(sectionRow('New', mk(data.fresh), 'No new campaigns yet'));
  wrap.appendChild(sectionRow('Ending soon', mk(data.ending), 'Nothing ending soon'));
  if (data.categories.length) {
    const chips = el(`<section class="mb-8"><h2 class="text-sm font-medium text-zinc-500 mb-2 px-1">Categories</h2><div class="flex flex-wrap gap-2 px-1"></div></section>`);
    const holder = chips.querySelector('div');
    for (const cat of data.categories) {
      holder.appendChild(el(`<a href="/campaigns?category=${encodeURIComponent(cat)}" class="text-sm px-3 py-1.5 rounded-full bg-zinc-800/70 hover:bg-violet-600/20 hover:text-violet-300 text-zinc-300 transition-colors">${escapeHtml(cat)}</a>`));
    }
    wrap.appendChild(chips);
  }
}

// ---------- campaign list ----------
async function viewCampaigns(params) {
  params = params || new URLSearchParams();
  const status = ['active', 'scheduled', 'ended', 'paused', 'archived'].includes(params.get('status'))
    ? params.get('status') : 'active';
  const wrap = el('<div></div>');
  mount(wrap);
  wrap.appendChild(el(`
    <div>
      <h1 class="text-2xl font-bold mb-1">Campaigns</h1>
      <p class="text-sm text-zinc-500 mb-4">Every campaign on Questora, filtered by state.</p>
      <div class="flex gap-1 bg-zinc-900 rounded-full p-1 border border-zinc-800 mb-5 w-fit">
        <a href="/campaigns" class="px-4 py-1.5 rounded-full text-sm font-medium ${status === 'active' ? 'bg-violet-600 text-white' : 'text-zinc-400'}">Active</a>
        <a href="/campaigns?status=scheduled" class="px-4 py-1.5 rounded-full text-sm font-medium ${status === 'scheduled' ? 'bg-violet-600 text-white' : 'text-zinc-400'}">Scheduled</a>
        <a href="/campaigns?status=ended" class="px-4 py-1.5 rounded-full text-sm font-medium ${status === 'ended' ? 'bg-violet-600 text-white' : 'text-zinc-400'}">Ended</a>
      </div>
      <div class="body space-y-2"></div>
    </div>`));
  const body = wrap.querySelector('.body');
  body.appendChild(el('<p class="text-sm text-zinc-500 animate-pulse">Loading campaigns…</p>'));
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/campaigns?status=' + status); }
  catch (err) { body.replaceChildren(el(`<p class="text-sm text-red-400">${escapeHtml(err.message)}</p>`)); return; }
  body.replaceChildren();
  const rows = data.campaigns || [];
  if (!rows.length) {
    body.appendChild(el(`<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center"><p class="text-zinc-400 mb-1">No ${status} campaigns.</p><p class="text-sm text-zinc-600">Check the other tabs, or create one from the Create page.</p></div>`));
    return;
  }
  const grid = el('<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4"></div>');
  for (const c of rows) grid.appendChild(campaignCard({ ...c, project_logo: c.project_logo || '' }));
  body.replaceChildren(grid);
}

// ---------- campaign ----------
async function viewCampaign(slug) {
  const wrap = el('<div class="animate-pulse space-y-4"><div class="h-32 rounded-2xl bg-zinc-900"></div><div class="h-6 w-1/2 rounded bg-zinc-900"></div></div>');
  mount(wrap);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/campaigns/' + encodeURIComponent(slug)); }
  catch (err) {
    mount(errorCard(err.message));
    return;
  }
  const c = data.campaign;
  const completedCount = data.quests.filter(q => q.completed).length;
  const node = el(`
    <div>
      <div class="rounded-2xl bg-gradient-to-b from-violet-600/20 to-transparent border border-zinc-800 p-6 mb-6">
        <div class="flex items-center gap-2 mb-2 text-sm text-zinc-400">
          <span class="w-5 h-5 rounded-full bg-violet-600/30 inline-block"></span>
          <a href="/p/${escapeHtml(c.project_slug)}" class="hover:text-violet-300">${escapeHtml(c.project_name)}</a>
          ${statePill(c.status)}
        </div>
        <h1 class="text-2xl font-bold mb-2">${escapeHtml(c.name)}</h1>
        <p class="text-sm text-zinc-300 mb-4 max-w-2xl">${escapeHtml(c.description || '')}</p>
        <div class="flex flex-wrap gap-2 text-xs">
          ${badgePill('+' + data.total_xp + ' XP')}
          ${data.total_points ? badgePill('+' + data.total_points + ' points') : ''}
          ${badgePill(data.participants + ' participants')}
          ${c.ends_at ? `<span class="inline-block text-xs px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-400">${timeLeft(c.ends_at)}</span>` : ''}
        </div>
        <div class="join-slot mt-4"></div>
      </div>
      <h2 class="text-sm font-medium text-zinc-500 mb-2 px-1">Quests ${completedCount ? `<span class="text-violet-300">${completedCount}/${data.quests.length} done</span>` : ''}</h2>
      <div class="quest-list space-y-3"></div>
    </div>`);
  mount(node);

  // Join button: the server only accepts joins on live campaigns.
  if (data.joined === false && c.status === 'active') {
    const joinBtn = el('<button class="join font-medium px-5 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Join campaign</button>');
    joinBtn.addEventListener('click', async () => {
      joinBtn.disabled = true; joinBtn.textContent = 'Joining…';
      try {
        await window.QuestoraAPI.api.post(`/api/v1/campaigns/${c.id}/join`, {});
        toast('You joined the campaign');
        viewCampaign(slug);
      } catch (err) { toast(err.message, true); joinBtn.disabled = false; joinBtn.textContent = 'Join campaign'; }
    });
    node.querySelector('.join-slot').appendChild(joinBtn);
  } else if (data.joined === true) {
    node.querySelector('.join-slot').appendChild(el('<span class="inline-block text-xs px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-300">Joined</span>'));
  }

  const list = node.querySelector('.quest-list');
  for (const q of data.quests) {
    // Circle state: done, locked, or open. The server decides; the UI only
    // renders what it sent.
    const circle = q.completed
      ? '<span class="task-circle w-6 h-6 rounded-full border-2 border-emerald-400 bg-emerald-400/10 text-emerald-300 shrink-0 flex items-center justify-center text-xs">✓</span>'
      : q.locked
        ? '<span class="task-circle w-6 h-6 rounded-full border-2 border-zinc-700 bg-zinc-800/50 text-zinc-500 shrink-0 flex items-center justify-center text-xs">🔒</span>'
        : '<span class="task-circle w-6 h-6 rounded-full border-2 border-zinc-700 shrink-0 flex items-center justify-center"></span>';
    const row = el(`
      <a href="/quest/${q.id}" class="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 hover:border-violet-500/40 transition-colors p-4 ${q.locked && !q.completed ? 'opacity-60' : ''}">
        ${circle}
        <span class="min-w-0">
          <span class="block font-medium ${q.is_required ? 'text-zinc-100' : 'text-zinc-400'}">${escapeHtml(q.title)}${q.is_required ? '' : ' <span class="text-xs text-zinc-600">(optional)</span>'}</span>
          <span class="block text-sm text-zinc-500 truncate">${escapeHtml(q.description || '')}</span>
          ${q.locked && !q.completed ? `<span class="lock-reason block text-xs text-amber-300 mt-1">${escapeHtml(q.locked_reason || 'Locked')}</span>` : ''}
        </span>
        <span class="ml-auto text-sm text-violet-300 font-medium shrink-0">+${q.xp_reward} XP</span>
      </a>`);
    list.appendChild(row);
  }
}

// ---------- quest ----------
const TASK_LABEL = {
  wallet_connect: 'Connect wallet',
  social: 'Social link',
  url_proof: 'Submit proof',
  quiz: 'Quiz',
  manual: 'Manual review',
};

async function viewQuest(id) {
  const wrap = el('<div class="animate-pulse space-y-3"><div class="h-8 w-2/3 rounded bg-zinc-900"></div><div class="h-24 rounded-xl bg-zinc-900"></div></div>');
  mount(wrap);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/quests/' + encodeURIComponent(id)); }
  catch (err) { mount(errorCard(err.message)); return; }
  const q = data.quest;
  let states;
  try { states = await window.QuestoraAPI.api.get(`/api/v1/quests/${q.id}/my`); } catch { states = { states: [] }; }
  const stateByTask = {};
  for (const s of states.states || []) stateByTask[s.task_id] = s;

  const node = el(`
    <div>
      <a href="/campaigns/${escapeHtml(q.campaign_slug)}" class="text-sm text-zinc-500 hover:text-violet-300">${escapeHtml(q.campaign_name)}</a>
      <h1 class="text-2xl font-bold mt-1 mb-1">${escapeHtml(q.title)}</h1>
      <p class="text-sm text-zinc-400 mb-4 max-w-2xl">${escapeHtml(q.description || '')}</p>
      <div class="flex gap-2 mb-6">${badgePill('+' + q.xp_reward + ' XP')}${q.points_reward ? badgePill('+' + q.points_reward + ' points') : ''}${badgePill(data.participants + ' completed')}</div>
      <div class="lock-banner mb-6"></div>
      <h2 class="text-sm font-medium text-zinc-500 mb-2 px-1">Checklist</h2>
      <div class="task-list space-y-3"></div>
      <div class="result mt-6"></div>
    </div>`);
  mount(node);
  // A locked quest explains itself and offers no actions.
  if (q.locked) {
    node.querySelector('.lock-banner').appendChild(el(`
      <div class="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
        <p class="text-sm text-amber-200">${escapeHtml(q.locked_reason || 'This quest is locked.')}</p>
      </div>`));
  }
  const list = node.querySelector('.task-list');

  // Rebuild just the checklist in place after a submission, so verifying a
  // wallet or answering a quiz updates the page instead of remounting it.
  async function refreshStates() {
    let fresh;
    try { fresh = await window.QuestoraAPI.api.get(`/api/v1/quests/${q.id}/my`); } catch { fresh = { states: [] }; }
    for (const k of Object.keys(stateByTask)) delete stateByTask[k];
    for (const st of fresh.states || []) stateByTask[st.task_id] = st;
    list.replaceChildren();
    for (const t of data.tasks) list.appendChild(taskRow(t));
  }

  function taskRow(t) {
    const st = stateByTask[t.id];
    const status = st ? st.status : null;
    const stateCls = status === 'verified' ? 'border-emerald-400 bg-emerald-400/10'
      : status === 'pending' ? 'border-amber-400 bg-amber-400/10'
      : status === 'rejected' ? 'border-red-400 bg-red-400/10'
      : 'border-zinc-700';
    const row = el(`
      <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div class="flex items-start gap-3">
          <span class="task-state w-6 h-6 rounded-full border-2 ${stateCls} shrink-0 mt-0.5 flex items-center justify-center text-xs"></span>
          <div class="min-w-0 flex-1">
            <p class="font-medium">${escapeHtml(t.title)}</p>
            <p class="text-xs text-zinc-500">${escapeHtml(TASK_LABEL[t.type] || t.type)}${t.proof_required ? ' · proof required' : ''}</p>
            <div class="status-line mt-1"></div>
            <div class="action-area mt-3"></div>
            <div class="reject-line mt-2"></div>
          </div>
        </div>
      </div>`);
    const statusLine = row.querySelector('.status-line');
    const actionArea = row.querySelector('.action-area');
    const rejectLine = row.querySelector('.reject-line');
    const stateDot = row.querySelector('.task-state');

    if (status === 'verified') { stateDot.textContent = '✓'; statusLine.innerHTML = statePill('verified'); }
    else if (status === 'pending') { statusLine.innerHTML = statePill('pending'); }
    else if (status === 'rejected') {
      stateDot.textContent = '✕'; statusLine.innerHTML = statePill('rejected');
      rejectLine.innerHTML = `<p class="text-sm text-red-300">${escapeHtml(st.review_note || 'Rejected')}</p>`;
      const again = el('<button class="resubmit mt-2 text-sm font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white">Resubmit</button>');
      again.addEventListener('click', () => actionFor(t, actionArea));
      rejectLine.appendChild(again);
    } else {
      if (q.locked) {
        holder.appendChild(el(`<p class="text-sm text-zinc-500">${escapeHtml(q.locked_reason || 'This quest is locked.')}</p>`));
      } else {
        actionFor(t, actionArea);
      }
    }
    return row;
  }

  // Real wallet flow: request accounts, get a server nonce for THAT address,
  // personal_sign the exact challenge message, and send the signature back.
  // The server recovers the signer and compares it to the claimed address.
  async function walletConnectFlow(button) {
    if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask or another wallet.');
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const address = accounts && accounts[0];
    if (!address) throw new Error('Connect a wallet account first');
    // Already verified? Skip the signature (one verified wallet is enough).
    try {
      const mine = await window.QuestoraAPI.api.get('/api/v1/wallets');
      const w = (mine.wallets || []).find(x => x.address && x.address.toLowerCase() === address.toLowerCase());
      if (w && w.verified_at) {
        toast('Wallet already verified');
        return address;
      }
    } catch { /* fall through to the full flow */ }
    const ch = await window.QuestoraAPI.api.post('/api/v1/wallets/challenge', { chain: 'eip155', address });
    const signature = await window.QuestoraAPI.signMessage(address, ch.message);
    await window.QuestoraAPI.api.post('/api/v1/wallets/verify', { chain: 'eip155', address, signature, nonce: ch.nonce });
    toast('Wallet verified');
    return address;
  }

  function actionFor(t, holder) {
    holder.replaceChildren();
    if (t.type === 'wallet_connect') {
      const b = el('<button class="connect w-full md:w-auto font-medium px-5 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white">Connect wallet</button>');
      b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'Waiting for wallet…';
        try {
          await walletConnectFlow(b);
          await window.QuestoraAPI.api.post(`/api/v1/tasks/${t.id}/submit`, {});
          refreshStates();
        } catch (err) {
          toast(err.message || 'Could not verify the wallet', true);
          b.disabled = false; b.textContent = 'Connect wallet';
        }
      });
      holder.appendChild(b);
      return;
    }
    if (t.type === 'social') {
      const cfg = t.config || {};
      const b = el('<button class="visit w-full md:w-auto font-medium px-5 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white">Visit and confirm</button>');
      const link = el(`<a href="${escapeHtml(cfg.url || '#')}" target="_blank" rel="noopener" class="block mt-2 text-sm text-violet-300 hover:underline">Open link in a new tab</a>`);
      b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'Sending…';
        try {
          await window.QuestoraAPI.api.post(`/api/v1/tasks/${t.id}/submit`, {});
          toast('Sent for review');
          refreshStates();
        } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = 'Visit and confirm'; }
      });
      holder.appendChild(b); holder.appendChild(link);
      return;
    }
    if (t.type === 'quiz') {
      const cfg = t.config || {};
      const form = el('<div class="space-y-3 quiz-form"></div>');
      const answers = [];
      (cfg.questions || []).forEach((question, qi) => {
        answers.push(null);
        const qEl = el(`<div><p class="text-sm font-medium mb-2">${qi + 1}. ${escapeHtml(question.q)}</p><div class="opts space-y-2"></div></div>`);
        const opts = qEl.querySelector('.opts');
        question.options.forEach((opt, oi) => {
          const id = `q${t.id}_${qi}_${oi}`;
          const optEl = el(`<label class="flex items-center gap-2.5 rounded-lg border border-zinc-800 px-3 py-2.5 min-h-[44px] cursor-pointer hover:border-violet-500/40 peer-checked:border-violet-500 peer-checked:bg-violet-600/10"><input type="radio" name="${id}" class="peer accent-violet-500" data-qi="${qi}" data-oi="${oi}"><span class="text-sm">${escapeHtml(opt)}</span></label>`);
          optEl.querySelector('input').addEventListener('change', () => { answers[qi] = oi; });
          opts.appendChild(optEl);
        });
        form.appendChild(qEl);
      });
      const submit = el('<button class="w-full md:w-auto font-medium px-5 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white">Check answers</button>');
      submit.addEventListener('click', async () => {
        if (answers.some(a => a === null)) return toast('Answer every question first', true);
        submit.disabled = true; submit.textContent = 'Checking…';
        try {
          const r = await window.QuestoraAPI.api.post(`/api/v1/quests/${q.id}/quiz`, { task_id: t.id, answers });
          if (r.passed) toast(`Scored ${r.score}%`);
          refreshStates();
        } catch (err) { toast(err.message, true); submit.disabled = false; submit.textContent = 'Check answers'; }
      });
      form.appendChild(submit);
      holder.appendChild(form);
      return;
    }
    // url_proof + manual share the same simple form.
    const isUrl = t.type === 'url_proof';
    const form = el(`
      <div class="space-y-2">
        ${isUrl ? '<input type="url" class="proof-url w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" placeholder="https://your proof link">' : ''}
        ${isUrl ? '' : '<textarea class="proof-text w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" rows="3" placeholder="Describe what you did, or paste a link"></textarea>'}
        <button class="send w-full md:w-auto font-medium px-5 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white">Submit for review</button>
      </div>`);
    form.querySelector('.send').addEventListener('click', async () => {
      const btn = form.querySelector('.send');
      const url = isUrl ? form.querySelector('.proof-url').value.trim() : (form.querySelector('.proof-text').value.match(/https?:\/\/\S+/) || [null])[0];
      const text = isUrl ? null : form.querySelector('.proof-text').value.trim();
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        await window.QuestoraAPI.api.post(`/api/v1/tasks/${t.id}/submit`, { proof_url: url, proof_data: text ? { text } : null });
        toast('Sent for review');
        refreshStates();
      } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Submit for review'; }
    });
    holder.appendChild(form);
  }

  for (const t of data.tasks) list.appendChild(taskRow(t));
}

// ---------- profile ----------
async function viewProfile(username, params) {
  params = params || new URLSearchParams();
  const wrap = el('<div class="animate-pulse space-y-3"><div class="h-20 rounded-2xl bg-zinc-900"></div></div>');
  mount(wrap);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/users/' + encodeURIComponent(username)); }
  catch (err) { mount(errorCard(err.message)); return; }
  const u = data.user;
  const pct = u.next ? Math.min(100, Math.round(((u.xp - (u.next.min_xp - (u.next.min_xp - 0))) / u.next.min_xp) * 100)) : 100;
  const progress = u.next
    ? Math.round(((u.xp) / Math.max(1, u.next.min_xp)) * 100)
    : 100;
  const node = el(`
    <div>
      <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 mb-6 flex items-center gap-5">
        <div class="level-ring-slot"></div>
        <div class="min-w-0">
          <h1 class="text-xl font-bold">${escapeHtml(u.display_name || u.username)}</h1>
          <p class="text-sm text-zinc-500">@${escapeHtml(u.username)}</p>
          <div class="flex flex-wrap gap-2 mt-2">
            ${badgePill(u.xp + ' XP')}${badgePill(u.points + ' points')}${badgePill('Rank #' + data.leaderboard_rank)}
            ${data.reputation ? badgePill('Reputation ' + (data.reputation.total > 0 ? '+' : '') + data.reputation.total) : ''}
          </div>
          ${u.next ? `<p class="text-xs text-zinc-600 mt-2">${u.next.min_xp - u.xp} XP to level ${u.next.level}</p>` : ''}
        </div>
      </div>
      <div class="tabs flex gap-2 mb-4">
        <button data-tab="projects" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Projects</button>
        <button data-tab="activity" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Activity</button>
        <button data-tab="badges" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Badges</button>
        <button data-tab="credentials" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Credentials</button>
        <button data-tab="reputation" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Reputation</button>
        <button data-tab="achievements" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Achievements</button>
        <button data-tab="wallets" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Wallets</button>
      </div>
      <div class="tab-body"></div>
      <div class="invite-slot mt-6"></div>
    </div>`);
  mount(node);
  // levelRing builds a DOM node, so it is inserted here rather than
  // interpolated into the template above (which would stringify it).
  node.querySelector('.level-ring-slot').appendChild(levelRing(u.level, progress));
  const body = node.querySelector('.tab-body');
  const inviteSlot = node.querySelector('.invite-slot');
  // Wallets link to your own account only, but verified addresses are public,
  // so everyone sees the viewed profile's linked wallets. The rows come from
  // the profile payload; the owner also gets a Connect wallet control.
  let isOwn = false;
  const chainLabel = (ns) => {
    const c = (window.QuestoraWallets.CHAINS || []).find(x => x.chain === ns);
    return c ? c.label : ns;
  };
  function walletRows() {
    const list = el('<div class="space-y-2"></div>');
    const wallets = data.wallets || [];
    if (!wallets.length) {
      list.appendChild(el('<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center"><p class="text-zinc-400">No wallets linked yet. Link one to prove you own it and complete wallet quests.</p></div>'));
      return list;
    }
    for (const w of wallets) {
      list.appendChild(el(`
        <div class="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <span class="min-w-0">
            <span class="block text-xs text-zinc-500 mb-0.5">${escapeHtml(chainLabel(w.chain_namespace))}${w.is_primary ? ' \u00b7 primary' : ''}</span>
            <span class="block font-mono text-sm truncate">${escapeHtml(w.address)}</span>
          </span>
          <span class="shrink-0">${statePill('verified')}</span>
        </div>`));
    }
    return list;
  }
  // Re-read the profile payload so a just-added wallet appears without
  // remounting the whole view.
  async function reloadWallets() {
    try {
      const fresh = await window.QuestoraAPI.api.get('/api/v1/users/' + encodeURIComponent(username));
      data.wallets = fresh.wallets || [];
    } catch { /* keep the rows we already have */ }
  }
  function renderWallets() {
    body.replaceChildren(walletRows());
    if (!isOwn) return;
    const addBtn = el('<button class="connect-wallet mt-3 w-full md:w-auto font-medium px-5 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white">Connect wallet</button>');
    addBtn.addEventListener('click', () => {
      // Chain picker first, then the connector hands off to the wallet.
      const pick = el('<div class="space-y-2"></div>');
      for (const c of window.QuestoraWallets.CHAINS) {
        const b = el(`<button class="chain-pick w-full text-left font-medium px-4 py-3 min-h-[44px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100">${escapeHtml(c.label)}</button>`);
        b.addEventListener('click', async () => {
          pick.replaceChildren(el('<p class="text-sm text-zinc-400">Connect and sign in your wallet\u2026</p>'));
          try {
            await window.QuestoraWallets.link(c.chain);
            toast('Wallet verified');
            await reloadWallets();
            renderWallets();
          } catch (err) {
            toast(err.message || 'Could not verify the wallet', true);
            renderWallets();
          }
        });
        pick.appendChild(b);
      }
      const panel = el('<div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"></div>');
      panel.appendChild(el('<p class="text-sm font-medium mb-2">Choose a chain</p>'));
      panel.appendChild(pick);
      body.replaceChildren(panel);
    });
    body.appendChild(addBtn);
  }
  let lastTab = 'activity';
  function show(tab) {
    lastTab = tab;
    node.querySelectorAll('.tab').forEach(b => {
      const on = b.dataset.tab === tab;
      b.className = 'tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium ' + (on ? 'bg-violet-600 text-white' : 'bg-zinc-800/70 text-zinc-400');
    });
    body.replaceChildren();
    if (tab === 'projects') {
      // Per-project participation: each project ranks on its own board, so
      // XP and rank are listed project by project, never blended.
      const rows = data.projects || [];
      if (!rows.length) { body.appendChild(el('<p class="text-sm text-zinc-600 px-1">No project participation yet. Complete a quest to appear on a project board.</p>')); return; }
      const list = el('<div class="space-y-2"></div>');
      for (const pr of rows) {
        list.appendChild(el(`
          <a href="/projects/${encodeURIComponent(pr.slug)}/leaderboard" class="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40 transition-colors">
            <span class="min-w-0"><span class="block font-medium truncate">${escapeHtml(pr.name)}</span>
            <span class="block text-xs text-zinc-600">Rank #${pr.rank} in this project</span></span>
            <span class="font-mono text-violet-300">${Number(pr.xp).toLocaleString()} XP</span>
          </a>`));
      }
      body.appendChild(list);
      return;
    }
    if (tab === 'credentials') {
      if (!data.credentials.length) { body.appendChild(el('<p class="text-sm text-zinc-600 px-1">No credentials yet. Finish a quest that issues one.</p>')); return; }
      const list = el('<div class="space-y-2"></div>');
      for (const c of data.credentials) {
        list.appendChild(el(`
          <a href="/credentials/${escapeHtml(c.id)}" class="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40 transition-colors">
            <span class="min-w-0"><span class="block font-medium truncate">${escapeHtml(c.title)}</span><span class="block text-xs text-zinc-600">${escapeHtml(c.issuer_name || 'Questora')} · ${new Date(c.issued_at).toLocaleDateString()}</span></span>
            ${c.revoked_at ? statePill('rejected') : badgePill('Verified')}
          </a>`));
      }
      body.appendChild(list);
      return;
    }
    if (tab === 'reputation') {
      const rep = data.reputation || { total: 0, breakdown: [] };
      const labels = {
        quest_completed: 'Quests completed',
        quest_rejected: 'Submissions rejected',
        wallet_verified: 'Wallet verified',
        referral_qualified: 'Invite qualified',
      };
      const head = `<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 mb-3 flex items-center justify-between">
        <div><h2 class="font-semibold">Reputation score</h2>
        <p class="text-xs text-zinc-600 mt-0.5">A transparent sum of every signal on this account.</p></div>
        <span class="font-mono text-2xl font-bold ${rep.total >= 0 ? 'text-emerald-300' : 'text-red-300'}">${rep.total > 0 ? '+' : ''}${rep.total}</span>
      </div>`;
      if (!rep.breakdown.length) {
        body.appendChild(el(head + '<p class="text-sm text-zinc-600 px-1">No reputation signals yet. Complete quests to build a score.</p>'));
        return;
      }
      const rows = el('<div class="space-y-2"></div>');
      for (const r of rep.breakdown) {
        rows.appendChild(el(`
          <div class="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <span class="min-w-0"><span class="block font-medium">${escapeHtml(labels[r.category] || r.category)}</span>
            <span class="block text-xs text-zinc-600">${r.events} event${r.events === 1 ? '' : 's'}</span></span>
            <span class="font-mono ${r.sum >= 0 ? 'text-emerald-300' : 'text-red-300'}">${r.sum > 0 ? '+' : ''}${r.sum}</span>
          </div>`));
      }
      body.appendChild(el(head));
      body.appendChild(rows);
      return;
    }
    if (tab === 'achievements') {
      if (!data.achievements || !data.achievements.length) {
        body.appendChild(el('<p class="text-sm text-zinc-600 px-1">No achievements configured yet.</p>'));
        return;
      }
      const list = el('<div class="space-y-2"></div>');
      for (const a of data.achievements) {
        const locked = !a.unlocked_at;
        list.appendChild(el(`
          <div class="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 ${locked ? 'bg-zinc-900/30 opacity-60' : 'bg-zinc-900/60'} px-4 py-3">
            <span class="min-w-0"><span class="block font-medium">${escapeHtml(a.name)}</span>
            <span class="block text-xs text-zinc-600">${escapeHtml(a.description || '')}</span></span>
            ${locked ? '<span class="shrink-0 text-xs text-zinc-600">Locked</span>' : statePill('verified')}
          </div>`));
      }
      body.appendChild(list);
      return;
    }
    if (tab === 'wallets') { renderWallets(); return; }
    if (tab === 'badges') {
      if (!data.badges.length) { body.appendChild(el('<p class="text-sm text-zinc-600 px-1">No badges yet. Complete quests to earn them.</p>')); return; }
      const grid = el('<div class="grid grid-cols-2 md:grid-cols-4 gap-3"></div>');
      for (const b of data.badges) {
        grid.appendChild(el(`<div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-center"><div class="text-2xl mb-1">🏅</div><p class="text-sm font-medium">${escapeHtml(b.name)}</p><p class="text-xs text-zinc-500">${escapeHtml(b.rarity)}</p></div>`));
      }
      body.appendChild(grid);
    } else {
      if (!data.activity.length) { body.appendChild(el('<p class="text-sm text-zinc-600 px-1">No completed quests yet.</p>')); return; }
      const list = el('<div class="space-y-2"></div>');
      for (const a of data.activity) {
        list.appendChild(el(`<a href="/quest/${a.quest_id}" class="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3"><span class="text-sm">${escapeHtml(a.title)} <span class="text-zinc-600">in ${escapeHtml(a.campaign_name)}</span></span><span class="text-sm text-violet-300">+${a.xp_reward} XP</span></a>`));
      }
      body.appendChild(list);
    }
  }
  node.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
  const initialTab = params.get('tab');
  show(['projects', 'badges', 'credentials', 'reputation', 'achievements', 'wallets'].includes(initialTab) ? initialTab : 'activity');

  // Own profile: the invite block (Phase 2 referrals).
  const meData = await loadMe();
  if (meData && meData.user && (meData.user.username || '').toLowerCase() === String(username).toLowerCase()) {
    isOwn = true;
    if (lastTab === 'wallets') renderWallets();
    let inv;
    try { inv = await window.QuestoraAPI.api.get('/api/v1/referrals/me'); } catch { inv = null; }
    if (inv && inv.code) {
      const joinLink = window.location.origin + '/join?ref=' + encodeURIComponent(inv.code);
      const card = el(`
        <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
          <h2 class="font-semibold mb-1">Invite friends</h2>
          <p class="text-sm text-zinc-500 mb-3">Share your link. When someone you invite finishes ${inv.qualification_quests} quests, you get +${inv.xp_reward} XP.</p>
          <div class="flex flex-col sm:flex-row gap-2">
            <input readonly value="${escapeHtml(joinLink)}" class="invite-link flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm text-zinc-300 focus:outline-none">
            <button class="copy shrink-0 font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Copy link</button>
          </div>
          ${inv.referrals.length ? `<p class="text-xs text-zinc-600 mt-3">${inv.referrals.length} invited · ${inv.referrals.filter(r => r.status === 'qualified').length} qualified</p>` : ''}
        </div>`);
      card.querySelector('.copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(joinLink); toast('Invite link copied'); }
        catch { card.querySelector('.invite-link').select(); document.execCommand('copy'); toast('Invite link copied'); }
      });
      inviteSlot.appendChild(card);
    }
  }
}

// ---------- leaderboard ----------
async function viewLeaderboard(params) {
  const by = params.get('by') === 'points' ? 'points' : 'xp';
  const seasonParam = params.get('season') || '';
  const wrap = el('<div></div>');
  mount(wrap);
  wrap.appendChild(el(`
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-2xl font-bold">Leaderboard</h1>
      <div class="flex gap-1 bg-zinc-900 rounded-full p-1 border border-zinc-800">
        <a href="/leaderboard?by=xp${seasonParam ? '&season=' + encodeURIComponent(seasonParam) : ''}" class="px-4 py-1.5 rounded-full text-sm font-medium ${by === 'xp' ? 'bg-violet-600 text-white' : 'text-zinc-400'}">XP</a>
        <a href="/leaderboard?by=points" class="px-4 py-1.5 rounded-full text-sm font-medium ${by === 'points' ? 'bg-violet-600 text-white' : 'text-zinc-400'}">Points</a>
      </div>
    </div>`));
  // Season picker (Phase 3): seasons only affect the XP board.
  let seasonRow = null;
  if (by === 'xp') {
    try {
      const s = await window.QuestoraAPI.api.get('/api/v1/seasons');
      if (s.seasons.length) {
        seasonRow = el('<div class="flex flex-wrap gap-2 mb-4"></div>');
        const chip = (label, slug, on) => {
          const href = slug ? `/leaderboard?by=xp&season=${encodeURIComponent(slug)}` : '/leaderboard?by=xp';
          return el(`<a href="${href}" class="px-3 py-1.5 rounded-full text-xs font-medium border ${on ? 'bg-violet-600 border-violet-600 text-white' : 'bg-zinc-900 border-zinc-800 text-zinc-400'}">${escapeHtml(label)}</a>`);
        };
        seasonRow.appendChild(chip('All time', '', !seasonParam));
        for (const sn of s.seasons) {
          const mult = sn.xp_multiplier ? ` · ${sn.xp_multiplier}x XP` : '';
          seasonRow.appendChild(chip(sn.name + mult, sn.slug, seasonParam === sn.slug));
        }
        wrap.appendChild(seasonRow);
      }
    } catch { /* seasons list is optional chrome */ }
  }
  let data;
  try {
    data = await window.QuestoraAPI.api.get(
      '/api/v1/leaderboard?by=' + by + (seasonParam ? '&season=' + encodeURIComponent(seasonParam) : ''));
  }
  catch (err) { wrap.appendChild(el(`<p class="text-zinc-400">${escapeHtml(err.message)}</p>`)); return; }
  if (data.season) {
    wrap.appendChild(el(`<p class="text-xs text-zinc-600 mb-3">Season board: only XP earned during ${escapeHtml(data.season.name)} counts. This season awards ${data.season.xp_multiplier}x XP.</p>`));
  }
  if (!data.entries.length) {
    wrap.appendChild(el('<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center"><p class="text-zinc-400 mb-1">No entries yet.</p><p class="text-sm text-zinc-600">Complete a quest to appear here.</p></div>'));
    return;
  }
  const list = el('<div class="space-y-2"></div>');
  data.entries.forEach((e, i) => {
    list.appendChild(el(`
      <a href="/u/${encodeURIComponent(e.username)}" class="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40 transition-colors">
        <span class="w-8 text-center font-bold ${i === 0 ? 'text-violet-300' : 'text-zinc-500'}">${i + 1}</span>
        <span class="w-8 h-8 rounded-full bg-violet-600/30 flex items-center justify-center text-xs font-bold text-violet-200">${escapeHtml((e.display_name || e.username).slice(0, 2).toUpperCase())}</span>
        <span class="min-w-0"><span class="block font-medium truncate">${escapeHtml(e.display_name || e.username)}</span><span class="block text-xs text-zinc-600">@${escapeHtml(e.username)}</span></span>
        <span class="ml-auto font-mono text-violet-300">${e.score.toLocaleString()}</span>
      </a>`));
  });
  wrap.appendChild(list);
  // Pin my own row when the top 50 does not include me.
  const meData = await loadMe();
  if (meData && meData.user && !data.entries.some(e => e.username === meData.user.username)) {
    try {
      const mine = await window.QuestoraAPI.api.get('/api/v1/users/' + encodeURIComponent(meData.user.username));
      const mu = mine.user || mine;
      if (mine.leaderboard_rank) {
        list.appendChild(el('<div class="flex items-center gap-4 px-4"><span class="text-xs text-zinc-600">···</span></div>'));
        list.appendChild(el(`
          <a href="/u/${encodeURIComponent(meData.user.username)}" class="flex items-center gap-4 rounded-xl border border-violet-500/40 bg-violet-600/10 px-4 py-3">
            <span class="w-8 text-center font-bold text-violet-300">${mine.leaderboard_rank}</span>
            <span class="w-8 h-8 rounded-full bg-violet-600/30 flex items-center justify-center text-xs font-bold text-violet-200">${escapeHtml((meData.user.display_name || meData.user.username).slice(0, 2).toUpperCase())}</span>
            <span class="min-w-0"><span class="block font-medium truncate">You</span><span class="block text-xs text-zinc-600">@${escapeHtml(meData.user.username)}</span></span>
            <span class="ml-auto font-mono text-violet-300">${(by === 'points' ? mu.points : mu.xp).toLocaleString()}</span>
          </a>`));
      }
    } catch { /* pinning is optional chrome */ }
  }
}

// ---------- teams ----------
async function viewTeams(params) {
  const wrap = el('<div></div>');
  mount(wrap);
  wrap.appendChild(el('<h1 class="text-2xl font-bold mb-4">Teams</h1>'));
  const mySlot = el('<div class="mb-6"></div>');
  const boardSlot = el('<div></div>');
  wrap.appendChild(mySlot);
  wrap.appendChild(boardSlot);
  const meData = await loadMe();

  async function refresh() {
    // My team card (or the create/join forms when not in one).
    let mine = null;
    try { mine = await window.QuestoraAPI.api.get('/api/v1/teams/mine'); }
    catch { mine = null; }
    mySlot.replaceChildren();
    if (mine && mine.team) {
      const t = mine.team;
      const isOwner = meData && meData.user && t.owner_user_id === meData.user.id;
      const card = el(`
        <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
          <div class="flex items-start justify-between gap-3 mb-3">
            <div class="min-w-0">
              <h2 class="font-semibold truncate">${escapeHtml(t.name)}</h2>
              ${t.tagline ? `<p class="text-sm text-zinc-500 truncate">${escapeHtml(t.tagline)}</p>` : ''}
            </div>
            ${isOwner ? statePill('active') : ''}
          </div>
          <div class="rounded-xl bg-zinc-800/60 px-4 py-3 mb-4 flex items-center justify-between gap-2">
            <div class="min-w-0"><span class="block text-xs text-zinc-500">Join code</span>
            <span class="font-mono text-sm text-zinc-200">${escapeHtml(t.join_code)}</span></div>
            <button class="copy shrink-0 font-medium px-3 py-2 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Copy code</button>
          </div>
          <div class="members space-y-2 mb-4"></div>
          <div class="actions flex gap-2"></div>
        </div>`);
      card.querySelector('.copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(t.join_code); toast('Join code copied'); }
        catch { toast('Could not copy the code'); }
      });
      const members = card.querySelector('.members');
      for (const m of (mine.members || [])) {
        members.appendChild(el(`
          <a href="/u/${encodeURIComponent(m.username)}" class="flex items-center justify-between rounded-xl border border-zinc-800 px-4 py-3">
            <span class="min-w-0"><span class="block text-sm font-medium truncate">${escapeHtml(m.display_name || m.username)}${m.role === 'owner' ? ' <span class="text-xs text-violet-300">owner</span>' : ''}</span>
            <span class="block text-xs text-zinc-600">@${escapeHtml(m.username)}</span></span>
            <span class="font-mono text-sm text-violet-300">${Number(m.xp).toLocaleString()} XP</span>
          </a>`));
      }
      const actions = card.querySelector('.actions');
      const act = (label, fn, cls) => {
        const b = el(`<button class="font-medium px-4 py-2.5 min-h-[44px] rounded-lg text-sm ${cls || 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'}">${escapeHtml(label)}</button>`);
        b.addEventListener('click', async () => {
          try { await fn(); await refresh(); }
          catch (err) { toast(err.message || 'Something went wrong'); }
        });
        return b;
      };
      if (isOwner) {
        actions.appendChild(act('Disband team', async () => {
          await window.QuestoraAPI.api.post('/api/v1/teams/disband', {});
          toast('Team disbanded');
        }, 'bg-red-600/90 hover:bg-red-500 text-white'));
      } else {
        actions.appendChild(act('Leave team', async () => {
          await window.QuestoraAPI.api.post('/api/v1/teams/leave', {});
          toast('You left the team');
        }));
      }
      mySlot.appendChild(card);
    } else {
      const forms = el(`
        <div class="grid md:grid-cols-2 gap-3 mb-1">
          <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
            <h2 class="font-semibold mb-1">Create a team</h2>
            <p class="text-sm text-zinc-500 mb-3">One team per account.</p>
            <input placeholder="Team name" class="t-name w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm text-zinc-200 focus:outline-none mb-2">
            <input placeholder="Tagline (optional)" class="t-tagline w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm text-zinc-200 focus:outline-none mb-3">
            <button class="create font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm w-full">Create team</button>
          </div>
          <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
            <h2 class="font-semibold mb-1">Join with a code</h2>
            <p class="text-sm text-zinc-500 mb-3">Ask a team owner for their join code.</p>
            <input placeholder="Join code" class="t-code w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm font-mono text-zinc-200 focus:outline-none mb-3">
            <button class="join font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm w-full">Join team</button>
          </div>
        </div>`);
      const val = sel => { const n = forms.querySelector(sel); return n ? n.value.trim() : ''; };
      forms.querySelector('.create').addEventListener('click', async () => {
        try {
          await window.QuestoraAPI.api.post('/api/v1/teams', { name: val('.t-name'), tagline: val('.t-tagline') || undefined });
          toast('Team created');
          await refresh();
        } catch (err) { toast(err.message || 'Could not create the team'); }
      });
      forms.querySelector('.join').addEventListener('click', async () => {
        try {
          await window.QuestoraAPI.api.post('/api/v1/teams/join', { code: val('.t-code') });
          toast('You joined the team');
          await refresh();
        } catch (err) { toast(err.message || 'Could not join'); }
      });
      mySlot.appendChild(forms);
    }

    // Team board.
    let board = { teams: [] };
    try { board = await window.QuestoraAPI.api.get('/api/v1/teams'); }
    catch { board = { teams: [] }; }
    boardSlot.replaceChildren();
    boardSlot.appendChild(el('<h2 class="font-semibold mb-3">All teams</h2>'));
    if (!board.teams.length) {
      boardSlot.appendChild(el('<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center"><p class="text-zinc-400 mb-1">No teams yet.</p><p class="text-sm text-zinc-600">Create one above to start the board.</p></div>'));
      return;
    }
    const list = el('<div class="space-y-2"></div>');
    board.teams.forEach((t, i) => {
      list.appendChild(el(`
        <div class="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <span class="w-8 text-center font-bold ${i === 0 ? 'text-violet-300' : 'text-zinc-500'}">${i + 1}</span>
          <span class="min-w-0"><span class="block font-medium truncate">${escapeHtml(t.name)}</span>
          <span class="block text-xs text-zinc-600">${t.members} member${t.members === 1 ? '' : 's'}${t.tagline ? ' · ' + escapeHtml(t.tagline) : ''}</span></span>
          <span class="ml-auto font-mono text-violet-300">${Number(t.xp).toLocaleString()} XP</span>
        </div>`));
    });
    boardSlot.appendChild(list);
  }
  await refresh();
}

// ---------- create wizard ----------
const CATEGORY_LIST = ['DeFi', 'Gaming', 'AI', 'Infrastructure', 'Developer', 'NFT', 'Social', 'Education', 'Community'];

async function viewCreate() {
  const wrap = el('<div></div>');
  mount(wrap);
  wrap.appendChild(el('<h1 class="text-2xl font-bold mb-1">Create</h1><p class="text-sm text-zinc-500 mb-6">Start a project, add a campaign, then build its quests.</p>'));
  const meData = await loadMe();
  const form = el(`
    <div class="max-w-xl space-y-8">
      <section class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h2 class="font-semibold mb-1">1. Project</h2>
        <p class="text-sm text-zinc-500 mb-4">Your project is your home on Questora.</p>
        <div class="space-y-3">
          <input class="pj-name w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" placeholder="Project name">
          <textarea class="pj-desc w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" rows="2" placeholder="What does your project do?"></textarea>
          <input class="pj-web w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" placeholder="Website (optional)">
        </div>
      </section>
      <section class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h2 class="font-semibold mb-1">2. Campaign</h2>
        <p class="text-sm text-zinc-500 mb-4">Campaigns group quests and go live on publish.</p>
        <div class="space-y-3">
          <input class="cp-name w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" placeholder="Campaign name">
          <textarea class="cp-desc w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" rows="2" placeholder="Describe the campaign"></textarea>
          <select class="cp-cat w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm focus:outline-none focus:border-violet-500">
            ${CATEGORY_LIST.map(c => `<option>${c}</option>`).join('')}
          </select>
        </div>
      </section>
      <section class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h2 class="font-semibold mb-1">3. Quest</h2>
        <p class="text-sm text-zinc-500 mb-4">A quest is a checklist of tasks. You can add more later.</p>
        <div class="space-y-3">
          <input class="q-title w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" placeholder="Quest title">
          <input class="q-xp w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" type="number" min="0" placeholder="XP reward (e.g. 100)">
          <div class="task-config rounded-xl border border-zinc-800 p-4">
            <label class="block text-xs text-zinc-500 mb-2">Task type</label>
            <select class="task-type w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm focus:outline-none focus:border-violet-500">
              <option value="social">Social link (visit and confirm)</option>
              <option value="url_proof">Submit proof (URL)</option>
              <option value="quiz">Quiz</option>
              <option value="wallet_connect">Connect wallet</option>
              <option value="manual">Manual review</option>
            </select>
            <div class="task-extra mt-3"></div>
          </div>
          <input class="q-cred w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" placeholder="Credential title (optional, e.g. Basics Certified)">
        </div>
      </section>
      <button class="publish w-full font-semibold px-5 py-3 min-h-[48px] rounded-xl bg-violet-600 hover:bg-violet-500 text-white">Publish campaign</button>
      <p class="hint text-sm text-zinc-500"></p>
    </div>`);
  wrap.appendChild(form);
  const extra = form.querySelector('.task-extra');
  const typeSel = form.querySelector('.task-type');
  function renderExtra() {
    extra.replaceChildren();
    const t = typeSel.value;
    if (t === 'social') {
      extra.appendChild(el('<input class="t-url w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" placeholder="Link to visit (https://...)">'));
    } else if (t === 'url_proof') {
      extra.appendChild(el('<p class="text-sm text-zinc-500">Users submit a URL. You review it in your project queue.</p>'));
    } else if (t === 'quiz') {
      extra.appendChild(el(`
        <div class="quiz-builder space-y-2">
          <input class="qq-text w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" placeholder="Question text">
          <p class="text-xs text-zinc-500">Options. Mark the correct one.</p>
          <div class="qq-opts space-y-2"></div>
          <button type="button" class="qq-add text-sm font-medium text-violet-400">Add option</button>
          <p class="text-sm text-zinc-500">Users must score at least 80% to pass.</p>
        </div>`));
      const opts = extra.querySelector('.qq-opts');
      const addOpt = () => {
        opts.appendChild(el(`
          <div class="flex items-center gap-2 qq-row">
            <input type="radio" name="qq-correct" class="w-4 h-4 accent-violet-500 shrink-0" aria-label="Mark this option as the correct answer">
            <input class="qq-opt flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" placeholder="Option ${opts.children.length + 1}">
          </div>`));
      };
      addOpt(); addOpt();
      extra.querySelector('.qq-add').addEventListener('click', addOpt);
    } else if (t === 'wallet_connect') {
      extra.appendChild(el('<p class="text-sm text-zinc-500">Users sign a message with their browser wallet. Verified automatically.</p>'));
    } else {
      extra.appendChild(el('<p class="text-sm text-zinc-500">Users write a short proof. You approve or reject it.</p>'));
    }
  }
  typeSel.addEventListener('change', renderExtra);
  renderExtra();

  form.querySelector('.publish').addEventListener('click', async () => {
    const btn = form.querySelector('.publish');
    const hint = form.querySelector('.hint');
    btn.disabled = true; btn.textContent = 'Publishing…'; hint.textContent = '';
    try {
      const v = (s) => form.querySelector(s).value.trim();
      const proj = await window.QuestoraAPI.api.post('/api/v1/projects', { name: v('.pj-name'), description: v('.pj-desc'), website: v('.pj-web') || undefined });
      const camp = await window.QuestoraAPI.api.post(`/api/v1/projects/${proj.project.id}/campaigns`, {
        name: v('.cp-name'), description: v('.cp-desc'), category: form.querySelector('.cp-cat').value, status: 'active',
      });
      const type = typeSel.value;
      const task = { type, title: 'Task', config: {} };
      if (type === 'social') task.config = { url: v('.t-url'), action: 'visit' };
      if (type === 'quiz') {
        const qText = v('.qq-text');
        let answer = -1;
        const options = [];
        form.querySelectorAll('.qq-row').forEach((row) => {
          const val = row.querySelector('.qq-opt').value.trim();
          if (!val) return;
          if (row.querySelector('input[name="qq-correct"]').checked) answer = options.length;
          options.push(val);
        });
        if (!qText) throw new Error('The question text is required');
        if (options.length < 2) throw new Error('The question needs at least two non-empty options');
        if (answer < 0) throw new Error('Mark one option as the correct answer');
        task.config = { pass_score: 80, questions: [{ q: qText, options, answer }] };
      }
      const quest = await window.QuestoraAPI.api.post(`/api/v1/campaigns/${camp.campaign.id}/quests`, {
        title: v('.q-title'), xp_reward: parseInt(v('.q-xp'), 10) || 0, points_reward: Math.round((parseInt(v('.q-xp'), 10) || 0) / 2), tasks: [task],
        credential_title: v('.q-cred') || undefined,
      });
      toast('Project created');
      // The creator is the project owner, so land them in their new
      // dashboard immediately rather than on the public page.
      location.hash = '';
      window.history.pushState({}, '', '/dashboard/projects/' + encodeURIComponent(proj.project.slug));
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (err) {
      hint.textContent = err.message;
      hint.className = 'hint text-sm text-red-400';
      btn.disabled = false; btn.textContent = 'Publish campaign';
    }
  });
}

// ---------- project (owner view) ----------
async function viewProject(slug, params) {
  params = params || new URLSearchParams();
  const wrap = el('<div class="animate-pulse space-y-3"><div class="h-24 rounded-2xl bg-zinc-900"></div></div>');
  mount(wrap);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/projects/' + encodeURIComponent(slug)); }
  catch (err) { mount(errorCard(err.message)); return; }
  const p = data.project;
  const node = el(`
    <div>
      <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 mb-6">
        <h1 class="text-2xl font-bold mb-1">${escapeHtml(p.name)}</h1>
        <p class="text-sm text-zinc-400 mb-3 max-w-2xl">${escapeHtml(p.description || '')}</p>
        <div class="flex flex-wrap gap-2">${badgePill(data.campaigns.length + ' campaigns')}</div>
      </div>
      <div class="tabs flex gap-2 mb-4">
        <button data-tab="campaigns" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Campaigns</button>
        <button data-tab="points" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Points</button>
        <button data-tab="review" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Review queue</button>
        <button data-tab="analytics" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Analytics</button>
      </div>
      <div class="tab-body"></div>
    </div>`);
  mount(node);
  const body = node.querySelector('.tab-body');

  async function show(tab) {
    node.querySelectorAll('.tab').forEach(b => {
      const on = b.dataset.tab === tab;
      b.className = 'tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium ' + (on ? 'bg-violet-600 text-white' : 'bg-zinc-800/70 text-zinc-400');
    });
    body.replaceChildren();
    if (tab === 'points') {
      body.appendChild(el('<p class="text-sm text-zinc-500 animate-pulse">Loading points…</p>'));
      let lb;
      try { lb = await window.QuestoraAPI.api.get(`/api/v1/projects/${p.id}/leaderboard`); }
      catch (err) { body.replaceChildren(el(`<p class="text-sm text-red-400">${escapeHtml(err.message)}</p>`)); return; }
      body.replaceChildren();
      if (!lb.entries.length) {
        body.appendChild(el(`<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center"><p class="text-zinc-400 mb-1">No points earned yet.</p><p class="text-sm text-zinc-600">Complete quests from this project's campaigns to appear on its board.</p></div>`));
        return;
      }
      if (lb.system && lb.system.name) {
        body.appendChild(el(`<p class="text-xs text-zinc-600 mb-2 px-1">${escapeHtml(lb.system.name)}</p>`));
      }
      const list = el('<div class="space-y-2"></div>');
      lb.entries.forEach((e, i) => {
        list.appendChild(el(`
          <a href="/u/${encodeURIComponent(e.username)}" class="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40 transition-colors">
            <span class="w-8 text-center font-bold ${i === 0 ? 'text-violet-300' : 'text-zinc-500'}">${i + 1}</span>
            <span class="min-w-0"><span class="block font-medium truncate">${escapeHtml(e.display_name || e.username)}</span><span class="block text-xs text-zinc-600">@${escapeHtml(e.username)}</span></span>
            <span class="ml-auto font-mono text-violet-300">${e.score.toLocaleString()}</span>
          </a>`));
      });
      body.appendChild(list);
      return;
    }
    if (tab === 'campaigns') {
      if (!data.campaigns.length) { body.appendChild(el('<p class="text-sm text-zinc-600 px-1">No campaigns yet. Create one from the Create page.</p>')); return; }
      const grid = el('<div class="grid md:grid-cols-3 gap-4"></div>');
      for (const c of data.campaigns) {
        grid.appendChild(campaignCard({ ...c, project_name: p.name, total_xp: 0, participants: 0, quest_count: Number(c.quest_count) }));
      }
      body.appendChild(grid);
    } else if (tab === 'review') {
      body.appendChild(el('<p class="text-sm text-zinc-500 animate-pulse">Loading queue…</p>'));
      let rev;
      try { rev = await window.QuestoraAPI.api.get(`/api/v1/projects/${p.id}/review`); }
      catch (err) { body.replaceChildren(el(`<p class="text-sm text-red-400">${escapeHtml(err.message)}</p>`)); return; }
      body.replaceChildren();
      if (!rev.submissions.length) { body.appendChild(el('<p class="text-sm text-zinc-600 px-1">Nothing waiting for review. All clear.</p>')); return; }
      const list = el('<div class="space-y-3"></div>');
      for (const s of rev.submissions) {
        const row = el(`
          <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-sm font-medium">@${escapeHtml(s.username)}</span>
              <span class="text-xs text-zinc-600">· ${escapeHtml(s.task_title || s.task_type)} · ${escapeHtml(s.quest_title)}</span>
            </div>
            ${s.proof_url ? `<a href="${escapeHtml(s.proof_url)}" target="_blank" rel="noopener" class="text-sm text-violet-300 break-all hover:underline">${escapeHtml(s.proof_url)}</a>` : ''}
            ${s.proof_data && s.proof_data.text ? `<p class="text-sm text-zinc-300 mt-1">${escapeHtml(s.proof_data.text)}</p>` : ''}
            <div class="flex gap-2 mt-3">
              <button class="approve text-sm font-medium px-4 py-2 min-h-[44px] rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white">Approve</button>
              <button class="reject text-sm font-medium px-4 py-2 min-h-[44px] rounded-lg bg-zinc-800 hover:bg-red-600 text-zinc-200">Reject</button>
            </div>
            <div class="reject-reason mt-2"></div>
          </div>`);
        row.querySelector('.approve').addEventListener('click', async () => {
          try { await window.QuestoraAPI.api.post(`/api/v1/submissions/${s.id}/review`, { decision: 'verified' }); toast('Approved'); show('review'); }
          catch (err) { toast(err.message, true); }
        });
        row.querySelector('.reject').addEventListener('click', () => {
          const zone = row.querySelector('.reject-reason');
          if (zone.querySelector('input')) return;
          const input = el('<input class="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500" placeholder="Reason (required)">');
          const confirm = el('<button class="mt-2 text-sm font-medium px-4 py-2 min-h-[44px] rounded-lg bg-red-600 hover:bg-red-500 text-white">Confirm reject</button>');
          confirm.addEventListener('click', async () => {
            const reason = input.value.trim();
            if (!reason) return toast('A reason is required', true);
            try { await window.QuestoraAPI.api.post(`/api/v1/submissions/${s.id}/review`, { decision: 'rejected', reason }); toast('Rejected'); show('review'); }
            catch (err) { toast(err.message, true); }
          });
          zone.appendChild(input); zone.appendChild(confirm);
        });
        list.appendChild(row);
      }
      body.appendChild(list);
    } else {
      body.appendChild(el('<p class="text-sm text-zinc-500 animate-pulse">Loading analytics…</p>'));
      let an;
      try { an = await window.QuestoraAPI.api.get(`/api/v1/projects/${p.id}/analytics`); }
      catch (err) { body.replaceChildren(el(`<p class="text-sm text-red-400">${escapeHtml(err.message)}</p>`)); return; }
      body.replaceChildren();
      const stats = el(`
        <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
          <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"><p class="text-xs text-zinc-500">Participants</p><p class="text-xl font-bold">${an.participants}</p></div>
          <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"><p class="text-xs text-zinc-500">XP distributed</p><p class="text-xl font-bold text-violet-300">${an.xp_distributed.toLocaleString()}</p></div>
          <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"><p class="text-xs text-zinc-500">Quests</p><p class="text-xl font-bold">${an.quests.length}</p></div>
        </div>`);
      body.appendChild(stats);
      const list = el('<div class="space-y-2"></div>');
      for (const q of an.quests) {
        const rate = q.submissions ? Math.round((q.completions / q.submissions) * 100) : 0;
        list.appendChild(el(`<div class="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3"><span class="text-sm">${escapeHtml(q.title)}</span><span class="text-sm text-zinc-400">${q.completions} completed · ${rate}% conversion</span></div>`));
      }
      body.appendChild(list);
    }
  }
  node.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
  const startTab = params.get('tab');
  show(['campaigns', 'points', 'review', 'analytics'].includes(startTab) ? startTab : 'campaigns');
}

// ---------- projects directory ----------
async function viewProjects() {
  const wrap = el('<div></div>');
  mount(wrap);
  wrap.appendChild(el('<h1 class="text-2xl font-bold mb-1">Projects</h1><p class="text-sm text-zinc-500 mb-5">Every project on Questora, with its campaigns and quests.</p>'));
  const body = el('<div class="space-y-2"></div>');
  wrap.appendChild(body);
  body.appendChild(el('<p class="text-sm text-zinc-500 animate-pulse">Loading projects\u2026</p>'));
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/projects/directory'); }
  catch (err) { body.replaceChildren(el(`<p class="text-sm text-red-400">${escapeHtml(err.message)}</p>`)); return; }
  body.replaceChildren();
  const rows = data.projects || [];
  if (!rows.length) {
    body.replaceChildren(el(emptyState("There are no projects yet. Create the first one to get started.", 'Create a project', '/create')));
    return;
  }
  for (const p of rows) {
    body.appendChild(el(`
      <a href="/projects/${encodeURIComponent(p.slug)}" class="block rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40 transition-colors">
        <div class="flex items-center gap-3">
          <span class="min-w-0 flex-1">
            <span class="block font-medium truncate">${escapeHtml(p.name)}</span>
            <span class="block text-xs text-zinc-600 truncate">${escapeHtml(p.description || '')}</span>
          </span>
          <span class="shrink-0 text-xs text-zinc-500">${p.campaign_count} campaigns \u00b7 ${p.quest_count} quests</span>
          <span class="shrink-0 text-sm text-violet-300 font-medium">${Number(p.total_xp).toLocaleString()} XP</span>
        </div>
      </a>`));
  }
}

// ---------- project overview ----------
// Loads a project and its campaigns; every hierarchical screen goes through
// it so breadcrumb labels and scoping come from one place.
async function loadProjectView(slug) {
  const data = await window.QuestoraAPI.api.get('/api/v1/projects/' + encodeURIComponent(slug));
  return data;
}

function projectCrumb(p) { return { label: p.name, href: '/projects/' + encodeURIComponent(p.slug) }; }

async function viewProjectOverview(slug, params, legacyTab) {
  params = params || new URLSearchParams();
  const wrap = el('<div class="animate-pulse space-y-3"><div class="h-24 rounded-2xl bg-zinc-900"></div></div>');
  mount(wrap);
  let data;
  try { data = await loadProjectView(slug); }
  catch (err) { mount(errorCard(err.message)); return; }
  const p = data.project;
  let tab = legacyTab || params.get('tab') || 'overview';
  if (tab === 'points') tab = 'leaderboard';
  if (!['overview', 'leaderboard', 'campaigns'].includes(tab)) tab = 'overview';
  const node = el(`
    <div>
      ${breadcrumb([{ label: 'Projects', href: '/projects' }, { label: p.name }])}
      <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 mb-4">
        <div class="flex items-start justify-between gap-4 flex-wrap">
          <div class="min-w-0">
            <h1 class="text-2xl font-bold mb-1">${escapeHtml(p.name)}</h1>
            <p class="text-sm text-zinc-400 max-w-2xl">${escapeHtml(p.description || '')}</p>
            <div class="flex flex-wrap gap-2 mt-3">
              ${badgePill(data.campaigns.length + ' campaigns')}
              ${badgePill(data.campaigns.reduce((n, c) => n + (c.quests ? c.quests.length : 0), 0) + ' quests')}
            </div>
          </div>
          <div class="shrink-0">
            ${data.can_manage
              ? `<a href="/dashboard/projects/${encodeURIComponent(p.slug)}" class="inline-block font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Manage</a>`
              : `<a href="#campaigns" data-jump="campaigns" class="inline-block font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Explore campaigns</a>`}
          </div>
        </div>
      </div>
      <div class="tabs flex gap-2 mb-4 overflow-x-auto">
        <button data-tab="overview" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Overview</button>
        <button data-tab="leaderboard" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Leaderboard</button>
        <button data-tab="campaigns" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Campaigns</button>
      </div>
      <div class="tab-body"></div>
    </div>`);
  mount(node);
  const body = node.querySelector('.tab-body');
  showTab(tab);

  function showTab(name) {
    node.querySelectorAll('.tab').forEach(b => {
      const on = b.dataset.tab === name;
      b.className = 'tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium ' + (on ? 'bg-violet-600 text-white' : 'bg-zinc-800/70 text-zinc-400');
    });
    body.replaceChildren();
    if (name === 'leaderboard') return renderProjectBoard(body, p);
    if (name === 'campaigns') return renderProjectCampaigns(body, p, data);
    return renderProjectSummary(body, p, data);
  }
  node.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  const jump = node.querySelector('[data-jump]');
  if (jump) jump.addEventListener('click', (e) => { e.preventDefault(); showTab('campaigns'); });
}

function renderProjectSummary(body, p, data) {
  const active = data.campaigns.filter(c => c.status === 'active');
  if (!data.campaigns.length) {
    body.appendChild(el(emptyState("This project doesn't have any campaigns yet.", data.can_manage ? 'Create campaign' : 'Explore projects', data.can_manage ? '/dashboard/projects/' + encodeURIComponent(p.slug) + '/campaigns' : '/projects')));
    return;
  }
  body.appendChild(el(`<p class="text-sm text-zinc-500 mb-3">${active.length} active ${active.length === 1 ? 'campaign' : 'campaigns'} of ${data.campaigns.length}.</p>`));
  const list = el('<div class="space-y-2"></div>');
  for (const c of data.campaigns.slice(0, 6)) {
    list.appendChild(el(`
      <a href="/projects/${encodeURIComponent(p.slug)}/campaigns/${encodeURIComponent(c.slug)}" class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40 transition-colors">
        <span class="min-w-0 flex-1"><span class="block font-medium truncate">${escapeHtml(c.name)}</span>
        <span class="block text-xs text-zinc-600">${(c.quests || []).length} quests \u00b7 ${c.participants || 0} participants</span></span>
        ${statePill(c.status)}
      </a>`));
  }
  body.appendChild(list);
}

function renderProjectCampaigns(body, p, data) {
  if (!data.campaigns.length) {
    body.appendChild(el(emptyState("This project doesn't have any campaigns yet.", data.can_manage ? 'Create campaign' : 'Explore projects', data.can_manage ? '/dashboard/projects/' + encodeURIComponent(p.slug) + '/campaigns' : '/projects')));
    return;
  }
  const list = el('<div class="space-y-2"></div>');
  for (const c of data.campaigns) {
    const quests = c.quests || [];
    const card = el(`
      <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div class="flex items-center gap-3">
          <a href="/projects/${encodeURIComponent(p.slug)}/campaigns/${encodeURIComponent(c.slug)}" class="min-w-0 flex-1">
            <span class="block font-medium truncate">${escapeHtml(c.name)}</span>
            <span class="block text-xs text-zinc-600">${quests.length} quests \u00b7 ${c.participants || 0} participants</span>
          </a>
          ${statePill(c.status)}
          <a href="/projects/${encodeURIComponent(p.slug)}/campaigns/${encodeURIComponent(c.slug)}/leaderboard" class="shrink-0 text-xs text-violet-300">Leaderboard</a>
        </div>
        <div class="quest-rows mt-3 space-y-1"></div>
      </div>`);
    const holder = card.querySelector('.quest-rows');
    if (!quests.length) holder.appendChild(el('<p class="text-xs text-zinc-600">This campaign doesn\'t have any quests yet.</p>'));
    for (const q of quests) {
      const qid = q.slug || q.id;
      holder.appendChild(el(`
        <a href="/projects/${encodeURIComponent(p.slug)}/campaigns/${encodeURIComponent(c.slug)}/quests/${encodeURIComponent(qid)}" class="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-800/60">
          <span class="min-w-0 flex-1 truncate text-sm text-zinc-300">${escapeHtml(q.title)}</span>
          <span class="text-xs text-zinc-600">${escapeHtml(q.quest_type || '')}</span>
          <span class="text-xs text-violet-300">+${q.xp_reward} XP</span>
        </a>`));
    }
    list.appendChild(card);
  }
  body.appendChild(list);
}

async function renderProjectBoard(body, p) {
  body.appendChild(el('<p class="text-sm text-zinc-500 animate-pulse">Loading leaderboard\u2026</p>'));
  let data;
  try { data = await window.QuestoraAPI.api.get(`/api/v1/projects/${p.id}/leaderboard?metric=points`); }
  catch (err) { body.replaceChildren(el(`<p class="text-sm text-red-400">${escapeHtml(err.message)}</p>`)); return; }
  body.replaceChildren();
  body.appendChild(el(`<a href="/projects/${encodeURIComponent(p.slug)}/leaderboard" class="text-sm text-violet-300">Open the full project leaderboard</a>`));
  if (!data.entries.length) {
    body.appendChild(el(emptyState('No participants have earned points yet.')));
    return;
  }
  const list = el('<div class="space-y-2 mt-3"></div>');
  data.entries.slice(0, 10).forEach((e, i) => list.appendChild(leaderboardRow(e, i)));
  body.appendChild(list);
}

function leaderboardRow(e, i) {
  return el(`
    <a href="/u/${encodeURIComponent(e.username)}" class="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40 transition-colors">
      <span class="w-8 text-center font-bold ${i === 0 ? 'text-violet-300' : 'text-zinc-500'}">${i + 1}</span>
      <span class="w-8 h-8 rounded-full bg-violet-600/30 flex items-center justify-center text-xs font-bold text-violet-200">${escapeHtml((e.display_name || e.username).slice(0, 2).toUpperCase())}</span>
      <span class="min-w-0"><span class="block font-medium truncate">${escapeHtml(e.display_name || e.username)}</span><span class="block text-xs text-zinc-600">@${escapeHtml(e.username)}</span></span>
      <span class="ml-auto font-mono text-violet-300">${Number(e.score).toLocaleString()}</span>
    </a>`);
}

// ---------- project sub-pages ----------
async function viewProjectCampaigns(slug, params) {
  await viewProjectOverview(slug, params, 'campaigns');
}

async function viewProjectQuests(slug, params) {
  params = params || new URLSearchParams();
  const wrap = el('<div class="animate-pulse space-y-3"><div class="h-20 rounded-2xl bg-zinc-900"></div></div>');
  mount(wrap);
  let data;
  try { data = await loadProjectView(slug); }
  catch (err) { mount(errorCard(err.message)); return; }
  const p = data.project;
  const node = el(`
    <div>
      ${breadcrumb([{ label: 'Projects', href: '/projects' }, projectCrumb(p), { label: 'Quests' }])}
      <h1 class="text-2xl font-bold mb-4">Quests in ${escapeHtml(p.name)}</h1>
      <div class="space-y-4"></div>
    </div>`);
  mount(node);
  const holder = node.querySelector('.space-y-4');
  let any = false;
  for (const c of data.campaigns) {
    for (const q of (c.quests || [])) {
      any = true;
      const qid = q.slug || q.id;
      holder.appendChild(el(`
        <a href="/projects/${encodeURIComponent(p.slug)}/campaigns/${encodeURIComponent(c.slug)}/quests/${encodeURIComponent(qid)}" class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40">
          <span class="min-w-0 flex-1"><span class="block font-medium truncate">${escapeHtml(q.title)}</span>
          <span class="block text-xs text-zinc-600">${escapeHtml(c.name)}</span></span>
          ${statePill(q.status)}
          <span class="shrink-0 text-sm text-violet-300">+${q.xp_reward} XP</span>
        </a>`));
    }
  }
  if (!any) holder.appendChild(el(emptyState("This project doesn't have any quests yet.")));
}

// ---------- campaign detail (hierarchical) ----------
async function viewCampaignDetail(projectSlug, campaignSlug) {
  const wrap = el('<div class="animate-pulse space-y-4"><div class="h-32 rounded-2xl bg-zinc-900"></div></div>');
  mount(wrap);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/campaigns/' + encodeURIComponent(campaignSlug)); }
  catch (err) { mount(errorCard(err.message)); return; }
  const c = data.campaign;
  const pSlug = projectSlug || c.project_slug;
  const completedCount = data.quests.filter(q => q.completed).length;
  const totalQuests = data.quests.length;
  const pct = totalQuests ? Math.round((completedCount / totalQuests) * 100) : 0;
  const node = el(`
    <div>
      ${breadcrumb([{ label: 'Projects', href: '/projects' }, { label: c.project_name, href: '/projects/' + encodeURIComponent(pSlug) }, { label: c.name }])}
      <div class="rounded-2xl border border-zinc-800 bg-gradient-to-b from-violet-600/20 to-transparent p-6 mb-4">
        <div class="flex items-center gap-2 mb-2 text-sm text-zinc-400">
          ${statePill(c.status)}
          ${c.ends_at ? `<span class="inline-block text-xs px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-400">${timeLeft(c.ends_at)}</span>` : ''}
        </div>
        <h1 class="text-2xl font-bold mb-2">${escapeHtml(c.name)}</h1>
        <p class="text-sm text-zinc-300 mb-4 max-w-2xl">${escapeHtml(c.description || '')}</p>
        <div class="flex flex-wrap gap-2 text-xs">
          ${badgePill('+' + data.total_xp + ' XP')}
          ${data.total_points ? badgePill('+' + data.total_points + ' points') : ''}
          ${badgePill(data.participants + ' participants')}
        </div>
        ${totalQuests ? `<div class="mt-4"><div class="h-2 rounded-full bg-zinc-800 overflow-hidden"><div class="h-2 bg-violet-500" style="width:${pct}%"></div></div>
          <p class="text-xs text-zinc-500 mt-1">${completedCount}/${totalQuests} quests done</p></div>` : ''}
        <div class="flex flex-wrap gap-2 mt-4">
          <div class="join-slot"></div>
          <a href="/projects/${encodeURIComponent(pSlug)}/campaigns/${encodeURIComponent(c.slug)}/leaderboard" class="inline-block text-xs px-3 py-2.5 min-h-[44px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200">Campaign leaderboard</a>
        </div>
      </div>
      <h2 class="text-sm font-medium text-zinc-500 mb-2 px-1">Quests</h2>
      <div class="quest-list space-y-3"></div>
    </div>`);
  mount(node);

  if (data.joined === false && c.status === 'active') {
    const joinBtn = el('<button class="join font-medium px-5 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Join campaign</button>');
    joinBtn.addEventListener('click', async () => {
      joinBtn.disabled = true; joinBtn.textContent = 'Joining\u2026';
      try { await window.QuestoraAPI.api.post(`/api/v1/campaigns/${c.id}/join`, {}); toast('You joined the campaign'); viewCampaignDetail(pSlug, campaignSlug); }
      catch (err) { toast(err.message, true); joinBtn.disabled = false; joinBtn.textContent = 'Join campaign'; }
    });
    node.querySelector('.join-slot').appendChild(joinBtn);
  } else if (data.joined === true) {
    node.querySelector('.join-slot').appendChild(el('<span class="inline-block text-xs px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-300">Joined</span>'));
  }

  const list = node.querySelector('.quest-list');
  if (!totalQuests) list.appendChild(el(emptyState("This campaign doesn't have any quests yet.")));
  for (const q of data.quests) {
    const circle = q.completed
      ? '<span class="task-circle w-6 h-6 rounded-full border-2 border-emerald-400 bg-emerald-400/10 text-emerald-300 shrink-0 flex items-center justify-center text-xs">\u2713</span>'
      : q.locked
        ? '<span class="task-circle w-6 h-6 rounded-full border-2 border-zinc-700 bg-zinc-800/50 text-zinc-500 shrink-0 flex items-center justify-center text-xs">\ud83d\udd12</span>'
        : '<span class="task-circle w-6 h-6 rounded-full border-2 border-zinc-700 shrink-0 flex items-center justify-center"></span>';
    const qhref = '/projects/' + encodeURIComponent(pSlug) + '/campaigns/' + encodeURIComponent(c.slug) + '/quests/' + encodeURIComponent(q.slug || q.id);
    list.appendChild(el(`
      <a href="${qhref}" class="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 hover:border-violet-500/40 transition-colors p-4 ${q.locked && !q.completed ? 'opacity-60' : ''}">
        ${circle}
        <span class="min-w-0">
          <span class="block font-medium ${q.is_required ? 'text-zinc-100' : 'text-zinc-400'}">${escapeHtml(q.title)}${q.is_required ? '' : ' <span class="text-xs text-zinc-600">(optional)</span>'}</span>
          <span class="block text-sm text-zinc-500 truncate">${escapeHtml(q.description || '')}</span>
          ${q.locked && !q.completed ? `<span class="lock-reason block text-xs text-amber-300 mt-1">${escapeHtml(q.locked_reason || 'Locked')}</span>` : ''}
        </span>
        <span class="ml-auto text-sm text-violet-300 font-medium shrink-0">+${q.xp_reward} XP</span>
      </a>`));
  }
}

// Resolve a legacy flat /campaigns/:slug link to its owning project.
async function resolveCampaignPath(slug) {
  try {
    const data = await window.QuestoraAPI.api.get('/api/v1/campaigns/' + encodeURIComponent(slug));
    return { projectSlug: data.campaign.project_slug, campaign: data.campaign };
  } catch { return { projectSlug: null }; }
}

// ---------- quest detail (hierarchical) ----------
async function viewQuestDetail(projectSlug, campaignSlug, questSlug) {
  const wrap = el('<div class="animate-pulse space-y-3"><div class="h-8 w-2/3 rounded bg-zinc-900"></div></div>');
  mount(wrap);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/quests/' + encodeURIComponent(questSlug)); }
  catch (err) { mount(errorCard(err.message)); return; }
  const q = data.quest;
  const pSlug = projectSlug || q.project_slug;
  let states;
  try { states = await window.QuestoraAPI.api.get(`/api/v1/quests/${q.id}/my`); } catch { states = { states: [] }; }
  const stateByTask = {};
  for (const s of states.states || []) stateByTask[s.task_id] = s;

  const node = el(`
    <div>
      ${breadcrumb([{ label: 'Projects', href: '/projects' }, { label: q.project_name, href: '/projects/' + encodeURIComponent(pSlug) }, { label: q.campaign_name, href: '/projects/' + encodeURIComponent(pSlug) + '/campaigns/' + encodeURIComponent(campaignSlug || q.campaign_slug) }, { label: q.title }])}
      <h1 class="text-2xl font-bold mt-1 mb-1">${escapeHtml(q.title)}</h1>
      <p class="text-sm text-zinc-400 mb-4 max-w-2xl">${escapeHtml(q.description || '')}</p>
      <div class="flex flex-wrap gap-2 mb-4">${badgePill('+' + q.xp_reward + ' XP')}${q.points_reward ? badgePill('+' + q.points_reward + ' points') : ''}${badgePill(data.participants + ' participants')}${statePill(q.status)}</div>
      <div class="flex flex-wrap gap-2 mb-6">
        <a href="/projects/${encodeURIComponent(pSlug)}/campaigns/${encodeURIComponent(campaignSlug || q.campaign_slug)}/quests/${encodeURIComponent(q.slug || q.id)}/leaderboard" class="text-xs px-3 py-2.5 min-h-[44px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200">Quest leaderboard</a>
      </div>
      ${q.instructions ? `<div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 mb-6"><p class="text-sm text-zinc-300 whitespace-pre-line">${escapeHtml(q.instructions)}</p></div>` : ''}
      <div class="lock-banner mb-6"></div>
      <h2 class="text-sm font-medium text-zinc-500 mb-2 px-1">Tasks</h2>
      <div class="task-list space-y-3"></div>
    </div>`);
  mount(node);
  if (q.locked) {
    node.querySelector('.lock-banner').appendChild(el(`<div class="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4"><p class="text-sm text-amber-200">${escapeHtml(q.locked_reason || 'This quest is locked.')}</p></div>`));
  }
  const list = node.querySelector('.task-list');
  for (const t of data.tasks) {
    const st = stateByTask[t.id];
    const status = st ? st.status : null;
    const stateCls = status === 'verified' ? 'border-emerald-400 bg-emerald-400/10'
      : status === 'pending' ? 'border-amber-400 bg-amber-400/10'
      : status === 'rejected' ? 'border-red-400 bg-red-400/10' : 'border-zinc-700';
    const row = el(`
      <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div class="flex items-start gap-3">
          <span class="task-state w-6 h-6 rounded-full border-2 ${stateCls} shrink-0 mt-0.5 flex items-center justify-center text-xs">${status === 'verified' ? '\u2713' : status === 'rejected' ? '\u2715' : ''}</span>
          <div class="min-w-0 flex-1">
            <p class="font-medium">${escapeHtml(t.title)}</p>
            <p class="text-xs text-zinc-500">${escapeHtml(TASK_LABEL[t.type] || t.type)}${t.proof_required ? ' \u00b7 proof required' : ''}</p>
            <div class="status-line mt-1">${status ? statePill(status) : ''}</div>
            ${status === 'rejected' && st.review_note ? `<p class="text-sm text-red-300 mt-1">${escapeHtml(st.review_note)}</p>` : ''}
            <div class="action-area mt-3"></div>
          </div>
        </div>
      </div>`);
    const actionArea = row.querySelector('.action-area');
    if (status === 'verified' || status === 'pending') {
      actionArea.appendChild(el(`<p class="text-sm text-zinc-500">${status === 'verified' ? 'This task is verified.' : 'Your submission is awaiting review.'}</p>`));
    } else if (q.locked) {
      actionArea.appendChild(el(`<p class="text-sm text-zinc-500">${escapeHtml(q.locked_reason || 'This quest is locked.')}</p>`));
    } else {
      actionArea.appendChild(el(`<a href="/quest/${q.id}" class="inline-block text-sm font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white">Open quest tasks</a>`));
    }
    list.appendChild(row);
  }
}

// ---------- scoped leaderboard ----------
async function viewScopedLeaderboard(opts) {
  const wrap = el('<div class="animate-pulse space-y-3"><div class="h-20 rounded-2xl bg-zinc-900"></div></div>');
  mount(wrap);
  const metric = opts.metric === 'points' ? 'points' : 'xp';
  const period = opts.period || 'all';
  let data;
  try { data = await loadProjectView(opts.projectSlug); }
  catch (err) { mount(errorCard(err.message)); return; }
  const p = data.project;
  let campaign = null, quest = null;
  if (opts.campaignSlug) campaign = data.campaigns.find(c => c.slug === opts.campaignSlug) || null;
  if (campaign && opts.questSlug) quest = (campaign.quests || []).find(q => q.slug === opts.questSlug || String(q.id) === String(opts.questSlug)) || null;

  const api = quest ? `/api/v1/quests/${quest.id}/leaderboard`
    : campaign ? `/api/v1/campaigns/${campaign.id}/leaderboard`
    : `/api/v1/projects/${p.id}/leaderboard`;
  let board;
  try { board = await window.QuestoraAPI.api.get(`${api}?metric=${metric}&period=${period}`); }
  catch (err) { wrap.replaceChildren(el(`<p class="text-sm text-red-400">${escapeHtml(err.message)}</p>`)); return; }

  const bannerName = quest ? quest.title : campaign ? campaign.name : p.name;
  const bannerScope = quest ? 'Quest leaderboard' : campaign ? 'Campaign leaderboard' : 'Project leaderboard';
  const crumbItems = [{ label: 'Projects', href: '/projects' }, projectCrumb(p)];
  if (campaign) crumbItems.push({ label: campaign.name, href: `/projects/${encodeURIComponent(p.slug)}/campaigns/${encodeURIComponent(campaign.slug)}` });
  if (quest) crumbItems.push({ label: quest.title, href: `/projects/${encodeURIComponent(p.slug)}/campaigns/${encodeURIComponent(campaign.slug)}/quests/${encodeURIComponent(quest.slug || quest.id)}` });
  crumbItems.push({ label: 'Leaderboard' });

  const base = quest
    ? `/projects/${encodeURIComponent(p.slug)}/campaigns/${encodeURIComponent(campaign.slug)}/quests/${encodeURIComponent(quest.slug || quest.id)}/leaderboard`
    : campaign
      ? `/projects/${encodeURIComponent(p.slug)}/campaigns/${encodeURIComponent(campaign.slug)}/leaderboard`
      : `/projects/${encodeURIComponent(p.slug)}/leaderboard`;
  const qs = (m, per) => `${base}?metric=${m}&period=${per}`;
  const periods = campaign ? ['all', 'weekly', 'monthly', 'campaign'] : ['all', 'weekly', 'monthly'];

  const node = el(`
    <div>
      ${breadcrumb(crumbItems)}
      <div class="rounded-2xl border border-zinc-800 bg-gradient-to-b from-violet-600/20 to-transparent p-5 mb-4">
        <p class="text-xs uppercase tracking-wide text-violet-300 mb-1">${escapeHtml(bannerScope)}</p>
        <h1 class="text-xl font-bold">${escapeHtml(bannerName)} \u2014 ${escapeHtml(bannerScope.replace(' leaderboard', ''))} leaderboard</h1>
        <div class="flex flex-wrap gap-2 mt-3">
          <div class="flex gap-1 bg-zinc-900 rounded-full p-1 border border-zinc-800">
            <a href="${qs('xp', period)}" class="px-3 py-1.5 rounded-full text-xs font-medium ${metric === 'xp' ? 'bg-violet-600 text-white' : 'text-zinc-400'}">XP</a>
            <a href="${qs('points', period)}" class="px-3 py-1.5 rounded-full text-xs font-medium ${metric === 'points' ? 'bg-violet-600 text-white' : 'text-zinc-400'}">Points</a>
          </div>
          <div class="flex flex-wrap gap-1">
            ${periods.map(per => `<a href="${qs(metric, per)}" class="px-3 py-1.5 rounded-full text-xs font-medium border ${period === per ? 'bg-violet-600 border-violet-600 text-white' : 'bg-zinc-900 border-zinc-800 text-zinc-400'}">${per === 'all' ? 'All time' : per === 'campaign' ? 'Campaign window' : per.charAt(0).toUpperCase() + per.slice(1)}</a>`).join('')}
          </div>
        </div>
        ${campaign ? `<div class="flex flex-wrap gap-1 mt-2"><a href="/projects/${encodeURIComponent(p.slug)}/leaderboard?metric=${metric}" class="text-xs text-violet-300">Back to project board</a></div>` : ''}
      </div>
      <div class="board space-y-2"></div>
    </div>`);
  mount(node);
  const boardEl = node.querySelector('.board');
  if (!board.entries.length) {
    boardEl.appendChild(el(emptyState('No participants have earned points yet.')));
    return;
  }
  board.entries.forEach((e, i) => boardEl.appendChild(leaderboardRow(e, i)));
}

// ---------- leaderboard hub ----------
async function viewLeaderboardHub(params) {
  params = params || new URLSearchParams();
  const by = params.get('by') === 'points' ? 'points' : 'xp';
  const seasonParam = params.get('season') || '';
  const wrap = el('<div></div>');
  mount(wrap);
  wrap.appendChild(el(`
    <div>
      <h1 class="text-2xl font-bold mb-1">Leaderboard</h1>
      <p class="text-sm text-zinc-500 mb-4">Pick a project to see whose ranking it is, and how it got that way.</p>
      <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div class="flex gap-1 bg-zinc-900 rounded-full p-1 border border-zinc-800">
          <a href="/leaderboard?by=xp${seasonParam ? '&season=' + encodeURIComponent(seasonParam) : ''}" class="px-4 py-1.5 rounded-full text-sm font-medium ${by === 'xp' ? 'bg-violet-600 text-white' : 'text-zinc-400'}">XP</a>
          <a href="/leaderboard?by=points" class="px-4 py-1.5 rounded-full text-sm font-medium ${by === 'points' ? 'bg-violet-600 text-white' : 'text-zinc-400'}">Points</a>
        </div>
        <a href="/projects" class="text-sm text-violet-300">Scoped leaderboards</a>
      </div>
    </div>`));
  let seasonRow = null;
  if (by === 'xp') {
    try {
      const s = await window.QuestoraAPI.api.get('/api/v1/seasons');
      if (s.seasons.length) {
        seasonRow = el('<div class="flex flex-wrap gap-2 mb-4"></div>');
        const chip = (label, slug, on) => el(`<a href="${slug ? `/leaderboard?by=xp&season=${encodeURIComponent(slug)}` : '/leaderboard?by=xp'}" class="px-3 py-1.5 rounded-full text-xs font-medium border ${on ? 'bg-violet-600 border-violet-600 text-white' : 'bg-zinc-900 border-zinc-800 text-zinc-400'}">${escapeHtml(label)}</a>`);
        seasonRow.appendChild(chip('All time', '', !seasonParam));
        for (const sn of s.seasons) seasonRow.appendChild(chip(sn.name + (sn.xp_multiplier ? ` \u00b7 ${sn.xp_multiplier}x XP` : ''), sn.slug, seasonParam === sn.slug));
        wrap.appendChild(seasonRow);
      }
    } catch { /* seasons list is optional chrome */ }
  }
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/leaderboard?by=' + by + (seasonParam ? '&season=' + encodeURIComponent(seasonParam) : '')); }
  catch (err) { wrap.appendChild(el(`<p class="text-zinc-400">${escapeHtml(err.message)}</p>`)); return; }
  if (data.season) wrap.appendChild(el(`<p class="text-xs text-zinc-600 mb-3">Season board: only XP earned during ${escapeHtml(data.season.name)} counts. This season awards ${data.season.xp_multiplier}x XP.</p>`));
  if (!data.entries.length) {
    wrap.appendChild(el(emptyState('No participants have earned points yet.')));
    return;
  }
  const list = el('<div class="space-y-2"></div>');
  data.entries.forEach((e, i) => list.appendChild(leaderboardRow(e, i)));
  wrap.appendChild(list);
}


// ---------- project admin dashboard ----------
// A management shell for one project: sidebar + management tables. Every
// section re-navigates (the URL is the state), so it loads like any view.
const PROJECT_ACTIONS = ['manage', 'review', 'edit', 'view_analytics', 'publish', 'delete_project'];
const DASH_SECTIONS = [
  ['', 'Overview'],
  ['campaigns', 'Campaigns'],
  ['quests', 'Quests'],
  ['participants', 'Participants'],
  ['leaderboard', 'Leaderboard'],
  ['rewards', 'Rewards'],
  ['analytics', 'Analytics'],
  ['settings', 'Settings'],
];

// A native dropdown for a row's actions: one button, a menu of verbs.
function actionMenu(items) {
  const node = el(`
    <details class="relative row-menu">
      <summary class="list-none cursor-pointer select-none text-xs px-3 py-2 min-h-[44px] inline-flex items-center rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200">Actions</summary>
      <div class="absolute right-0 z-20 mt-1 w-48 rounded-xl border border-zinc-700 bg-zinc-900 shadow-lg p-1 space-y-0.5"></div>
    </details>`);
  const menu = node.querySelector('div');
  for (const it of items) {
    const b = el(`<button class="w-full text-left text-sm px-3 py-2 rounded-lg hover:bg-zinc-800 ${it.danger ? 'text-red-300' : 'text-zinc-200'}">${escapeHtml(it.label)}</button>`);
    b.addEventListener('click', (e) => { e.preventDefault(); node.removeAttribute('open'); it.run(b); });
    menu.appendChild(b);
  }
  return node;
}

// Inline two-step confirm used everywhere destructive: the button swaps to a
// red Confirm plus Cancel, matching the review queue's pattern.
function confirmButton(label, confirmLabel, run) {
  const btn = el(`<button class="text-sm px-3 py-2 min-h-[44px] rounded-lg bg-zinc-800 hover:bg-red-600 text-zinc-200">${escapeHtml(label)}</button>`);
  let armed = false;
  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.className = 'text-sm px-3 py-2 min-h-[44px] rounded-lg bg-red-600 hover:bg-red-500 text-white';
      btn.textContent = confirmLabel;
      const cancel = el('<button class="text-sm px-3 py-2 min-h-[44px] rounded-lg bg-zinc-800 text-zinc-300">Cancel</button>');
      cancel.addEventListener('click', () => { armed = false; btn.className = 'text-sm px-3 py-2 min-h-[44px] rounded-lg bg-zinc-800 hover:bg-red-600 text-zinc-200'; btn.textContent = label; cancel.remove(); });
      btn.after(cancel);
      return;
    }
    await run();
  });
  return btn;
}

async function viewDashboard(slug, section, params) {
  params = params || new URLSearchParams();
  const wrap = el('<div class="animate-pulse space-y-3"><div class="h-24 rounded-2xl bg-zinc-900"></div></div>');
  mount(wrap);
  let data, overview = null;
  try { data = await loadProjectView(slug); }
  catch (err) { mount(errorCard(err.message)); return; }
  const p = data.project;
  if (!data.can_manage) {
    wrap.replaceChildren(el(`
      <div>
        ${breadcrumb([{ label: 'Projects', href: '/projects' }, projectCrumb(p), { label: 'Dashboard' }])}
        ${emptyState("You don't have access to manage this project. Ask the project owner for an admin role.", 'Explore campaigns', `/projects/${encodeURIComponent(p.slug)}`)}
      </div>`));
    return;
  }
  try { overview = await window.QuestoraAPI.api.get(`/api/v1/projects/${p.id}/overview`); }
  catch { overview = { stats: {}, recent_activity: [] }; }
  const stats = overview.stats || {};

  const node = el(`
    <div>
      ${breadcrumb([{ label: 'Projects', href: '/projects' }, projectCrumb(p), { label: 'Dashboard' }])}
      <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 mb-4 flex items-center justify-between gap-4 flex-wrap">
        <div class="min-w-0">
          <h1 class="text-xl font-bold truncate">${escapeHtml(p.name)}</h1>
          <p class="text-sm text-zinc-500">Project dashboard</p>
        </div>
        <div class="flex gap-2">
          <a href="/projects/${encodeURIComponent(p.slug)}" class="text-sm px-3 py-2.5 min-h-[44px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200">View public page</a>
        </div>
      </div>
      <div class="grid md:grid-cols-[200px_1fr] gap-4">
        <nav class="sidebar flex md:flex-col gap-1.5 overflow-x-auto md:overflow-visible"></nav>
        <div class="section"></div>
      </div>
    </div>`);
  mount(node);
  const sidebar = node.querySelector('.sidebar');
  const sectionEl = node.querySelector('.section');
  const base = '/dashboard/projects/' + encodeURIComponent(p.slug);
  for (const [seg, label] of DASH_SECTIONS) {
    const active = (seg === section) || (seg === 'campaigns' && section.startsWith('campaigns/'));
    sidebar.appendChild(el(`<a href="${base}${seg ? '/' + seg : ''}" class="shrink-0 px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium ${active ? 'bg-violet-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-white'}">${escapeHtml(label)}</a>`));
  }

  const ctx = { p, data, stats, base, reload: () => viewDashboard(slug, section, params) };
  if (section === 'campaigns') return renderDashCampaigns(sectionEl, ctx);
  if (section.startsWith('campaigns/')) return renderDashCampaignQuests(sectionEl, ctx, section.slice('campaigns/'.length));
  if (section === 'quests') return renderDashQuests(sectionEl, ctx);
  if (section === 'participants' || section === 'leaderboard') return renderDashLeaderboard(sectionEl, ctx, section);
  if (section === 'rewards') return renderDashRewards(sectionEl, ctx);
  if (section === 'analytics') return renderDashAnalytics(sectionEl, ctx);
  if (section === 'settings') return renderDashSettings(sectionEl, ctx);
  return renderDashOverview(sectionEl, ctx);
}

function renderDashOverview(sectionEl, ctx) {
  const { p, data, stats } = ctx;
  const cards = el('<div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5"></div>');
  cards.innerHTML = [
    statCard('Active campaigns', stats.active_campaigns || 0),
    statCard('Quests', stats.quests || 0),
    statCard('Participants', stats.participants || 0),
    statCard('Completions', stats.completions || 0),
    statCard('XP distributed', Number(stats.xp_distributed || 0).toLocaleString(), 'text-violet-300'),
    statCard('Awaiting review', stats.pending_review || 0),
  ].join('');
  sectionEl.appendChild(cards);
  sectionEl.appendChild(el(`<a href="${ctx.base}/campaigns" class="inline-block font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm mb-5">New campaign</a>`));
  sectionEl.appendChild(el('<h2 class="text-sm font-medium text-zinc-500 mb-2">Recent activity</h2>'));
  const act = (ctx.recent_activity || []);
  if (act.length) {
    const list = el('<div class="space-y-2"></div>');
    for (const a of act) {
      list.appendChild(el(`<div class="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-sm"><span class="min-w-0 truncate"><span class="text-zinc-200">@${escapeHtml(a.username)}</span> <span class="text-zinc-500">completed ${escapeHtml(a.title)}</span></span><span class="shrink-0 text-xs text-zinc-600">${new Date(a.completed_at).toLocaleDateString()}</span></div>`));
    }
    sectionEl.appendChild(list);
  } else {
    sectionEl.appendChild(el('<p class="text-sm text-zinc-600">No activity yet. Publish a campaign and its quests to start.</p>'));
  }
}

// Campaign management table: search, status filter, sort, pagination, bulk
// archive/publish/unpublish, and a per-row action menu.
function renderDashCampaigns(sectionEl, ctx) {
  const { p, data } = ctx;
  const state = { q: '', status: '', sort: 'newest', page: 1, selected: new Set() };
  const pageSize = 5;

  const create = el(`
    <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 mb-4">
      <h2 class="font-semibold mb-2">Create campaign</h2>
      <div class="flex flex-col sm:flex-row gap-2">
        <input class="c-name flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none" placeholder="Campaign name">
        <select class="c-status rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm focus:outline-none">
          <option value="draft">Draft</option><option value="scheduled">Scheduled</option><option value="active">Active</option>
        </select>
        <button class="c-create shrink-0 font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Create campaign</button>
      </div>
    </div>`);
  create.querySelector('.c-create').addEventListener('click', async () => {
    const name = create.querySelector('.c-name').value.trim();
    if (!name) return toast('A campaign name is required', true);
    try {
      await window.QuestoraAPI.api.post(`/api/v1/projects/${p.id}/campaigns`, { name, status: create.querySelector('.c-status').value });
      toast('Campaign created');
      ctx.reload();
    } catch (err) { toast(err.message, true); }
  });
  sectionEl.appendChild(create);

  const controls = el(`
    <div class="flex flex-wrap gap-2 items-center mb-3">
      <input class="d-search flex-1 min-w-[160px] rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none" placeholder="Search campaigns">
      <select class="d-status rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm focus:outline-none">
        <option value="">All statuses</option>
        <option value="draft">Draft</option><option value="scheduled">Scheduled</option><option value="active">Active</option>
        <option value="paused">Paused</option><option value="ended">Ended</option><option value="archived">Archived</option>
      </select>
      <select class="d-sort rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm focus:outline-none">
        <option value="newest">Newest</option><option value="name">Name</option><option value="quests">Most quests</option>
      </select>
      <input class="d-from rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm text-zinc-300 focus:outline-none" type="date" aria-label="Starts after">
      <input class="d-to rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm text-zinc-300 focus:outline-none" type="date" aria-label="Ends before">
    </div>`);
  sectionEl.appendChild(controls);

  const bulk = el(`
    <div class="bulk flex flex-wrap gap-2 mb-3 hidden">
      <span class="text-xs text-zinc-500 self-center"><span class="count">0</span> selected</span>
      <button class="b-publish text-xs px-3 py-2 min-h-[36px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200">Publish</button>
      <button class="b-unpublish text-xs px-3 py-2 min-h-[36px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200">Unpublish</button>
      <button class="b-archive text-xs px-3 py-2 min-h-[36px] rounded-lg bg-zinc-800 hover:bg-red-600 text-zinc-200">Archive</button>
    </div>`);
  sectionEl.appendChild(bulk);

  const table = el('<div class="table space-y-2"></div>');
  sectionEl.appendChild(table);
  const pagerSlot = el('<div></div>');
  sectionEl.appendChild(pagerSlot);

  function filtered() {
    let rows = data.campaigns.slice();
    if (state.q) rows = rows.filter(c => c.name.toLowerCase().includes(state.q.toLowerCase()));
    if (state.status) rows = rows.filter(c => c.status === state.status);
    const from = controls.querySelector('.d-from').value;
    const to = controls.querySelector('.d-to').value;
    if (from) rows = rows.filter(c => c.starts_at && new Date(c.starts_at) >= new Date(from));
    if (to) rows = rows.filter(c => c.ends_at && new Date(c.ends_at) <= new Date(to));
    if (state.sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
    else if (state.sort === 'quests') rows.sort((a, b) => (b.quest_count || 0) - (a.quest_count || 0));
    else rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return rows;
  }

  function campaignActions(c) {
    const items = [];
    items.push({ label: 'View', run: () => window.history.pushState({}, '', `/projects/${encodeURIComponent(p.slug)}/campaigns/${encodeURIComponent(c.slug)}`) || window.dispatchEvent(new PopStateEvent('popstate')) });
    items.push({ label: 'Manage quests', run: () => { window.history.pushState({}, '', `${ctx.base}/campaigns/${encodeURIComponent(c.slug)}`); window.dispatchEvent(new PopStateEvent('popstate')); } });
    items.push({ label: 'Duplicate', run: async () => { try { await window.QuestoraAPI.api.post(`/api/v1/campaigns/${c.id}/duplicate`, {}); toast('Duplicated as a draft'); ctx.reload(); } catch (e) { toast(e.message, true); } } });
    if (c.status !== 'active' && ['draft', 'scheduled', 'paused'].includes(c.status)) items.push({ label: 'Publish', run: async () => { await patchCampaign(c.id, { status: 'active' }); } });
    if (c.status === 'active') items.push({ label: 'Unpublish', run: async () => { await patchCampaign(c.id, { status: 'paused' }); } });
    items.push({ label: 'Archive', danger: true, run: async () => { await patchCampaign(c.id, { status: 'archived' }); } });
    items.push({ label: 'Delete', danger: true, run: async (btn) => {
      if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Confirm delete'; return; }
      try { const r = await window.QuestoraAPI.api.del(`/api/v1/campaigns/${c.id}`); toast(r.archived ? r.reason : 'Campaign deleted'); ctx.reload(); } catch (e) { toast(e.message, true); }
    } });
    return actionMenu(items);
  }

  async function patchCampaign(id, body) {
    try { await window.QuestoraAPI.api.patch(`/api/v1/campaigns/${id}`, body); toast('Updated'); ctx.reload(); }
    catch (e) { toast(e.message, true); }
  }

  async function bulkApply(status) {
    const ids = [...state.selected];
    for (const id of ids) { try { await window.QuestoraAPI.api.patch(`/api/v1/campaigns/${id}`, { status }); } catch { /* skip illegal transitions */ } }
    toast('Bulk update applied'); ctx.reload();
  }
  bulk.querySelector('.b-publish').addEventListener('click', () => bulkApply('active'));
  bulk.querySelector('.b-unpublish').addEventListener('click', () => bulkApply('paused'));
  bulk.querySelector('.b-archive').addEventListener('click', () => bulkApply('archived'));

  function render() {
    const rows = filtered();
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (state.page > pages) state.page = pages;
    const slice = rows.slice((state.page - 1) * pageSize, state.page * pageSize);
    table.replaceChildren();
    bulk.classList.toggle('hidden', state.selected.size === 0);
    bulk.querySelector('.count').textContent = state.selected.size;
    if (!rows.length) {
      table.appendChild(el(emptyState('No campaigns match the selected filters.')));
      pagerSlot.replaceChildren();
      return;
    }
    for (const c of slice) {
      const row = el(`
        <div class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
          <input type="checkbox" class="sel accent-violet-500" ${state.selected.has(c.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(c.name)}">
          <span class="min-w-0 flex-1">
            <span class="block font-medium truncate">${escapeHtml(c.name)}</span>
            <span class="block text-xs text-zinc-600">${c.quest_count || 0} quests \u00b7 ${c.participants || 0} participants \u00b7 ${c.starts_at ? new Date(c.starts_at).toLocaleDateString() : 'no start'} to ${c.ends_at ? new Date(c.ends_at).toLocaleDateString() : 'no end'}</span>
          </span>
          ${statePill(c.status)}
          <span class="menu-slot shrink-0"></span>
        </div>`);
      row.querySelector('.sel').addEventListener('change', (e) => { if (e.target.checked) state.selected.add(c.id); else state.selected.delete(c.id); render(); });
      row.querySelector('.menu-slot').appendChild(campaignActions(c));
      table.appendChild(row);
    }
    pagerSlot.replaceChildren();
    if (pages > 1) {
      const pg = el('<div class="flex items-center justify-center gap-3 mt-2"></div>');
      const prev = el(`<button class="text-sm px-3 py-2 min-h-[44px] rounded-lg bg-zinc-800 text-zinc-200 ${state.page === 1 ? 'opacity-40' : ''}">Previous</button>`);
      prev.disabled = state.page === 1;
      prev.addEventListener('click', () => { state.page--; render(); });
      const next = el(`<button class="text-sm px-3 py-2 min-h-[44px] rounded-lg bg-zinc-800 text-zinc-200 ${state.page === pages ? 'opacity-40' : ''}">Next</button>`);
      next.disabled = state.page === pages;
      next.addEventListener('click', () => { state.page++; render(); });
      pg.appendChild(prev); pg.appendChild(el(`<span class="text-sm text-zinc-500">Page ${state.page} of ${pages}</span>`)); pg.appendChild(next);
      pagerSlot.appendChild(pg);
    }
  }
  controls.querySelector('.d-search').addEventListener('input', (e) => { state.q = e.target.value; state.page = 1; render(); });
  controls.querySelector('.d-status').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; render(); });
  controls.querySelector('.d-sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  controls.querySelector('.d-from').addEventListener('change', render);
  controls.querySelector('.d-to').addEventListener('change', render);
  render();
}

// Manage one campaign's quests: table with reorder, CRUD and status actions.
function renderDashCampaignQuests(sectionEl, ctx, campaignSlug) {
  const { p, data } = ctx;
  const campaign = data.campaigns.find(c => c.slug === campaignSlug);
  if (!campaign) { sectionEl.appendChild(el(emptyState('That campaign is not in this project.'))); return; }
  const quests = (campaign.quests || []).slice();
  const state = { q: '', status: '', type: '', sort: 'order', page: 1 };
  const pageSize = 8;
  sectionEl.appendChild(el(`
    <div class="mb-4">
      ${breadcrumb([{ label: 'Campaigns', href: ctx.base + '/campaigns' }, { label: campaign.name }])}
      <h2 class="text-lg font-bold">${escapeHtml(campaign.name)}</h2>
      <p class="text-sm text-zinc-500">Manage this campaign's quests.</p>
    </div>`));

  const create = el(`
    <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 mb-4">
      <h3 class="font-semibold mb-2">Create quest</h3>
      <div class="flex flex-col sm:flex-row gap-2">
        <input class="q-title flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none" placeholder="Quest title">
        <input class="q-xp w-28 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none" type="number" min="0" placeholder="XP">
        <button class="q-create shrink-0 font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Create quest</button>
      </div>
      <p class="text-xs text-zinc-600 mt-1">A quest starts with one manual task you can edit later.</p>
    </div>`);
  create.querySelector('.q-create').addEventListener('click', async () => {
    const title = create.querySelector('.q-title').value.trim();
    if (!title) return toast('A quest title is required', true);
    try {
      await window.QuestoraAPI.api.post(`/api/v1/campaigns/${campaign.id}/quests`, {
        title, xp_reward: parseInt(create.querySelector('.q-xp').value, 10) || 0, status: 'draft',
        tasks: [{ type: 'manual', title: 'Task', config: {} }],
      });
      toast('Quest created'); ctx.reload();
    } catch (err) { toast(err.message, true); }
  });
  sectionEl.appendChild(create);

  const controls = el(`
    <div class="flex flex-wrap gap-2 items-center mb-3">
      <input class="k-search flex-1 min-w-[160px] rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none" placeholder="Search quests">
      <select class="k-status rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm focus:outline-none">
        <option value="">All statuses</option>
        <option value="draft">Draft</option><option value="scheduled">Scheduled</option><option value="active">Active</option>
        <option value="paused">Paused</option><option value="ended">Ended</option><option value="archived">Archived</option>
      </select>
      <select class="k-type rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm focus:outline-none">
        <option value="">All types</option>
        <option value="Social">Social</option><option value="Quiz">Quiz</option><option value="Wallet">Wallet</option>
        <option value="Submission">Submission</option><option value="Mixed">Mixed</option>
      </select>
      <select class="k-sort rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm focus:outline-none">
        <option value="order">Manual order</option><option value="name">Name</option>
        <option value="participants">Most participants</option><option value="xp">Most XP</option>
      </select>
    </div>`);
  sectionEl.appendChild(controls);

  if (!quests.length) { sectionEl.appendChild(el(emptyState("This campaign doesn't have any quests yet."))); return; }

  const table = el('<div class="space-y-2"></div>');
  sectionEl.appendChild(table);
  const pagerSlot = el('<div></div>');
  sectionEl.appendChild(pagerSlot);

  async function saveOrder(list) {
    try { await window.QuestoraAPI.api.post(`/api/v1/campaigns/${campaign.id}/quests/reorder`, { order: list.map(q => q.id) }); toast('Order saved'); }
    catch (e) { toast(e.message, true); }
  }

  async function patchQuest(id, body) {
    try { await window.QuestoraAPI.api.patch(`/api/v1/quests/${id}`, body); toast('Updated'); ctx.reload(); }
    catch (e) { toast(e.message, true); }
  }

  function filtered() {
    let rows = quests.slice();
    if (state.q) rows = rows.filter(q => q.title.toLowerCase().includes(state.q.toLowerCase()));
    if (state.status) rows = rows.filter(q => q.status === state.status);
    if (state.type) rows = rows.filter(q => (q.quest_type || 'Mixed') === state.type);
    if (state.sort === 'name') rows.sort((a, b) => a.title.localeCompare(b.title));
    else if (state.sort === 'participants') rows.sort((a, b) => (b.participants || 0) - (a.participants || 0));
    else if (state.sort === 'xp') rows.sort((a, b) => (b.xp_reward || 0) - (a.xp_reward || 0));
    return rows;
  }

  function render() {
    const rows = filtered();
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (state.page > pages) state.page = pages;
    const slice = rows.slice((state.page - 1) * pageSize, state.page * pageSize);
    table.replaceChildren();
    if (!rows.length) {
      table.appendChild(el(emptyState('No quests match the selected filters.')));
      pagerSlot.replaceChildren();
      return;
    }
    slice.forEach((q) => {
      const idx = quests.indexOf(q);
      const row = el(`
        <div class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
          <span class="drag-handle cursor-grab text-zinc-600 select-none" title="Drag to reorder" aria-hidden="true">\u2261</span>
          <span class="min-w-0 flex-1">
            <span class="block font-medium truncate">${escapeHtml(q.title)}</span>
            <span class="block text-xs text-zinc-600">${escapeHtml(q.quest_type || 'Mixed')} \u00b7 ${q.participants || 0} participants \u00b7 ${q.points_reward || 0} points</span>
          </span>
          ${statePill(q.status)}
          <span class="shrink-0 text-sm text-violet-300">+${q.xp_reward} XP</span>
          <span class="updown shrink-0 flex gap-1">
            <button class="up text-xs px-2 py-2 min-h-[36px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300" aria-label="Move up">\u2191</button>
            <button class="down text-xs px-2 py-2 min-h-[36px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300" aria-label="Move down">\u2193</button>
          </span>
          <span class="menu-slot shrink-0"></span>
        </div>`);
      row.querySelector('.up').disabled = idx === 0;
      row.querySelector('.down').disabled = idx === quests.length - 1;
      row.querySelector('.up').addEventListener('click', () => { if (idx > 0) { const l = quests.slice(); [l[idx - 1], l[idx]] = [l[idx], l[idx - 1]]; saveOrder(l).then(ctx.reload); } });
      row.querySelector('.down').addEventListener('click', () => { if (idx < quests.length - 1) { const l = quests.slice(); [l[idx + 1], l[idx]] = [l[idx], l[idx + 1]]; saveOrder(l).then(ctx.reload); } });
      // Drag and drop reordering: grab a row and drop it on another.
      row.setAttribute('draggable', 'true');
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(idx)); });
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (Number.isNaN(from) || from === idx) return;
        const l = quests.slice(); const [moved] = l.splice(from, 1); l.splice(idx, 0, moved);
        await saveOrder(l); ctx.reload();
      });
      const actions = [];
      actions.push({ label: 'View', run: async () => { try { const d = await window.QuestoraAPI.api.get('/api/v1/quests/' + q.id); window.history.pushState({}, '', `/projects/${encodeURIComponent(p.slug)}/campaigns/${encodeURIComponent(campaign.slug)}/quests/${encodeURIComponent(d.quest.slug || q.id)}`); window.dispatchEvent(new PopStateEvent('popstate')); } catch (e) { toast(e.message, true); } } });
      actions.push({ label: 'Edit', run: () => promptEditQuest(row, q, async (body) => { await window.QuestoraAPI.api.patch(`/api/v1/quests/${q.id}`, body); toast('Quest updated'); ctx.reload(); }) });
      actions.push({ label: 'Duplicate', run: async () => { try { await window.QuestoraAPI.api.post(`/api/v1/quests/${q.id}/duplicate`, {}); toast('Duplicated as a draft'); ctx.reload(); } catch (e) { toast(e.message, true); } } });
      actions.push({ label: 'Reorder', run: () => toast('Drag a row handle, or use the up and down arrows, to reorder quests.') });
      if (q.status !== 'active') actions.push({ label: 'Publish', run: () => patchQuest(q.id, { status: 'active' }) });
      if (q.status === 'active') actions.push({ label: 'Unpublish', run: () => patchQuest(q.id, { status: 'paused' }) });
      if (q.status === 'active' || q.status === 'scheduled') actions.push({ label: 'Pause', run: () => patchQuest(q.id, { status: 'paused' }) });
      actions.push({ label: 'Archive', danger: true, run: () => patchQuest(q.id, { status: 'archived' }) });
      actions.push({ label: 'Delete', danger: true, run: async (btn) => {
        if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Confirm delete'; return; }
        try { const r = await window.QuestoraAPI.api.del(`/api/v1/quests/${q.id}`); toast(r.archived ? r.reason : 'Quest deleted'); ctx.reload(); } catch (e) { toast(e.message, true); }
      } });
      row.querySelector('.menu-slot').appendChild(actionMenu(actions));
      table.appendChild(row);
    });
    pagerSlot.replaceChildren();
    if (pages > 1) {
      const pg = el('<div class="flex items-center justify-center gap-3 mt-2"></div>');
      const prev = el(`<button class="text-sm px-3 py-2 min-h-[44px] rounded-lg bg-zinc-800 text-zinc-200 ${state.page === 1 ? 'opacity-40' : ''}">Previous</button>`);
      prev.disabled = state.page === 1;
      prev.addEventListener('click', () => { state.page--; render(); });
      const next = el(`<button class="text-sm px-3 py-2 min-h-[44px] rounded-lg bg-zinc-800 text-zinc-200 ${state.page === pages ? 'opacity-40' : ''}">Next</button>`);
      next.disabled = state.page === pages;
      next.addEventListener('click', () => { state.page++; render(); });
      pg.appendChild(prev); pg.appendChild(el(`<span class="text-sm text-zinc-500">Page ${state.page} of ${pages}</span>`)); pg.appendChild(next);
      pagerSlot.appendChild(pg);
    }
  }
  controls.querySelector('.k-search').addEventListener('input', (e) => { state.q = e.target.value; state.page = 1; render(); });
  controls.querySelector('.k-status').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; render(); });
  controls.querySelector('.k-type').addEventListener('change', (e) => { state.type = e.target.value; state.page = 1; render(); });
  controls.querySelector('.k-sort').addEventListener('change', (e) => { state.sort = e.target.value; state.page = 1; render(); });
  render();
}

function promptEditQuest(row, q, save) {
  const panel = el(`
    <div class="mt-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
      <input class="e-title w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm focus:outline-none" value="${escapeHtml(q.title)}" aria-label="Quest title">
      <input class="e-xp w-32 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm focus:outline-none" type="number" min="0" value="${q.xp_reward}" aria-label="XP reward">
      <div class="flex gap-2"><button class="save text-sm px-3 py-2 min-h-[44px] rounded-lg bg-violet-600 text-white">Save</button><button class="cancel text-sm px-3 py-2 min-h-[44px] rounded-lg bg-zinc-800 text-zinc-300">Cancel</button></div>
    </div>`);
  panel.querySelector('.cancel').addEventListener('click', () => panel.remove());
  panel.querySelector('.save').addEventListener('click', async () => {
    try { await save({ title: panel.querySelector('.e-title').value.trim(), xp_reward: parseInt(panel.querySelector('.e-xp').value, 10) || 0 }); panel.remove(); }
    catch (e) { toast(e.message, true); }
  });
  row.after(panel);
}

// Flat quest table across the whole project.
function renderDashQuests(sectionEl, ctx) {
  const { p, data } = ctx;
  sectionEl.appendChild(el('<h2 class="text-lg font-bold mb-1">Quests</h2><p class="text-sm text-zinc-500 mb-4">Every quest in this project.</p>'));
  const rows = [];
  for (const c of data.campaigns) for (const q of (c.quests || [])) rows.push({ ...q, campaign_name: c.name, campaign_slug: c.slug });
  if (!rows.length) { sectionEl.appendChild(el(emptyState("This project doesn't have any quests yet."))); return; }
  const list = el('<div class="space-y-2"></div>');
  for (const q of rows) {
    list.appendChild(el(`
      <a href="${ctx.base}/campaigns/${encodeURIComponent(q.campaign_slug)}" class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40">
        <span class="min-w-0 flex-1"><span class="block font-medium truncate">${escapeHtml(q.title)}</span><span class="block text-xs text-zinc-600">${escapeHtml(q.campaign_name)} \u00b7 ${escapeHtml(q.quest_type || 'Mixed')}</span></span>
        ${statePill(q.status)}
        <span class="shrink-0 text-sm text-violet-300">+${q.xp_reward} XP</span>
      </a>`));
  }
  sectionEl.appendChild(list);
}

async function renderDashLeaderboard(sectionEl, ctx, which) {
  const { p } = ctx;
  sectionEl.appendChild(el(`<h2 class="text-lg font-bold mb-1">${which === 'participants' ? 'Participants' : 'Leaderboard'}</h2><p class="text-sm text-zinc-500 mb-4">${which === 'participants' ? 'Everyone who has earned recognition here.' : 'This project, ranked by points.'}</p>`));
  let board;
  try { board = await window.QuestoraAPI.api.get(`/api/v1/projects/${p.id}/leaderboard?metric=points`); }
  catch (err) { sectionEl.appendChild(el(`<p class="text-sm text-red-400">${escapeHtml(err.message)}</p>`)); return; }
  if (!board.entries.length) { sectionEl.appendChild(el(emptyState('No participants have earned points yet.'))); return; }
  const list = el('<div class="space-y-2"></div>');
  board.entries.forEach((e, i) => list.appendChild(leaderboardRow(e, i)));
  sectionEl.appendChild(list);
}

async function renderDashRewards(sectionEl, ctx) {
  const { p } = ctx;
  sectionEl.appendChild(el('<h2 class="text-lg font-bold mb-1">Rewards</h2><p class="text-sm text-zinc-500 mb-4">Rewards attached to this project\'s quests.</p>'));
  let an;
  try { an = await window.QuestoraAPI.api.get(`/api/v1/projects/${p.id}/analytics`); }
  catch (err) { sectionEl.appendChild(el(`<p class="text-sm text-red-400">${escapeHtml(err.message)}</p>`)); return; }
  sectionEl.appendChild(el(`<p class="text-sm text-zinc-500 mb-3">${an.quests.length} quests carry rewards. Credentials and badges are issued on completion.</p>`));
  const list = el('<div class="space-y-2"></div>');
  for (const q of an.quests) {
    list.appendChild(el(`<div class="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3"><span class="text-sm">${escapeHtml(q.title)}</span><span class="text-sm text-violet-300">+${q.xp_reward} XP</span></div>`));
  }
  sectionEl.appendChild(list);
}

async function renderDashAnalytics(sectionEl, ctx) {
  const { p, stats } = ctx;
  sectionEl.appendChild(el('<h2 class="text-lg font-bold mb-1">Analytics</h2><p class="text-sm text-zinc-500 mb-4">How this project is performing.</p>'));
  const cards = el('<div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4"></div>');
  cards.innerHTML = [
    statCard('Participants', stats.participants || 0),
    statCard('Completions', stats.completions || 0),
    statCard('XP distributed', Number(stats.xp_distributed || 0).toLocaleString(), 'text-violet-300'),
  ].join('');
  sectionEl.appendChild(cards);
  let an;
  try { an = await window.QuestoraAPI.api.get(`/api/v1/projects/${p.id}/analytics`); }
  catch (err) { sectionEl.appendChild(el(`<p class="text-sm text-red-400">${escapeHtml(err.message)}</p>`)); return; }
  const list = el('<div class="space-y-2"></div>');
  for (const q of an.quests) {
    const rate = q.submissions ? Math.round((q.completions / q.submissions) * 100) : 0;
    list.appendChild(el(`<div class="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3"><span class="text-sm">${escapeHtml(q.title)}</span><span class="text-sm text-zinc-400">${q.completions} completed \u00b7 ${rate}% conversion</span></div>`));
  }
  sectionEl.appendChild(list);
}

// Settings: project details plus the membership roster (RBAC management).
async function renderDashSettings(sectionEl, ctx) {
  const { p, data } = ctx;
  const form = el(`
    <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 mb-5 max-w-xl">
      <h2 class="font-semibold mb-2">Project details</h2>
      <input class="p-name w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm mb-2 focus:outline-none" value="${escapeHtml(p.name)}" aria-label="Project name">
      <textarea class="p-desc w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 text-sm mb-2 focus:outline-none" rows="2" aria-label="Description">${escapeHtml(p.description || '')}</textarea>
      <input class="p-web w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm mb-2 focus:outline-none" value="${escapeHtml(p.website || '')}" placeholder="Website" aria-label="Website">
      <input class="p-logo w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm mb-2 focus:outline-none" value="${escapeHtml(p.logo_url || '')}" placeholder="Logo URL" aria-label="Logo URL">
      <input class="p-banner w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm mb-2 focus:outline-none" value="${escapeHtml(p.banner_url || '')}" placeholder="Banner URL" aria-label="Banner URL">
      <input class="p-links w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm mb-2 focus:outline-none" value="${escapeHtml(linksToText(p.social_links))}" placeholder="Links, one per line: label | url" aria-label="Social links">
      <div class="flex flex-wrap gap-2 mb-3">
        <label class="text-xs text-zinc-500 flex-1 min-w-[140px]">Visibility
          <select class="p-vis w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm focus:outline-none" aria-label="Visibility">
            <option value="public" ${p.visibility === 'unlisted' ? '' : 'selected'}>Public</option>
            <option value="unlisted" ${p.visibility === 'unlisted' ? 'selected' : ''}>Unlisted</option>
          </select>
        </label>
        <label class="text-xs text-zinc-500 flex-1 min-w-[140px]">Status
          <select class="p-status w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm focus:outline-none" aria-label="Status">
            <option value="active" ${p.status === 'active' ? 'selected' : ''}>Active (published)</option>
            <option value="paused" ${p.status === 'paused' ? 'selected' : ''}>Paused</option>
            <option value="archived" ${p.status === 'archived' ? 'selected' : ''}>Archived</option>
          </select>
        </label>
      </div>
      <button class="save font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Save project</button>
    </div>`);
  form.querySelector('.save').addEventListener('click', async () => {
    try {
      await window.QuestoraAPI.api.patch(`/api/v1/projects/${p.id}`, {
        name: form.querySelector('.p-name').value.trim(),
        description: form.querySelector('.p-desc').value,
        website: form.querySelector('.p-web').value.trim() || null,
        logo_url: form.querySelector('.p-logo').value.trim() || null,
        banner_url: form.querySelector('.p-banner').value.trim() || null,
        social_links: textToLinks(form.querySelector('.p-links').value),
        visibility: form.querySelector('.p-vis').value,
        status: form.querySelector('.p-status').value,
      });
      toast('Project saved'); ctx.reload();
    } catch (err) { toast(err.message, true); }
  });
  sectionEl.appendChild(form);
  await renderMembers(sectionEl, ctx);
  if (data && data.can_delete) renderDangerZone(sectionEl, ctx);
}

// social_links <-> a simple "label | url" textarea, so the editor stays
// dependency-free.
function linksToText(links) {
  if (!links || typeof links !== 'object') return '';
  return Object.entries(links).map(([k, v]) => k + ' | ' + v).join('\n');
}
function textToLinks(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('|');
    if (i < 0) continue;
    const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim();
    if (k && v) out[k.slice(0, 40)] = v.slice(0, 500);
  }
  return out;
}

async function renderMembers(sectionEl, ctx) {
  const { p, data } = ctx;
  const isOwner = !!(data && data.is_owner);
  const canGrantDelete = !!(data && data.can_delete) && isOwner;
  const card = el(`
    <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 max-w-xl mb-5">
      <h2 class="font-semibold mb-1">Ownership and roles</h2>
      <p class="text-xs text-zinc-600 mb-3">Owner, admin, editor, reviewer and analyst each see a different part of this dashboard. Tick an ability to grant it, untick to withhold it. Deleting the project is owner-only unless the owner grants it.</p>
      <div class="members space-y-2 mb-3"></div>
      <div class="flex flex-col sm:flex-row gap-2">
        <input class="m-user flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none" placeholder="Username">
        <select class="m-role rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm focus:outline-none">
          <option value="admin">Admin</option><option value="editor">Editor</option><option value="reviewer">Reviewer</option><option value="analyst">Analyst</option>
        </select>
        <button class="m-add shrink-0 font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Add member</button>
      </div>
    </div>`);
  sectionEl.appendChild(card);
  const holder = card.querySelector('.members');
  card.querySelector('.m-add').addEventListener('click', async () => {
    const username = card.querySelector('.m-user').value.trim();
    if (!username) return toast('A username is required', true);
    try { await window.QuestoraAPI.api.post(`/api/v1/projects/${p.id}/members`, { username, role: card.querySelector('.m-role').value }); toast('Member added'); renderMembers(sectionEl, ctx); }
    catch (err) { toast(err.message, true); }
  });
  holder.replaceChildren(el('<p class="text-sm text-zinc-600">Loading members\u2026</p>'));
  let members;
  try { members = await window.QuestoraAPI.api.get(`/api/v1/projects/${p.id}/members`); }
  catch (err) { holder.replaceChildren(el(`<p class="text-sm text-red-400">${escapeHtml(err.message)}</p>`)); return; }
  holder.replaceChildren();
  for (const m of members.members) {
    const owner = m.role === 'owner';
    const row = el(`
      <div class="rounded-lg border border-zinc-800 px-3 py-2">
        <div class="flex items-center gap-2">
          <span class="min-w-0 flex-1"><span class="block text-sm font-medium truncate">${escapeHtml(m.display_name || m.username)}</span><span class="block text-xs text-zinc-600">@${escapeHtml(m.username)}${owner ? ' \u00b7 Project Owner' : ''}</span></span>
          <select class="role rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-xs focus:outline-none" ${owner ? 'disabled' : ''}>
            ${['owner', 'admin', 'editor', 'reviewer', 'analyst'].map(r => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
          ${owner ? '' : '<button class="remove text-xs px-2 py-2 min-h-[36px] rounded-lg bg-zinc-800 hover:bg-red-600 text-zinc-300">Remove</button>'}
        </div>
        <div class="mt-2"></div>
      </div>`);
    const permHolder = row.querySelector('.mt-2');
    const perms = permissionList(PROJECT_ACTIONS, m.permissions, owner || !canGrantDelete);
    permHolder.appendChild(perms);
    perms.addEventListener('change', async () => {
      const next = {};
      perms.querySelectorAll('.perm-toggle').forEach((cb) => { next[cb.dataset.action] = cb.checked; });
      try {
        await window.QuestoraAPI.api.patch(`/api/v1/projects/${p.id}/members/${m.user_id}`,
          { role: owner ? 'owner' : row.querySelector('.role').value, permissions: next });
        toast('Permissions updated');
      } catch (err) { toast(err.message, true); renderMembers(sectionEl, ctx); }
    });
    const sel = row.querySelector('.role');
    if (sel && !sel.disabled) sel.addEventListener('change', async () => {
      try { await window.QuestoraAPI.api.patch(`/api/v1/projects/${p.id}/members/${m.user_id}`, { role: sel.value }); toast('Role updated'); }
      catch (err) { toast(err.message, true); }
    });
    const rm = row.querySelector('.remove');
    if (rm) rm.addEventListener('click', async () => {
      try { await window.QuestoraAPI.api.del(`/api/v1/projects/${p.id}/members/${m.user_id}`); toast('Member removed'); renderMembers(sectionEl, ctx); }
      catch (err) { toast(err.message, true); }
    });
    holder.appendChild(row);
  }
}

// Two-step destructive delete. The preview loads the exact resources a hard
// delete would remove, and the default action archives instead.
async function renderDangerZone(sectionEl, ctx) {
  const { p } = ctx;
  const card = dangerZone();
  sectionEl.appendChild(card);
  const confirm = card.querySelector('.dz-confirm');
  const summary = card.querySelector('.dz-summary');
  const openBtn = card.querySelector('.dz-open');
  openBtn.addEventListener('click', async () => {
    openBtn.classList.add('hidden');
    confirm.classList.remove('hidden');
    summary.textContent = 'Counting affected resources\u2026';
    try {
      const prev = await window.QuestoraAPI.api.get(`/api/v1/projects/${p.id}/deletion-preview`);
      const c = prev.counts || {};
      summary.textContent = `This project holds ${c.campaigns} campaigns, ${c.quests} quests, ${c.tasks} tasks, ${c.rewards} rewards, ${c.completions} completions, ${c.xp_events} XP records and ${c.points_events} points records.`;
    } catch (err) { summary.textContent = err.message; }
  });
  card.querySelector('.dz-cancel').addEventListener('click', () => {
    confirm.classList.add('hidden'); openBtn.classList.remove('hidden');
  });
  card.querySelector('.dz-archive').addEventListener('click', async () => {
    try { await window.QuestoraAPI.api.del(`/api/v1/projects/${p.id}`); toast('Project archived'); window.history.pushState({}, '', '/projects'); window.dispatchEvent(new PopStateEvent('popstate')); }
    catch (err) { toast(err.message, true); }
  });
  card.querySelector('.dz-hard').addEventListener('click', async () => {
    try { await window.QuestoraAPI.api.del(`/api/v1/projects/${p.id}?mode=hard`); toast('Project permanently deleted'); window.history.pushState({}, '', '/projects'); window.dispatchEvent(new PopStateEvent('popstate')); }
    catch (err) { toast(err.message, true); }
  });
}

// ---------- notifications ----------
async function viewNotifications() {
  const wrap = el('<div></div>');
  mount(wrap);
  wrap.appendChild(el('<div class="flex items-center justify-between mb-4"><h1 class="text-2xl font-bold">Notifications</h1><button class="prefs text-sm text-violet-400">Preferences</button></div>'));
  const body = el('<div class="space-y-2"></div>');
  wrap.appendChild(body);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/notifications'); }
  catch (err) { body.appendChild(el(`<p class="text-sm text-red-400">${escapeHtml(err.message)}</p>`)); return; }
  if (!data.notifications.length) {
    body.appendChild(el('<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center"><p class="text-zinc-400">Nothing here yet.</p><p class="text-sm text-zinc-600 mt-1">Complete quests and follow campaigns to hear about it here.</p></div>'));
  } else {
    for (const n of data.notifications) {
      body.appendChild(el(`
        <a href="${escapeHtml(n.link || '#')}" class="block rounded-xl border ${n.read_at ? 'border-zinc-800' : 'border-violet-500/40'} bg-zinc-900/60 px-4 py-3">
          <p class="text-sm font-medium">${escapeHtml(n.title)}</p>
          <p class="text-sm text-zinc-400">${escapeHtml(n.body || '')}</p>
        </a>`));
    }
  }
  wrap.querySelector('.prefs').addEventListener('click', async () => {
    const prefs = await window.QuestoraAPI.api.get('/api/v1/notifications/prefs');
    const muted = prefs.prefs.muted || [];
    const panel = el(`
      <div class="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h2 class="font-semibold mb-3">Notification preferences</h2>
        <div class="space-y-2"></div>
        <button class="save mt-4 text-sm font-medium px-4 py-2 min-h-[44px] rounded-lg bg-violet-600 text-white">Save preferences</button>
      </div>`);
    const holder = panel.querySelector('.space-y-2');
    const kinds = [['quest_completed', 'Quest completed'], ['badge_earned', 'Badge earned'], ['level_up', 'Level up'], ['submission_rejected', 'Submission rejected'], ['campaign_completed', 'Campaign completed'], ['credential_earned', 'Credential issued'], ['referral_qualified', 'Invite qualified']];
    for (const [k, label] of kinds) {
      holder.appendChild(el(`<label class="flex items-center gap-3 rounded-lg border border-zinc-800 px-4 py-3 min-h-[44px] cursor-pointer"><input type="checkbox" data-kind="${k}" class="accent-violet-500" ${muted.includes(k) ? '' : 'checked'}><span class="text-sm">${label}</span></label>`));
    }
    panel.querySelector('.save').addEventListener('click', async () => {
      const nowMuted = [];
      panel.querySelectorAll('input[data-kind]').forEach(i => { if (!i.checked) nowMuted.push(i.dataset.kind); });
      await window.QuestoraAPI.api.patch('/api/v1/notifications/prefs', { muted: nowMuted });
      toast('Preferences saved');
    });
    wrap.appendChild(panel);
  });
  window.QuestoraAPI.api.post('/api/v1/notifications/read').catch(() => {});
}

// ---------- search (Phase 2) ----------
async function viewSearch(params) {
  const q = params.get('q') || '';
  const wrap = el('<div></div>');
  mount(wrap);
  wrap.appendChild(el('<h1 class="text-2xl font-bold mb-4">Search</h1>'));
  const form = el(`
    <form action="/search" method="get" class="flex gap-2 mb-6 max-w-xl">
      <input type="search" name="q" value="${escapeHtml(q)}" placeholder="Search projects, campaigns, quests, people" class="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm placeholder:text-zinc-600 focus:outline-none focus:border-violet-500">
      <button type="submit" class="font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Search</button>
    </form>`);
  wrap.appendChild(form);
  if (!q.trim()) {
    wrap.appendChild(el('<p class="text-sm text-zinc-600">Type something to search across projects, campaigns, quests and people.</p>'));
    return;
  }
  const body = el('<div class="space-y-8"></div>');
  wrap.appendChild(body);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/search?q=' + encodeURIComponent(q)); }
  catch (err) { body.replaceChildren(el(`<p class="text-sm text-red-400">${escapeHtml(err.message)}</p>`)); return; }

  function section(label, rows, renderRow, empty) {
    const sec = el(`<section><h2 class="text-sm font-medium text-zinc-500 mb-2 px-1">${escapeHtml(label)}</h2><div class="space-y-2"></div></section>`);
    const holder = sec.querySelector('div');
    if (!rows.length) holder.appendChild(el(`<p class="text-sm text-zinc-600 px-1">${escapeHtml(empty)}</p>`));
    for (const r of rows) holder.appendChild(renderRow(r));
    body.appendChild(sec);
  }
  section('People', data.users, u => el(`
    <a href="/u/${encodeURIComponent(u.username)}" class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40 transition-colors">
      <span class="w-8 h-8 rounded-full bg-violet-600/30 flex items-center justify-center text-xs font-bold text-violet-200">${escapeHtml((u.display_name || u.username).slice(0, 2).toUpperCase())}</span>
      <span class="min-w-0"><span class="block font-medium truncate">${escapeHtml(u.display_name || u.username)}</span><span class="block text-xs text-zinc-600">@${escapeHtml(u.username)}</span></span>
    </a>`), 'No people match.');
  section('Projects', data.projects, p => el(`
    <a href="/p/${encodeURIComponent(p.slug)}" class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40 transition-colors">
      <span class="min-w-0"><span class="block font-medium truncate">${escapeHtml(p.name)}</span><span class="block text-xs text-zinc-600 truncate">${escapeHtml(p.description || '')}</span></span>
    </a>`), 'No projects match.');
  section('Campaigns', data.campaigns, c => el(`
    <a href="/campaigns/${encodeURIComponent(c.slug)}" class="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40 transition-colors">
      <span class="min-w-0"><span class="block font-medium truncate">${escapeHtml(c.name)}</span><span class="block text-xs text-zinc-600">${escapeHtml(c.project_name)}</span></span>
      <span class="text-sm text-violet-300 font-medium shrink-0">+${c.total_xp} XP</span>
    </a>`), 'No live campaigns match.');
  section('Quests', data.quests, q => el(`
    <a href="/quest/${q.id}" class="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 hover:border-violet-500/40 transition-colors">
      <span class="min-w-0"><span class="block font-medium truncate">${escapeHtml(q.title)}</span><span class="block text-xs text-zinc-600">${escapeHtml(q.campaign_name)}</span></span>
      <span class="text-sm text-violet-300 font-medium shrink-0">+${q.xp_reward} XP</span>
    </a>`), 'No quests match.');
}

// ---------- join via invite (Phase 2) ----------
async function viewJoin(params) {
  const ref = params.get('ref') || '';
  const wrap = el('<div></div>');
  mount(wrap);
  const meData = await loadMe().catch(() => null);
  const node = el(`
    <div class="max-w-md mx-auto">
      <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center" id="join-card">
        <div class="text-3xl mb-3">🏅</div>
        <h1 class="text-xl font-bold mb-1">Join Questora</h1>
        <p class="text-sm text-zinc-500 mb-5" id="join-copy">Complete quests, earn XP and points, unlock badges.</p>
        <div id="join-action"></div>
      </div>
    </div>`);
  wrap.appendChild(node);
  const action = node.querySelector('#join-action');
  const copy = node.querySelector('#join-copy');

  if (!meData) {
    action.appendChild(el('<a href="/" class="inline-block font-medium px-5 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Open Questora</a>'));
    return;
  }
  if (!ref.trim()) {
    action.appendChild(el('<a href="/" class="inline-block font-medium px-5 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Explore campaigns</a>'));
    return;
  }
  const btn = el('<button class="font-medium px-5 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">Join now</button>');
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Joining…';
    try {
      const r = await window.QuestoraAPI.api.post('/api/v1/referrals/claim', { code: ref });
      copy.textContent = 'You joined under @' + r.referrer_username + '. Complete quests to finish your invite.';
      btn.remove();
    } catch (err) {
      copy.textContent = err.message;
      btn.remove();
    }
  });
  action.appendChild(btn);
  // Say who sent the invite before committing to it.
  try {
    const p = await window.QuestoraAPI.api.get('/api/v1/referrals/preview/' + encodeURIComponent(ref));
    copy.textContent = 'Invited by @' + p.username + '. Complete quests, earn XP and points, unlock badges.';
  } catch (e) { /* keep the default copy */ }
}

// ---------- public credential page (Phase 2) ----------
async function viewCredential(id) {
  const wrap = el('<div class="animate-pulse space-y-3"><div class="h-32 rounded-2xl bg-zinc-900"></div></div>');
  mount(wrap);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/credentials/' + encodeURIComponent(id)); }
  catch (err) { mount(errorCard(err.message)); return; }
  const c = data.credential;
  const criteriaText = c.criteria && (c.criteria.description || c.criteria.quest_title);
  const node = el(`
    <div class="max-w-xl mx-auto">
      <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center mb-6">
        <div class="text-4xl mb-3">🎖️</div>
        <h1 class="text-xl font-bold mb-1">${escapeHtml(c.title)}</h1>
        <p class="text-sm text-zinc-500 mb-4">Issued ${new Date(c.issued_at).toLocaleDateString()}${c.revoked ? ' · Revoked' : ''}</p>
        ${c.revoked ? statePill('rejected') : badgePill('Verified')}
        <div class="mt-6 space-y-3 text-left">
          <div class="rounded-xl border border-zinc-800 px-4 py-3">
            <p class="text-xs text-zinc-500">Issued by</p>
            ${c.issuer ? `<a href="/p/${escapeHtml(c.issuer.slug)}" class="font-medium text-violet-300 hover:underline">${escapeHtml(c.issuer.name)}</a>` : '<span class="font-medium">Questora</span>'}
          </div>
          <div class="rounded-xl border border-zinc-800 px-4 py-3">
            <p class="text-xs text-zinc-500">Held by</p>
            <a href="/u/${escapeHtml(c.recipient.username)}" class="font-medium text-violet-300 hover:underline">${escapeHtml(c.recipient.display_name || c.recipient.username)}</a>
            <span class="text-sm text-zinc-600"> @${escapeHtml(c.recipient.username)}</span>
          </div>
          ${criteriaText ? `<div class="rounded-xl border border-zinc-800 px-4 py-3"><p class="text-xs text-zinc-500">Criteria</p><p class="text-sm text-zinc-300">${escapeHtml(criteriaText)}</p></div>` : ''}
          ${c.expires_at ? `<div class="rounded-xl border border-zinc-800 px-4 py-3"><p class="text-xs text-zinc-500">Expires</p><p class="text-sm text-zinc-300">${new Date(c.expires_at).toLocaleDateString()}</p></div>` : ''}
        </div>
      </div>
      <p class="text-xs text-zinc-600 text-center break-all">Credential ID: ${escapeHtml(c.id)}</p>
    </div>`);
  mount(node);
}

// ---------- admin ----------
async function viewAdmin() {
  const wrap = el('<div></div>');
  mount(wrap);
  wrap.appendChild(el('<h1 class="text-2xl font-bold mb-1">Admin</h1><p class="text-sm text-zinc-500 mb-6">Platform administration. Every action is audited.</p>'));
  const body = el('<div class="space-y-8"></div>');
  wrap.appendChild(body);

  async function load() {
    body.replaceChildren();
    let meData;
    try { meData = await window.QuestoraAPI.api.get('/api/v1/users/me'); }
    catch { body.appendChild(el('<p class="text-sm text-red-400">Could not load your account.</p>')); return; }
    if (meData.user.role !== 'admin') {
      body.appendChild(el('<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6"><p class="text-zinc-300">Admin access required. Ask the platform admin to add your username to ADMIN_USERNAMES.</p></div>'));
      return;
    }
    const [users, projects, campaigns, review, settings, auditRes] = await Promise.all([
      window.QuestoraAPI.api.get('/api/v1/admin/users'), window.QuestoraAPI.api.get('/api/v1/admin/projects'), window.QuestoraAPI.api.get('/api/v1/admin/campaigns'),
      window.QuestoraAPI.api.get('/api/v1/admin/review'), window.QuestoraAPI.api.get('/api/v1/admin/settings'), window.QuestoraAPI.api.get('/api/v1/admin/audit'),
    ]);

    const usersSec = el('<section><h2 class="text-sm font-medium text-zinc-500 mb-2">Users</h2><p class="text-xs text-zinc-600 mb-2">Admin access comes from the ADMIN_USERNAMES secret, so roles cannot be granted here.</p><div class="u-list space-y-2"></div></section>');
    const ul = usersSec.querySelector('.u-list');
    for (const u of users.users) {
      const row = el(`
        <div class="u-row">
          <div class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <span class="min-w-0 flex-1"><span class="block text-sm font-medium truncate">${escapeHtml(u.display_name || u.username)}</span><span class="block text-xs text-zinc-600">@${escapeHtml(u.username)} · ${u.xp} XP</span></span>
            ${statePill(u.risk_state || 'normal')}
            <span class="role-pill text-xs px-2 py-1 rounded-full ${u.role === 'admin' ? 'bg-violet-600/20 text-violet-300' : 'bg-zinc-800 text-zinc-400'}">${escapeHtml(u.role)}</span>
            <button class="risk text-xs px-3 py-2 min-h-[44px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">Risk</button>
          </div>
          <div class="risk-detail"></div>
        </div>`);
      // Admin status is configuration, not a toggle: it comes from the
      // ADMIN_USERNAMES secret and the server refuses role changes.
      // Risk explainer (Phase 3): the signals behind the account's state.
      row.querySelector('.risk').addEventListener('click', async () => {
        const slot = row.querySelector('.risk-detail');
        if (slot.childElementCount) { slot.replaceChildren(); return; }
        try {
          const r = await window.QuestoraAPI.api.get(`/api/v1/admin/users/${u.id}/risk`);
          const panel = el('<div class="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 mt-1 mb-2 mx-1 text-sm"></div>');
          panel.appendChild(el(`<p class="text-xs text-zinc-500 mb-2">Signals for @${escapeHtml(r.user.username)}. State: ${escapeHtml(r.user.risk_state)}. The engine only escalates; clear it here:</p>`));
          const clear = el('<button class="text-xs px-3 py-2 min-h-[36px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 mb-2">Reset state to normal</button>');
          clear.addEventListener('click', async () => {
            try { await window.QuestoraAPI.api.patch(`/api/v1/admin/users/${u.id}`, { risk_state: 'normal', reason: 'Risk state cleared from admin panel' }); toast('State reset'); load(); }
            catch (err) { toast(err.message, true); }
          });
          panel.appendChild(clear);
          const list = el('<div class="space-y-1"></div>');
          if (!r.signals.length) list.appendChild(el('<p class="text-zinc-600">No signals recorded. The engine watches completion velocity, duplicate proof hashes and referral graphs.</p>'));
          for (const s of r.signals) {
            const d = s.detail || {};
            list.appendChild(el(`<div class="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 px-3 py-2">
              <span class="min-w-0"><span class="block text-zinc-200">${escapeHtml(String(s.signal).replace(/_/g, ' '))}${s.signal_key ? ' <span class="text-zinc-600 font-mono text-xs">' + escapeHtml(s.signal_key) + '</span>' : ''}</span>
              <span class="block text-xs text-zinc-600">${escapeHtml(d.reason || d.detail || '')} · ${new Date(s.created_at).toLocaleString()}</span></span>
              <span class="font-mono text-xs ${s.severity >= 3 ? 'text-red-300' : 'text-amber-300'}">+${s.severity}</span>
            </div>`));
          }
          panel.appendChild(list);
          slot.appendChild(panel);
        } catch (err) { toast(err.message, true); }
      });
      ul.appendChild(row);
    }
    body.appendChild(usersSec);

    // Seasons (Phase 3): list + create form.
    let seasonsRes = { seasons: [] };
    try { seasonsRes = await window.QuestoraAPI.api.get('/api/v1/admin/seasons'); } catch {}
    const seaSec = el('<section><h2 class="text-sm font-medium text-zinc-500 mb-2">Seasons</h2><div class="s-list space-y-2 mb-3"></div><div class="grid md:grid-cols-4 gap-2"><input class="s-name rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm text-zinc-200 focus:outline-none" placeholder="Season name"><input class="s-start rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm text-zinc-200 focus:outline-none" type="datetime-local" aria-label="Starts at"><input class="s-end rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm text-zinc-200 focus:outline-none" type="datetime-local" aria-label="Ends at"><input class="s-mult rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 min-h-[44px] text-sm text-zinc-200 focus:outline-none" type="number" step="0.1" min="0.1" max="10" value="1" aria-label="XP multiplier"></div><button class="save-season mt-3 text-sm font-medium px-4 py-2 min-h-[44px] rounded-lg bg-violet-600 text-white">Create season</button></section>');
    const sl = seaSec.querySelector('.s-list');
    if (!seasonsRes.seasons.length) sl.appendChild(el('<p class="text-sm text-zinc-600">No seasons yet. XP is not boosted until one is active.</p>'));
    for (const s of seasonsRes.seasons) {
      sl.appendChild(el(`<div class="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
        <span class="min-w-0"><span class="block text-sm font-medium truncate">${escapeHtml(s.name)}</span>
        <span class="block text-xs text-zinc-600">${new Date(s.starts_at).toLocaleDateString()} to ${new Date(s.ends_at).toLocaleDateString()} · ${Number(s.xp_multiplier)}x XP</span></span>
        ${statePill(s.status || '')}
      </div>`));
    }
    seaSec.querySelector('.save-season').addEventListener('click', async () => {
      const name = seaSec.querySelector('.s-name').value.trim();
      const start = seaSec.querySelector('.s-start').value;
      const end = seaSec.querySelector('.s-end').value;
      const mult = seaSec.querySelector('.s-mult').value;
      if (!name || !start || !end) { toast('Name, start and end dates are required'); return; }
      try {
        await window.QuestoraAPI.api.post('/api/v1/admin/seasons', {
          name,
          starts_at: new Date(start).toISOString(),
          ends_at: new Date(end).toISOString(),
          xp_multiplier: Number(mult) || 1,
        });
        toast('Season created');
        load();
      } catch (err) { toast(err.message, true); }
    });
    body.appendChild(seaSec);

    const campSec = el('<section><h2 class="text-sm font-medium text-zinc-500 mb-2">Campaigns</h2><div class="c-list space-y-2"></div></section>');
    const cl = campSec.querySelector('.c-list');
    for (const c of campaigns.campaigns) {
      const row = el(`
        <div class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <span class="min-w-0 flex-1"><span class="block text-sm font-medium truncate">${escapeHtml(c.name)}</span><span class="block text-xs text-zinc-600">${escapeHtml(c.project_name)} · ${escapeHtml(c.status)}</span></span>
          <button class="pause text-xs px-3 py-2 min-h-[44px] rounded-lg bg-zinc-800 hover:bg-zinc-700">${c.status === 'paused' ? 'Resume' : 'Pause'}</button>
          <button class="archive text-xs px-3 py-2 min-h-[44px] rounded-lg bg-zinc-800 hover:bg-red-600">Archive</button>
        </div>`);
      row.querySelector('.pause').addEventListener('click', async () => {
        try { await window.QuestoraAPI.api.patch(`/api/v1/campaigns/${c.id}`, { status: c.status === 'paused' ? 'active' : 'paused', reason: 'Admin panel' }); toast('Updated'); load(); }
        catch (err) { toast(err.message, true); }
      });
      row.querySelector('.archive').addEventListener('click', async () => {
        try { await window.QuestoraAPI.api.patch(`/api/v1/campaigns/${c.id}`, { status: 'archived', reason: 'Admin panel' }); toast('Archived'); load(); }
        catch (err) { toast(err.message, true); }
      });
      cl.appendChild(row);
    }
    body.appendChild(campSec);

    const revSec = el('<section><h2 class="text-sm font-medium text-zinc-500 mb-2">Review queue</h2><div class="r-list space-y-2"></div></section>');
    const rl = revSec.querySelector('.r-list');
    if (!review.submissions.length) rl.appendChild(el('<p class="text-sm text-zinc-600">Nothing pending.</p>'));
    for (const s of review.submissions) {
      rl.appendChild(el(`<div class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3"><span class="text-sm flex-1 min-w-0 truncate">@${escapeHtml(s.username)} · ${escapeHtml(s.quest_title)}</span><a href="/quest/${s.quest_id}" class="text-xs text-violet-300">Open</a></div>`));
    }
    body.appendChild(revSec);

    const setSec = el('<section><h2 class="text-sm font-medium text-zinc-500 mb-2">Level thresholds</h2><div class="t-list space-y-2"></div><button class="save-thr mt-3 text-sm font-medium px-4 py-2 min-h-[44px] rounded-lg bg-violet-600 text-white">Save thresholds</button></section>');
    const tl = setSec.querySelector('.t-list');
    for (const t of settings.thresholds) {
      tl.appendChild(el(`<div class="flex items-center gap-3"><span class="text-sm text-zinc-400 w-20">Level ${t.level}</span><input type="number" min="0" data-level="${t.level}" value="${t.min_xp}" class="min-xp w-40 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500"></div>`));
    }
    setSec.querySelector('.save-thr').addEventListener('click', async () => {
      const thresholds = [];
      setSec.querySelectorAll('input[data-level]').forEach(i => thresholds.push({ level: i.dataset.level, min_xp: i.value }));
      try { await window.QuestoraAPI.api.patch('/api/v1/admin/settings', { thresholds, reason: 'Threshold edit from admin panel' }); toast('Saved'); }
      catch (err) { toast(err.message, true); }
    });
    body.appendChild(setSec);

    const auditSec = el('<section><h2 class="text-sm font-medium text-zinc-500 mb-2">Audit log</h2><div class="a-list space-y-1"></div></section>');
    const al = auditSec.querySelector('.a-list');
    if (!auditRes.entries.length) al.appendChild(el('<p class="text-sm text-zinc-600">No admin actions yet.</p>'));
    for (const a of auditRes.entries.slice(0, 30)) {
      al.appendChild(el(`<div class="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-sm text-zinc-400"><span class="text-zinc-200 font-medium">${escapeHtml(a.actor || 'system')}</span> ${escapeHtml(a.action)} on ${escapeHtml(a.entity_type)} #${a.entity_id} · ${new Date(a.created_at).toLocaleString()}</div>`));
    }
    body.appendChild(auditSec);
  }
  load();
}

window.QV = { viewDiscover, viewCampaigns, viewCampaign, viewQuest, viewProfile, viewLeaderboard, viewTeams, viewCreate, viewProject, viewNotifications, viewAdmin, viewSearch, viewJoin, viewCredential, loadMe,
  viewProjects, viewProjectOverview, viewProjectCampaigns, viewProjectQuests, viewCampaignDetail, viewQuestDetail, viewScopedLeaderboard, viewLeaderboardHub, viewDashboard, resolveCampaignPath };

bindQUI();
return window.QV;
})();
