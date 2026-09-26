window.QUI = (function () {
'use strict';
// Shared UI building blocks. Every class name is a whole literal so the
// precompiled Tailwind stylesheet covers it.
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(message, isError) {
  const holder = document.getElementById('toast-holder');
  const node = el(`<div class="fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-50 ${isError ? 'bg-red-600' : 'bg-violet-600'} text-white text-sm px-4 py-2.5 rounded-full shadow-lg shadow-violet-900/40 transition-opacity duration-200">${escapeHtml(message)}</div>`);
  holder.appendChild(node);
  setTimeout(() => { node.style.opacity = '0'; }, 2400);
  setTimeout(() => node.remove(), 2800);
}

function campaignCard(c) {
  const endsIn = c.ends_at ? timeLeft(c.ends_at) : null;
  return el(`
    <a href="/campaigns/${c.slug}" class="block rounded-2xl border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-900 hover:border-violet-500/40 transition-colors p-5 min-w-[260px] md:min-w-0">
      <div class="flex items-center gap-2 mb-2">
        ${c.project_logo ? `<img src="${escapeHtml(c.project_logo)}" alt="" class="w-5 h-5 rounded-full">` : `<span class="w-5 h-5 rounded-full bg-violet-600/30 inline-block"></span>`}
        <span class="text-xs text-zinc-500">${escapeHtml(c.project_name)}</span>
        ${c.status !== 'live' ? `<span class="ml-auto text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400">${escapeHtml(c.status)}</span>` : ''}
      </div>
      <h3 class="font-semibold text-zinc-100 mb-1 leading-snug">${escapeHtml(c.name)}</h3>
      <p class="text-sm text-zinc-400 line-clamp-2 mb-3">${escapeHtml(c.description || '')}</p>
      <div class="flex items-center gap-3 text-xs text-zinc-500">
        <span class="text-violet-300 font-medium">+${c.total_xp} XP</span>
        <span>${c.quest_count} quests</span>
        <span>${c.participants} joined</span>
        ${endsIn ? `<span class="ml-auto">${endsIn}</span>` : ''}
      </div>
    </a>`);
}

function sectionRow(label, cards, emptyText) {
  if (!cards.length) {
    return el(`
      <section class="mb-8">
        <h2 class="text-sm font-medium text-zinc-500 mb-2 px-1">${escapeHtml(label)}</h2>
        <p class="text-sm text-zinc-600 px-1">${escapeHtml(emptyText || 'Nothing here yet')}</p>
      </section>`);
  }
  const row = el(`
    <section class="mb-8">
      <h2 class="text-sm font-medium text-zinc-500 mb-2 px-1">${escapeHtml(label)}</h2>
      <div class="flex gap-4 overflow-x-auto pb-2 md:grid md:grid-cols-3 md:overflow-visible -mx-1 px-1"></div>
    </section>`);
  const holder = row.querySelector('div');
  for (const c of cards) holder.appendChild(campaignCard(c));
  return row;
}

function timeLeft(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'Ended';
  const days = Math.floor(ms / 864e5);
  if (days >= 1) return `${days}d left`;
  const hours = Math.floor(ms / 36e5);
  if (hours >= 1) return `${hours}h left`;
  return 'Ending soon';
}

function levelRing(level, pct) {
  return el(`
    <div class="relative w-20 h-20 shrink-0">
      <svg viewBox="0 0 36 36" class="w-20 h-20 -rotate-90">
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="#27272a" stroke-width="3"></circle>
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="#8b5cf6" stroke-width="3" stroke-linecap="round" stroke-dasharray="${pct} ${100 - pct}"></circle>
      </svg>
      <span class="absolute inset-0 flex items-center justify-center text-xl font-bold">${level}</span>
    </div>`);
}

const badgePill = (text) => `<span class="inline-block text-xs font-medium px-2.5 py-1 rounded-full bg-violet-600/20 text-violet-300">${escapeHtml(text)}</span>`;
const statePill = (status) => {
  const map = {
    pending: 'bg-amber-500/15 text-amber-300',
    verified: 'bg-emerald-500/15 text-emerald-300',
    rejected: 'bg-red-500/15 text-red-300',
    live: 'bg-emerald-500/15 text-emerald-300',
    scheduled: 'bg-sky-500/15 text-sky-300',
    ended: 'bg-zinc-700/50 text-zinc-400',
    archived: 'bg-zinc-700/50 text-zinc-400',
    draft: 'bg-zinc-800 text-zinc-400',
    paused: 'bg-amber-500/15 text-amber-300',
  };
  const cls = map[status] || 'bg-zinc-800 text-zinc-400';
  const label = status === 'pending' ? 'Pending review' : status.charAt(0).toUpperCase() + status.slice(1);
  return `<span class="inline-block text-xs font-medium px-2.5 py-1 rounded-full ${cls}">${label}</span>`;
};

return { el, escapeHtml, toast, campaignCard, sectionRow, timeLeft, levelRing, badgePill, statePill };

})();
