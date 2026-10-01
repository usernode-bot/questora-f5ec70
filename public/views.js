window.QV = (function () {
'use strict';
var el, escapeHtml, toast, campaignCard, sectionRow, timeLeft, levelRing, badgePill, statePill;
function bindQUI() { var q = window.QUI; el = q.el; escapeHtml = q.escapeHtml; toast = q.toast; campaignCard = q.campaignCard; sectionRow = q.sectionRow; timeLeft = q.timeLeft; levelRing = q.levelRing; badgePill = q.badgePill; statePill = q.statePill; }
bindQUI();
// View renderers. Each returns a DocumentFragment-ish element appended by
// app.js. Data comes from /api/v1 via api.js; nothing renders a completion
// state the server did not send.

const app = () => document.getElementById('app');
const me = { data: null };
async function loadMe() {
  if (me.data) return me.data;
  try { me.data = await window.QuestoraAPI.api.get('/api/v1/users/me'); } catch { me.data = null; }
  return me.data;
}

// ---------- discovery ----------
async function viewDiscover() {
  const wrap = el('<div></div>');
  app().replaceChildren(wrap);
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
  const status = params.get('status') === 'scheduled' || params.get('status') === 'ended'
    ? params.get('status') : 'live';
  const wrap = el('<div></div>');
  app().replaceChildren(wrap);
  wrap.appendChild(el(`
    <div>
      <h1 class="text-2xl font-bold mb-1">Campaigns</h1>
      <p class="text-sm text-zinc-500 mb-4">Every campaign on Questora, filtered by state.</p>
      <div class="flex gap-1 bg-zinc-900 rounded-full p-1 border border-zinc-800 mb-5 w-fit">
        <a href="/campaigns" class="px-4 py-1.5 rounded-full text-sm font-medium ${status === 'live' ? 'bg-violet-600 text-white' : 'text-zinc-400'}">Live</a>
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
  app().replaceChildren(wrap);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/campaigns/' + encodeURIComponent(slug)); }
  catch (err) {
    wrap.replaceChildren(el(`<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6"><p class="text-zinc-300">${escapeHtml(err.message)}</p></div>`));
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
  wrap.replaceChildren(node);

  // Join button: the server only accepts joins on live campaigns.
  if (data.joined === false && c.status === 'live') {
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
  app().replaceChildren(wrap);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/quests/' + encodeURIComponent(id)); }
  catch (err) { wrap.replaceChildren(el(`<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6"><p class="text-zinc-300">${escapeHtml(err.message)}</p></div>`)); return; }
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
  wrap.replaceChildren(node);
  // A locked quest explains itself and offers no actions.
  if (q.locked) {
    node.querySelector('.lock-banner').appendChild(el(`
      <div class="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
        <p class="text-sm text-amber-200">${escapeHtml(q.locked_reason || 'This quest is locked.')}</p>
      </div>`));
  }
  const list = node.querySelector('.task-list');

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
    const ch = await window.QuestoraAPI.api.post('/api/v1/wallets/challenge', { address });
    const signature = await window.QuestoraAPI.signMessage(address, ch.message);
    await window.QuestoraAPI.api.post('/api/v1/wallets/verify', { address, signature, nonce: ch.nonce });
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
          viewQuest(q.id);
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
          viewQuest(q.id);
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
          viewQuest(q.id);
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
        viewQuest(q.id);
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
  app().replaceChildren(wrap);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/users/' + encodeURIComponent(username)); }
  catch (err) { wrap.replaceChildren(el(`<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6"><p class="text-zinc-300">${escapeHtml(err.message)}</p></div>`)); return; }
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
        <button data-tab="activity" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Activity</button>
        <button data-tab="badges" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Badges</button>
        <button data-tab="credentials" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Credentials</button>
        <button data-tab="reputation" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Reputation</button>
        <button data-tab="achievements" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Achievements</button>
      </div>
      <div class="tab-body"></div>
      <div class="invite-slot mt-6"></div>
    </div>`);
  wrap.replaceChildren(node);
  // levelRing builds a DOM node, so it is inserted here rather than
  // interpolated into the template above (which would stringify it).
  node.querySelector('.level-ring-slot').appendChild(levelRing(u.level, progress));
  const body = node.querySelector('.tab-body');
  const inviteSlot = node.querySelector('.invite-slot');
  function show(tab) {
    node.querySelectorAll('.tab').forEach(b => {
      const on = b.dataset.tab === tab;
      b.className = 'tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium ' + (on ? 'bg-violet-600 text-white' : 'bg-zinc-800/70 text-zinc-400');
    });
    body.replaceChildren();
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
  show(['badges', 'credentials', 'reputation', 'achievements'].includes(initialTab) ? initialTab : 'activity');

  // Own profile: the invite block (Phase 2 referrals).
  const meData = await loadMe();
  if (meData && meData.user && (meData.user.username || '').toLowerCase() === String(username).toLowerCase()) {
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
  app().replaceChildren(wrap);
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
  app().replaceChildren(wrap);
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
  app().replaceChildren(wrap);
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
        name: v('.cp-name'), description: v('.cp-desc'), category: form.querySelector('.cp-cat').value, status: 'live',
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
      toast('Campaign published');
      location.hash = '';
      window.history.pushState({}, '', '/campaigns/' + camp.campaign.slug);
      router();
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
  app().replaceChildren(wrap);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/projects/' + encodeURIComponent(slug)); }
  catch (err) { wrap.replaceChildren(el(`<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6"><p class="text-zinc-300">${escapeHtml(err.message)}</p></div>`)); return; }
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
  wrap.replaceChildren(node);
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

// ---------- notifications ----------
async function viewNotifications() {
  const wrap = el('<div></div>');
  app().replaceChildren(wrap);
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
  app().replaceChildren(wrap);
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
  app().replaceChildren(wrap);
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
  app().replaceChildren(wrap);
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/credentials/' + encodeURIComponent(id)); }
  catch (err) { wrap.replaceChildren(el(`<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6"><p class="text-zinc-300">${escapeHtml(err.message)}</p></div>`)); return; }
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
  wrap.replaceChildren(node);
}

// ---------- admin ----------
async function viewAdmin() {
  const wrap = el('<div></div>');
  app().replaceChildren(wrap);
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
        try { await window.QuestoraAPI.api.patch(`/api/v1/campaigns/${c.id}`, { status: c.status === 'paused' ? 'live' : 'paused', reason: 'Admin panel' }); toast('Updated'); load(); }
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

window.QV = { viewDiscover, viewCampaigns, viewCampaign, viewQuest, viewProfile, viewLeaderboard, viewTeams, viewCreate, viewProject, viewNotifications, viewAdmin, viewSearch, viewJoin, viewCredential, loadMe };

bindQUI();
return { viewDiscover, viewCampaigns, viewCampaign, viewQuest, viewProfile, viewLeaderboard, viewTeams, viewCreate, viewProject, viewNotifications, viewAdmin, viewSearch, viewJoin, viewCredential, loadMe };
})();
