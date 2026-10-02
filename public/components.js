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
        ${c.status !== 'active' ? `<span class="ml-auto text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400">${escapeHtml(c.status)}</span>` : ''}
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
    // Verification enum (on-chain tasks). Amber for waiting and
    // infrastructure, red only for a genuine failure, sky for indexing, grey
    // for expired or not set up.
    VERIFIED: 'bg-emerald-500/15 text-emerald-300',
    FAILED: 'bg-red-500/15 text-red-300',
    EXPIRED: 'bg-zinc-700/50 text-zinc-400',
    PENDING: 'bg-amber-500/15 text-amber-300',
    WAITING_CONFIRMATIONS: 'bg-amber-500/15 text-amber-300',
    INDEXING_DELAY: 'bg-sky-500/15 text-sky-300',
    RPC_UNAVAILABLE: 'bg-amber-500/15 text-amber-300',
    MANUAL_REVIEW: 'bg-amber-500/15 text-amber-300',
    INVALID_CONFIGURATION: 'bg-zinc-700/50 text-zinc-400',
    // Phase 3 states: seasons and the risk engine.
    active: 'bg-emerald-500/15 text-emerald-300',
    upcoming: 'bg-sky-500/15 text-sky-300',
    normal: 'bg-emerald-500/15 text-emerald-300',
    review: 'bg-amber-500/15 text-amber-300',
    suspicious: 'bg-red-500/15 text-red-300',
    blocked: 'bg-red-500/15 text-red-300',
  };
  const labels = {
    pending: 'Pending review',
    VERIFIED: 'Verified',
    FAILED: 'Not met',
    EXPIRED: 'Expired',
    PENDING: 'Pending',
    WAITING_CONFIRMATIONS: 'Waiting for confirmations',
    INDEXING_DELAY: 'Indexing delay',
    RPC_UNAVAILABLE: 'Temporarily unavailable',
    MANUAL_REVIEW: 'Manual review',
    INVALID_CONFIGURATION: 'Not set up',
  };
  const cls = map[status] || 'bg-zinc-800 text-zinc-400';
  const label = labels[status] || (status ? status.charAt(0).toUpperCase() + status.slice(1) : '');
  return `<span class="inline-block text-xs font-medium px-2.5 py-1 rounded-full ${cls}">${label}</span>`;
};

// Hierarchical navigation: Project -> Campaign -> Quest. Each item is
// { label, href }; the last one is the current page and is not a link.
function breadcrumb(items) {
  const parts = [];
  items.forEach((it, i) => {
    if (i > 0) parts.push('<span class="text-zinc-600" aria-hidden="true">/</span>');
    const last = i === items.length - 1;
    if (last || !it.href) {
      parts.push(`<span class="text-zinc-300">${escapeHtml(it.label)}</span>`);
    } else {
      parts.push(`<a href="${escapeHtml(it.href)}" class="text-zinc-500 hover:text-violet-300">${escapeHtml(it.label)}</a>`);
    }
  });
  return `<nav class="flex items-center flex-wrap gap-1.5 text-xs mb-3" aria-label="Breadcrumb">${parts.join('')}</nav>`;
}

// The banner a scoped leaderboard (or a scoped directory) leads with. Plain
// language: whose ranking this is, or what lives under this scope.
function scopeBanner(title, scopeLabel, subtitle) {
  return `<div class="rounded-2xl border border-zinc-800 bg-gradient-to-b from-violet-600/20 to-transparent p-5 mb-4">
    <p class="text-xs uppercase tracking-wide text-violet-300 mb-1">${escapeHtml(scopeLabel)}</p>
    <h1 class="text-xl font-bold">${escapeHtml(title)}</h1>
    ${subtitle ? `<p class="text-sm text-zinc-400 mt-1">${escapeHtml(subtitle)}</p>` : ''}
  </div>`;
}

function statCard(label, value, accent) {
  return `<div class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
    <p class="text-xs text-zinc-500">${escapeHtml(label)}</p>
    <p class="text-xl font-bold ${accent || ''}">${escapeHtml(String(value))}</p>
  </div>`;
}

function pager(page, hasMore, makeHref) {
  const holder = el('<div class="flex items-center justify-center gap-3 mt-4"></div>');
  if (page > 1) {
    const prev = el(`<a href="${escapeHtml(makeHref(page - 1))}" class="text-sm font-medium px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200">Previous</a>`);
    holder.appendChild(prev);
  }
  holder.appendChild(el(`<span class="text-sm text-zinc-500">Page ${page}</span>`));
  if (hasMore) {
    holder.appendChild(el(`<a href="${escapeHtml(makeHref(page + 1))}" class="text-sm font-medium px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200">Next</a>`));
  }
  return holder;
}

// Empty state with a plain next step.
function emptyState(text, actionLabel, actionHref) {
  const action = actionLabel
    ? `<a href="${escapeHtml(actionHref || '#')}" class="inline-block mt-3 font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">${escapeHtml(actionLabel)}</a>`
    : '';
  return `<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center">
    <p class="text-zinc-400">${escapeHtml(text)}</p>${action}</div>`;
}

// Per-member ability toggles for the ownership roster. Each row is one
// explicit override; leaving it alone falls back to the role's default.
// lockDelete disables the one ability only the owner may hand out.
function permissionList(actions, permissions, lockDelete) {
  const perms = permissions || {};
  const holder = el('<div class="flex flex-wrap gap-x-3 gap-y-1.5"></div>');
  for (const a of actions) {
    const granted = Object.prototype.hasOwnProperty.call(perms, a) ? !!perms[a] : null;
    const locked = lockDelete && a === 'delete_project';
    holder.appendChild(el(`<label class="flex items-center gap-1.5 text-[11px] text-zinc-400">
      <input type="checkbox" class="perm-toggle accent-violet-500" data-action="${escapeHtml(a)}" ${granted === true ? 'checked' : ''} ${locked ? 'disabled' : ''}>
      <span>${escapeHtml(a.replace(/_/g, ' '))}</span>
    </label>`));
  }
  return holder;
}

// The project deletion card: two steps, archive-first. Only rendered for a
// caller that holds delete_project.
function dangerZone() {
  return el(`<div class="rounded-xl border border-red-900/60 bg-red-950/20 p-4 max-w-xl">
    <h2 class="font-semibold mb-1 text-red-300">Danger zone</h2>
    <p class="text-xs text-zinc-400 mb-3">Archiving hides the project and keeps participant history. Permanent deletion removes everything and cannot be undone.</p>
    <div class="dz-confirm hidden mb-3 rounded-lg border border-red-900/60 bg-zinc-900/60 p-3">
      <p class="text-xs text-zinc-300 mb-2 dz-summary"></p>
      <div class="flex flex-wrap gap-2">
        <button class="dz-archive font-medium px-3 py-2 min-h-[40px] rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm">Archive project</button>
        <button class="dz-hard font-medium px-3 py-2 min-h-[40px] rounded-lg bg-red-700 hover:bg-red-600 text-white text-sm">Delete permanently</button>
        <button class="dz-cancel font-medium px-3 py-2 min-h-[40px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm">Cancel</button>
      </div>
    </div>
    <button class="dz-open font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-red-700 hover:bg-red-600 text-white text-sm">Delete this project</button>
  </div>`);
}

return { el, escapeHtml, toast, campaignCard, sectionRow, timeLeft, levelRing, badgePill, statePill, breadcrumb, scopeBanner, statCard, pager, emptyState, permissionList, dangerZone };

})();
