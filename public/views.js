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
  wrap.appendChild(el('<div><h1 class="text-2xl font-bold mb-1">Explore</h1><p class="text-sm text-zinc-500 mb-6">Campaigns you can join right now.</p></div>'));
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
      </div>
      <h2 class="text-sm font-medium text-zinc-500 mb-2 px-1">Quests</h2>
      <div class="quest-list space-y-3"></div>
    </div>`);
  wrap.replaceChildren(node);
  const list = node.querySelector('.quest-list');
  for (const q of data.quests) {
    list.appendChild(el(`
      <a href="/quest/${q.id}" class="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 hover:border-violet-500/40 transition-colors p-4">
        <span class="task-circle w-6 h-6 rounded-full border-2 border-zinc-700 shrink-0 flex items-center justify-center"></span>
        <span class="min-w-0">
          <span class="block font-medium ${q.is_required ? 'text-zinc-100' : 'text-zinc-400'}">${escapeHtml(q.title)}${q.is_required ? '' : ' <span class="text-xs text-zinc-600">(optional)</span>'}</span>
          <span class="block text-sm text-zinc-500 truncate">${escapeHtml(q.description || '')}</span>
        </span>
        <span class="ml-auto text-sm text-violet-300 font-medium shrink-0">+${q.xp_reward} XP</span>
      </a>`));
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
      <h2 class="text-sm font-medium text-zinc-500 mb-2 px-1">Checklist</h2>
      <div class="task-list space-y-3"></div>
      <div class="result mt-6"></div>
    </div>`);
  wrap.replaceChildren(node);
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
      actionFor(t, actionArea);
    }
    return row;
  }

  function actionFor(t, holder) {
    holder.replaceChildren();
    if (t.type === 'wallet_connect') {
      const b = el('<button class="connect w-full md:w-auto font-medium px-5 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white">Connect wallet</button>');
      b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'Waiting for signature…';
        try {
          const ch = await window.QuestoraAPI.api.post('/api/v1/wallets/challenge', {});
          const sig = await window.QuestoraAPI.signMessage('0x0000000000000000000000000000000000000000', ch.message);
          throw new Error('Wallet signature mismatch. Reconnect your wallet and try again.');
        } catch (err) {
          toast(err.message.replace('Questora wallet verification', ''), true);
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
async function viewProfile(username) {
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
        ${levelRing(u.level, progress)}
        <div class="min-w-0">
          <h1 class="text-xl font-bold">${escapeHtml(u.display_name || u.username)}</h1>
          <p class="text-sm text-zinc-500">@${escapeHtml(u.username)}</p>
          <div class="flex flex-wrap gap-2 mt-2">
            ${badgePill(u.xp + ' XP')}${badgePill(u.points + ' points')}${badgePill('Rank #' + data.leaderboard_rank)}
          </div>
          ${u.next ? `<p class="text-xs text-zinc-600 mt-2">${u.next.min_xp - u.xp} XP to level ${u.next.level}</p>` : ''}
        </div>
      </div>
      <div class="tabs flex gap-2 mb-4">
        <button data-tab="activity" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Activity</button>
        <button data-tab="badges" class="tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium">Badges</button>
      </div>
      <div class="tab-body"></div>
    </div>`);
  wrap.replaceChildren(node);
  const body = node.querySelector('.tab-body');
  function show(tab) {
    node.querySelectorAll('.tab').forEach(b => {
      const on = b.dataset.tab === tab;
      b.className = 'tab px-4 py-2 min-h-[44px] rounded-full text-sm font-medium ' + (on ? 'bg-violet-600 text-white' : 'bg-zinc-800/70 text-zinc-400');
    });
    body.replaceChildren();
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
  show('activity');
}

// ---------- leaderboard ----------
async function viewLeaderboard(params) {
  const by = params.get('by') === 'points' ? 'points' : 'xp';
  const wrap = el('<div></div>');
  app().replaceChildren(wrap);
  wrap.appendChild(el(`
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-2xl font-bold">Leaderboard</h1>
      <div class="flex gap-1 bg-zinc-900 rounded-full p-1 border border-zinc-800">
        <a href="/leaderboard?by=xp" class="px-4 py-1.5 rounded-full text-sm font-medium ${by === 'xp' ? 'bg-violet-600 text-white' : 'text-zinc-400'}">XP</a>
        <a href="/leaderboard?by=points" class="px-4 py-1.5 rounded-full text-sm font-medium ${by === 'points' ? 'bg-violet-600 text-white' : 'text-zinc-400'}">Points</a>
      </div>
    </div>`));
  let data;
  try { data = await window.QuestoraAPI.api.get('/api/v1/leaderboard?by=' + by); }
  catch (err) { wrap.appendChild(el(`<p class="text-zinc-400">${escapeHtml(err.message)}</p>`)); return; }
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
      extra.appendChild(el('<p class="text-sm text-zinc-500">A starter question is included. Edit quizzes later from your project page.</p>'));
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
        task.config = { pass_score: 80, questions: [{ q: 'Is this a staging demo quiz?', options: ['Yes', 'No'], answer: 0 }] };
      }
      const quest = await window.QuestoraAPI.api.post(`/api/v1/campaigns/${camp.campaign.id}/quests`, {
        title: v('.q-title'), xp_reward: parseInt(v('.q-xp'), 10) || 0, points_reward: Math.round((parseInt(v('.q-xp'), 10) || 0) / 2), tasks: [task],
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
async function viewProject(slug) {
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
  show('campaigns');
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
    const kinds = [['quest_completed', 'Quest completed'], ['badge_earned', 'Badge earned'], ['level_up', 'Level up'], ['submission_rejected', 'Submission rejected'], ['campaign_completed', 'Campaign completed']];
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

// ---------- admin ----------
async function viewAdmin() {
  const wrap = el('<div></div>');
  app().replaceChildren(wrap);
  wrap.appendChild(el('<h1 class="text-2xl font-bold mb-1">Admin</h1><p class="text-sm text-zinc-500 mb-6">Platform administration. Every action is audited.</p>'));
  const body = el('<div class="space-y-8"></div>');
  wrap.appendChild(body);

  async function load() {
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

    const usersSec = el('<section><h2 class="text-sm font-medium text-zinc-500 mb-2">Users</h2><div class="u-list space-y-2"></div></section>');
    const ul = usersSec.querySelector('.u-list');
    for (const u of users.users) {
      const row = el(`
        <div class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <span class="min-w-0 flex-1"><span class="block text-sm font-medium truncate">${escapeHtml(u.display_name || u.username)}</span><span class="block text-xs text-zinc-600">@${escapeHtml(u.username)} · ${u.xp} XP · ${escapeHtml(u.risk_state)}</span></span>
          <span class="role-pill text-xs px-2 py-1 rounded-full ${u.role === 'admin' ? 'bg-violet-600/20 text-violet-300' : 'bg-zinc-800 text-zinc-400'}">${escapeHtml(u.role)}</span>
          <button class="toggle text-xs px-3 py-2 min-h-[44px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">${u.role === 'admin' ? 'Make user' : 'Make admin'}</button>
        </div>`);
      row.querySelector('.toggle').addEventListener('click', async () => {
        try { await window.QuestoraAPI.api.patch(`/api/v1/admin/users/${u.id}`, { role: u.role === 'admin' ? 'user' : 'admin', reason: 'Role changed from admin panel' }); toast('Role updated'); load(); }
        catch (err) { toast(err.message, true); }
      });
      ul.appendChild(row);
    }
    body.appendChild(usersSec);

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

window.QV = { viewDiscover, viewCampaign, viewQuest, viewProfile, viewLeaderboard, viewCreate, viewProject, viewNotifications, viewAdmin, loadMe };

bindQUI();
return { viewDiscover, viewCampaign, viewQuest, viewProfile, viewLeaderboard, viewCreate, viewProject, viewNotifications, viewAdmin, loadMe };
})();
