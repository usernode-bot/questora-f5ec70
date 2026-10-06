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
  // Error toasts carry an icon as well as colour (white on the raw red was
  // only 4.4:1 anyway); success stays the accent fill, which clears 4.5:1.
  const tone = isError
    ? 'bg-error-bg text-error border border-error/40'
    : 'bg-accent text-accent-contrast';
  const glyph = isError ? 'error' : 'check';
  const node = el(`<div class="fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-50 inline-flex items-center gap-2 ${tone} text-sm px-4 py-2.5 rounded-full shadow-lg shadow-black/40 transition-opacity duration-200">${icon(glyph, { class: 'w-4 h-4' })}<span>${escapeHtml(message)}</span></div>`);
  holder.appendChild(node);
  setTimeout(() => { node.style.opacity = '0'; }, 2400);
  setTimeout(() => node.remove(), 2800);
}

function campaignCard(c) {
  const endsIn = c.ends_at ? timeLeft(c.ends_at) : null;
  return el(`
    <a href="/campaigns/${c.slug}" class="block rounded-2xl border border-line bg-surface hover:bg-surface-container hover:border-accent/40 transition-colors p-5 min-w-[260px] md:min-w-0">
      <div class="flex items-center gap-2 mb-2">
        ${c.project_logo ? `<img src="${escapeHtml(c.project_logo)}" alt="" class="w-5 h-5 rounded-full">` : `<span class="w-5 h-5 rounded-full bg-accent/30 inline-block"></span>`}
        <span class="text-xs text-content-secondary">${escapeHtml(c.project_name)}</span>
        ${c.status !== 'active' ? `<span class="ml-auto text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-surface-container-high text-content-secondary">${escapeHtml(c.status)}</span>` : ''}
      </div>
      <h3 class="font-semibold text-content-primary mb-1 leading-snug">${escapeHtml(c.name)}</h3>
      <p class="text-sm text-content-secondary line-clamp-2 mb-3">${escapeHtml(c.description || '')}</p>
      <div class="flex items-center gap-3 text-xs text-content-secondary">
        <span class="text-accent-text font-medium">+${c.total_xp} XP</span>
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
        <h2 class="text-sm font-medium text-content-secondary mb-2 px-1">${escapeHtml(label)}</h2>
        <p class="text-sm text-content-tertiary px-1">${escapeHtml(emptyText || 'Nothing here yet')}</p>
      </section>`);
  }
  const row = el(`
    <section class="mb-8">
      <h2 class="text-sm font-medium text-content-secondary mb-2 px-1">${escapeHtml(label)}</h2>
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
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--q-border)" stroke-width="3"></circle>
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--q-accent)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${pct} ${100 - pct}"></circle>
      </svg>
      <span class="absolute inset-0 flex items-center justify-center text-xl font-bold">${level}</span>
    </div>`);
}

const badgePill = (text) => `<span class="inline-block text-xs font-medium px-2.5 py-1 rounded-full bg-accent/20 text-accent-text">${escapeHtml(text)}</span>`;
const statePill = (status) => {
  const map = {
    pending: 'bg-warning-bg text-warning',
    verified: 'bg-success-bg text-success',
    rejected: 'bg-error-bg text-error',
    live: 'bg-success-bg text-success',
    scheduled: 'bg-info-bg text-info',
    ended: 'bg-surface-container text-content-secondary',
    archived: 'bg-surface-container text-content-secondary',
    draft: 'bg-surface-container-high text-content-secondary',
    paused: 'bg-warning-bg text-warning',
    // Verification enum (on-chain tasks). Amber for waiting and
    // infrastructure, red only for a genuine failure, sky for indexing, grey
    // for expired or not set up.
    VERIFIED: 'bg-success-bg text-success',
    FAILED: 'bg-error-bg text-error',
    EXPIRED: 'bg-surface-container text-content-secondary',
    PENDING: 'bg-warning-bg text-warning',
    WAITING_CONFIRMATIONS: 'bg-warning-bg text-warning',
    INDEXING_DELAY: 'bg-info-bg text-info',
    RPC_UNAVAILABLE: 'bg-warning-bg text-warning',
    MANUAL_REVIEW: 'bg-warning-bg text-warning',
    INVALID_CONFIGURATION: 'bg-surface-container text-content-secondary',
    // Phase 3 states: seasons and the risk engine.
    active: 'bg-success-bg text-success',
    upcoming: 'bg-info-bg text-info',
    normal: 'bg-success-bg text-success',
    review: 'bg-warning-bg text-warning',
    suspicious: 'bg-error-bg text-error',
    blocked: 'bg-error-bg text-error',
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
  // A glyph per state so status is never carried by colour alone: a tick for
  // verified, a triangle for pending/infrastructure, a cross for a failure,
  // an i for informational, a clock for anything still in progress.
  const icons = {
    pending: 'schedule', PENDING: 'schedule', WAITING_CONFIRMATIONS: 'schedule',
    verified: 'check', live: 'check', active: 'check', normal: 'check', VERIFIED: 'check',
    rejected: 'error', FAILED: 'error', suspicious: 'error', blocked: 'error',
    scheduled: 'info', upcoming: 'info', INDEXING_DELAY: 'info',
    paused: 'warning', review: 'warning', RPC_UNAVAILABLE: 'warning', MANUAL_REVIEW: 'warning',
    ended: 'info', archived: 'info', draft: 'info', EXPIRED: 'info', INVALID_CONFIGURATION: 'info',
  };
  const cls = map[status] || 'bg-surface-container-high text-content-secondary';
  const label = labels[status] || (status ? status.charAt(0).toUpperCase() + status.slice(1) : '');
  return `<span class="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full ${cls}">${icon(icons[status] || 'info', { class: 'w-3.5 h-3.5' })}<span>${label}</span></span>`;
};

// Hierarchical navigation: Project -> Campaign -> Quest. Each item is
// { label, href }; the last one is the current page and is not a link.
function breadcrumb(items) {
  const parts = [];
  items.forEach((it, i) => {
    if (i > 0) parts.push('<span class="text-content-tertiary" aria-hidden="true">/</span>');
    const last = i === items.length - 1;
    if (last || !it.href) {
      parts.push(`<span class="text-content-secondary">${escapeHtml(it.label)}</span>`);
    } else {
      parts.push(`<a href="${escapeHtml(it.href)}" class="text-content-secondary hover:text-accent-text">${escapeHtml(it.label)}</a>`);
    }
  });
  return `<nav class="flex items-center flex-wrap gap-1.5 text-xs mb-3" aria-label="Breadcrumb">${parts.join('')}</nav>`;
}

// The banner a scoped leaderboard (or a scoped directory) leads with. Plain
// language: whose ranking this is, or what lives under this scope.
function scopeBanner(title, scopeLabel, subtitle) {
  return `<div class="rounded-2xl border border-line bg-gradient-to-b from-accent/20 to-transparent p-5 mb-4">
    <p class="text-xs uppercase tracking-wide text-accent-text mb-1">${escapeHtml(scopeLabel)}</p>
    <h1 class="text-xl font-bold">${escapeHtml(title)}</h1>
    ${subtitle ? `<p class="text-sm text-content-secondary mt-1">${escapeHtml(subtitle)}</p>` : ''}
  </div>`;
}

function statCard(label, value, accent) {
  return `<div class="rounded-xl border border-line bg-surface p-4">
    <p class="text-xs text-content-secondary">${escapeHtml(label)}</p>
    <p class="text-xl font-bold ${accent || ''}">${escapeHtml(String(value))}</p>
  </div>`;
}

function pager(page, hasMore, makeHref) {
  const holder = el('<div class="flex items-center justify-center gap-3 mt-4"></div>');
  if (page > 1) {
    const prev = el(`<a href="${escapeHtml(makeHref(page - 1))}" class="text-sm font-medium px-4 py-2 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-content-primary">Previous</a>`);
    holder.appendChild(prev);
  }
  holder.appendChild(el(`<span class="text-sm text-content-secondary">Page ${page}</span>`));
  if (hasMore) {
    holder.appendChild(el(`<a href="${escapeHtml(makeHref(page + 1))}" class="text-sm font-medium px-4 py-2 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-content-primary">Next</a>`));
  }
  return holder;
}

// Empty state with a plain next step. An action without a real destination
// renders as inert text, never a dead "#" link.
function emptyState(text, actionLabel, actionHref) {
  let action = '';
  if (actionLabel) {
    action = actionHref
      ? `<a href="${escapeHtml(actionHref)}" class="inline-block mt-3 font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-accent hover:bg-accent-hover text-accent-contrast text-sm">${escapeHtml(actionLabel)}</a>`
      : `<span class="inline-block mt-3 font-medium text-content-secondary text-sm">${escapeHtml(actionLabel)}</span>`;
  }
  return `<div class="rounded-2xl border border-line bg-surface p-8 text-center">
    <p class="text-content-secondary">${escapeHtml(text)}</p>${action}</div>`;
}

// The project deletion card: two steps, archive-first. Only rendered for the
// project's Creator.
function dangerZone() {
  return el(`<div class="rounded-xl border border-error/40 bg-error-bg p-4 max-w-xl">
    <h2 class="font-semibold mb-1 text-error">Danger zone</h2>
    <p class="text-xs text-content-secondary mb-3">Archiving hides the project and keeps participant history. Permanent deletion removes everything and cannot be undone.</p>
    <div class="dz-confirm hidden mb-3 rounded-lg border border-error/40 bg-surface p-3">
      <p class="text-xs text-content-secondary mb-2 dz-summary"></p>
      <div class="flex flex-wrap gap-2">
        <button class="dz-archive font-medium px-3 py-2 min-h-[40px] rounded-lg bg-warning hover:bg-warning/90 text-warning-bg text-sm">Archive project</button>
        <button class="dz-hard font-medium px-3 py-2 min-h-[40px] rounded-lg bg-error hover:bg-error/90 text-error-bg text-sm">Delete permanently</button>
        <button class="dz-cancel font-medium px-3 py-2 min-h-[40px] rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-content-primary text-sm">Cancel</button>
      </div>
    </div>
    <button class="dz-open font-medium px-4 py-2.5 min-h-[44px] rounded-lg bg-error hover:bg-error/90 text-error-bg text-sm">Delete this project</button>
  </div>`);
}



// ---- confirmation dialog ---------------------------------------------------
// One small modal for the destructive or state-changing verbs (publish,
// duplicate, delete). Built from the same token classes as everything else.
// It traps focus, closes on Escape or a backdrop click, and restores focus to
// whatever was focused before. Returns a promise that resolves true when the
// confirm button is chosen, false otherwise; onConfirm runs before it closes,
// and an error from onConfirm keeps the dialog open.
function confirmDialog(opts) {
  opts = opts || {};
  const title = opts.title || 'Are you sure?';
  const body = opts.body || '';
  const confirmLabel = opts.confirmLabel || 'Confirm';
  const cancelLabel = opts.cancelLabel || 'Cancel';
  const danger = !!opts.danger;
  const prevFocus = document.activeElement;
  const overlay = el(`
    <div class="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="cd-backdrop absolute inset-0 bg-black/60"></div>
      <div class="cd-panel relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-line bg-surface p-5 shadow-lg">
        <h2 class="font-semibold mb-1 text-content-primary">${escapeHtml(title)}</h2>
        ${body ? `<p class="cd-body text-sm text-content-secondary mb-4">${body}</p>` : ''}
        <div class="flex flex-wrap gap-2 justify-end">
          <button type="button" class="cd-cancel ${BTN_SECONDARY}">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="cd-confirm font-medium px-4 py-2.5 min-h-[44px] rounded-lg text-sm ${danger ? 'bg-error hover:bg-error/90 text-error-bg' : 'bg-accent hover:bg-accent-hover text-accent-contrast'}">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    </div>`);
  const panel = overlay.querySelector('.cd-panel');
  const confirmBtn = overlay.querySelector('.cd-confirm');
  const cancelBtn = overlay.querySelector('.cd-cancel');
  document.body.appendChild(overlay);
  confirmBtn.focus();

  let settled = false;
  function close(result) {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (prevFocus && typeof prevFocus.focus === 'function') { try { prevFocus.focus(); } catch (e) { /* gone */ } }
    resolve(result);
  }
  let resolve;
  const done = new Promise((r) => { resolve = r; });

  async function onConfirmClick() {
    if (settled) return;
    confirmBtn.disabled = true;
    const label = confirmBtn.textContent;
    confirmBtn.textContent = 'Working…';
    try {
      if (opts.onConfirm) await opts.onConfirm();
      close(true);
    } catch (err) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = label;
      if (typeof toast === 'function') toast(err.message || 'Something went wrong', true);
    }
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); return; }
    if (e.key !== 'Tab') return;
    // Trap focus inside the dialog.
    const focusables = panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onKey, true);
  overlay.querySelector('.cd-backdrop').addEventListener('click', () => close(false));
  cancelBtn.addEventListener('click', () => close(false));
  confirmBtn.addEventListener('click', onConfirmClick);
  return done;
}

// ---- buttons ---------------------------------------------------------------
// One place for the button look, so header menus, dashboard actions and the
// wallet UI share it. Whole class literals only: Tailwind reads these as text.
var BTN_PRIMARY = 'inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 py-2.5 rounded-lg bg-accent hover:bg-accent-hover text-accent-contrast text-sm font-medium disabled:bg-surface-container disabled:text-content-disabled disabled:cursor-not-allowed';
var BTN_SECONDARY = 'inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 py-2.5 rounded-lg bg-surface-container border border-line-strong hover:bg-surface-container-high text-content-primary text-sm font-medium disabled:bg-surface-container disabled:text-content-disabled disabled:cursor-not-allowed';
var BTN_ICON = 'inline-flex items-center justify-center min-w-[44px] min-h-[44px] p-2 rounded-lg text-icon-secondary hover:text-icon-primary hover:bg-surface-container-high';

// ---- tooltip ---------------------------------------------------------------
// One floating tooltip for icon-only controls. Shows after a short hover delay,
// immediately on keyboard focus, hides on leave/blur/Escape, and clamps inside
// the viewport. pointer-events: none so it never blocks the control it labels.
var tipEl = null;
var tipTimer = null;
function hideTooltip() {
  if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
  if (tipEl) { tipEl.remove(); tipEl = null; }
}
function showTooltip(trigger, text, placement) {
  hideTooltip();
  if (!text) return;
  var rect = trigger.getBoundingClientRect();
  var node = document.createElement('div');
  node.setAttribute('role', 'tooltip');
  node.className = 'fixed z-[60] pointer-events-none px-2.5 py-1.5 rounded-lg bg-surface-container-highest text-content-primary border border-line text-xs font-medium shadow-lg max-w-[220px]';
  node.textContent = text;
  document.body.appendChild(node);
  var w = node.offsetWidth, h = node.offsetHeight;
  var above = placement === 'bottom' ? false : true;
  var top = above ? rect.top - h - 8 : rect.bottom + 8;
  var left = rect.left + rect.width / 2 - w / 2;
  if (left < 8) left = 8;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if (top < 8) { top = rect.bottom + 8; above = false; }
  if (top + h > window.innerHeight - 8) top = rect.top - h - 8;
  node.style.top = Math.round(top) + 'px';
  node.style.left = Math.round(left) + 'px';
  tipEl = node;
}
function tooltip(trigger, text) {
  if (!trigger || trigger.dataset.tooltipBound) return trigger;
  trigger.dataset.tooltipBound = '1';
  if (text) trigger.setAttribute('aria-label', trigger.getAttribute('aria-label') || text);
  function label() { return trigger.dataset.tooltipText || text || trigger.getAttribute('aria-label') || ''; }
  trigger.addEventListener('pointerenter', function () {
    tipTimer = setTimeout(function () { showTooltip(trigger, label()); }, 400);
  });
  trigger.addEventListener('pointerleave', hideTooltip);
  trigger.addEventListener('focus', function () { showTooltip(trigger, label()); });
  trigger.addEventListener('blur', hideTooltip);
  trigger.addEventListener('click', hideTooltip);
  return trigger;
}
function setTooltip(trigger, text) { if (trigger) trigger.dataset.tooltipText = text || ''; }

// ---- notifications ---------------------------------------------------------
// The notification row markup, shared by the header panel and the full
// Notifications page so the two cannot drift.
function notificationRow(n, opts) {
  opts = opts || {};
  var nrm = opts.full ? '' : 'rounded-lg hover:bg-surface-container-high';
  var cls = opts.full
    ? 'block rounded-xl border ' + (n.read_at ? 'border-line' : 'border-accent/40') + ' bg-surface px-4 py-3'
    : 'w-full text-left px-3 py-2.5 rounded-lg ' + (n.read_at ? 'hover:bg-surface-container-high' : 'bg-accent/10 hover:bg-accent/20');
  var tag = (opts.full && n.link) ? 'a' : (opts.full ? 'div' : 'button');
  var attrs = tag === 'a' ? ' href="' + escapeHtml(n.link) + '"' : (tag === 'button' ? ' type="button"' : '');
  var node = el('<' + tag + attrs + ' class="' + cls + '"><span class="block text-sm font-medium text-content-primary">' + escapeHtml(n.title) + '</span><span class="block text-xs text-content-secondary mt-0.5">' + escapeHtml(n.body || '') + '</span></' + tag + '>');
  node.dataset.notifId = n.id;
  return node;
}

// The notification kinds a user can mute. One list for the panel and Settings.
var NOTIF_KINDS = [
  ['quest_completed', 'Quest completed'],
  ['badge_earned', 'Badge earned'],
  ['level_up', 'Level up'],
  ['submission_rejected', 'Submission rejected'],
  ['campaign_completed', 'Campaign completed'],
  ['credential_earned', 'Credential issued'],
  ['referral_qualified', 'Invite qualified'],
];

// icons.js loads before this file and owns the glyphs; capture its factory
// now, before the module's return value replaces window.QUI, so the shared
// `icon` export is that factory rather than a call back into itself.
var icon = (window.QUI && window.QUI.icon) ? window.QUI.icon : function () { return ''; };

return { el, escapeHtml, toast, campaignCard, sectionRow, timeLeft, levelRing, badgePill, statePill, breadcrumb, scopeBanner, statCard, pager, emptyState, dangerZone, confirmDialog, icon, tooltip, setTooltip, hideTooltip, notificationRow, NOTIF_KINDS, BTN_PRIMARY, BTN_SECONDARY, BTN_ICON };

})();
