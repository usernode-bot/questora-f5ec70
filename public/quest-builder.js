// Quest builder pure helpers. Kept out of views.js so they can be unit-tested
// without a DOM, exactly like nav-menu.js. views.js reads them through
// window.QuestoraQuestBuilder.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.QuestoraQuestBuilder = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // Three-word presentation over the six server states, quest-local so the
  // shared statePill map (used by campaigns, wallets, verification) keeps its
  // current wording. bucket drives the filter chips; pill is what the row
  // shows. scheduled / paused / ended stay honest under "Published".
  var STATUS_MAP = {
    draft: { bucket: 'Draft', pill: 'Draft' },
    active: { bucket: 'Published', pill: 'Published' },
    scheduled: { bucket: 'Published', pill: 'Scheduled' },
    paused: { bucket: 'Published', pill: 'Paused' },
    ended: { bucket: 'Published', pill: 'Ended' },
    archived: { bucket: 'Archived', pill: 'Archived' },
  };
  function statusBucket(status) {
    return (STATUS_MAP[status] || { bucket: 'Published' }).bucket;
  }
  function statusPill(status) {
    return (STATUS_MAP[status] || { bucket: 'Published', pill: 'Published' }).pill;
  }
  // The status values the filter offers, in order, with All implied.
  var STATUS_BUCKETS = ['Draft', 'Published', 'Archived'];

  // Every builder choice maps to one of the six task types the server actually
  // verifies. No invented types: on-chain variants differ only in config.method
  // (and an optional contract), which the EVM verifier already reads.
  var TYPE_CHOICES = [
    { key: 'wallet_connect', label: 'Connect Wallet', hint: 'Users sign a message with their wallet. Verified automatically.' },
    { key: 'on_chain_transaction', label: 'On-chain Transaction', hint: 'Users submit a transaction hash on a configured network.' },
    { key: 'token_balance', label: 'Token Balance', hint: 'Users must hold at least an amount of a token on a configured network.' },
    { key: 'hold_token', label: 'Hold Token', hint: 'Users must hold at least an amount of a token on a configured network.' },
    { key: 'contract_interaction', label: 'Contract Interaction', hint: 'Users submit a transaction that calls a specific contract.' },
    { key: 'url_proof', label: 'Complete Form (link)', hint: 'Users submit a link and you review it.' },
    { key: 'manual', label: 'Complete Form (text)', hint: 'Users submit a short written proof and you review it.' },
    { key: 'social', label: 'Visit Website', hint: 'Users visit a link and confirm. Verified automatically.' },
    { key: 'custom_manual', label: 'Custom Task', hint: 'Users submit a free-text proof and you review it.' },
  ];

  // Pure mapping from a builder choice plus its field values to the server's
  // { type, config }. Fields are the raw form values (strings). Missing
  // optional values are simply omitted.
  function taskTypeToConfig(choiceKey, fields) {
    fields = fields || {};
    var num = function (v) { var n = Number(v); return Number.isFinite(n) && v !== '' && v !== null && v !== undefined ? n : null; };
    var requirement = fields.amount !== undefined && fields.amount !== '' && fields.amount !== null
      ? { amount: String(fields.amount), operator: fields.operator || 'gte' } : null;
    switch (choiceKey) {
      case 'wallet_connect':
        return { type: 'wallet_connect', config: {} };
      case 'on_chain_transaction': {
        var c1 = { method: 'transaction', network_id: num(fields.network_id) };
        if (fields.confirmations !== undefined && fields.confirmations !== '') c1.confirmations = num(fields.confirmations);
        return { type: 'on_chain', config: c1 };
      }
      case 'contract_interaction': {
        var c2 = { method: 'transaction', network_id: num(fields.network_id) };
        if (fields.contract) c2.contract = String(fields.contract).trim();
        if (fields.confirmations !== undefined && fields.confirmations !== '') c2.confirmations = num(fields.confirmations);
        return { type: 'on_chain', config: c2 };
      }
      case 'token_balance': {
        var c3 = { method: 'erc20_balance', network_id: num(fields.network_id) };
        if (num(fields.token_id)) c3.token_id = num(fields.token_id);
        if (requirement) c3.requirement = requirement;
        return { type: 'on_chain', config: c3 };
      }
      case 'hold_token': {
        var c4 = { method: 'erc20_balance', network_id: num(fields.network_id) };
        if (num(fields.token_id)) c4.token_id = num(fields.token_id);
        if (requirement) c4.requirement = requirement;
        return { type: 'on_chain', config: c4 };
      }
      case 'url_proof':
        return { type: 'url_proof', config: fields.placeholder ? { placeholder: String(fields.placeholder).trim() } : {} };
      case 'social':
        return { type: 'social', config: { url: String(fields.url || '').trim(), action: 'visit' } };
      case 'custom_manual':
        return { type: 'manual', config: fields.placeholder ? { placeholder: String(fields.placeholder).trim() } : {} };
      case 'manual':
      default:
        return { type: 'manual', config: {} };
    }
  }

  // The natural-language label for an existing task's stored type+config, so a
  // re-opened card shows the same choice it was created from.
  function choiceForTask(task) {
    var t = task || {};
    var c = t.config || {};
    if (t.type === 'on_chain') {
      if (c.method === 'transaction') return c.contract ? 'contract_interaction' : 'on_chain_transaction';
      if (c.method === 'erc20_balance') return 'token_balance';
      return 'on_chain_transaction';
    }
    if (t.type === 'social') return 'social';
    if (t.type === 'url_proof') return 'url_proof';
    if (t.type === 'wallet_connect') return 'wallet_connect';
    return 'manual';
  }

  // Starter templates for the New quest screen, pure data like the network
  // preset catalog. Every task goes through taskTypeToConfig at draft time, so
  // a template can only ever produce types the server already verifies.
  // Tasks that need the creator's own link, network or token are left blank
  // and flagged client-side by taskNeedsSetup (mirroring the server rules).
  var QUEST_TEMPLATES = [
    {
      key: 'community_follow', name: 'Community follow', summary: 'Visit your site, follow you and share a post.',
      title: 'Join our community', description: 'Get to know us and help spread the word.',
      tasks: [
        { choice: 'social', title: 'Visit our website', fields: {} },
        { choice: 'social', title: 'Follow us on social media', fields: {} },
        { choice: 'url_proof', title: 'Share a post about us', fields: { placeholder: 'https://…' } },
      ],
    },
    {
      key: 'wallet_activity', name: 'Wallet activity', summary: 'Connect a wallet and make a transaction.',
      title: 'Make your first transaction', description: 'Connect your wallet and make a transaction on our network.',
      tasks: [
        { choice: 'wallet_connect', title: 'Connect your wallet', fields: {} },
        { choice: 'on_chain_transaction', title: 'Make a transaction', fields: { confirmations: '1' } },
      ],
    },
    {
      key: 'hold_token', name: 'Hold a token', summary: 'Connect a wallet and hold your token.',
      title: 'Hold our token', description: 'Connect your wallet and hold at least 1 of our token.',
      tasks: [
        { choice: 'wallet_connect', title: 'Connect your wallet', fields: {} },
        { choice: 'token_balance', title: 'Hold at least 1 token', fields: { amount: '1', operator: 'gte' } },
      ],
    },
    {
      key: 'form_review', name: 'Form with review', summary: 'A short written answer and a link you review.',
      title: 'Tell us about yourself', description: 'Answer a short question and share a link. We review every answer.',
      tasks: [
        { choice: 'manual', title: 'Introduce yourself', fields: {} },
        { choice: 'url_proof', title: 'Share a link to your work', fields: { placeholder: 'https://…' } },
      ],
    },
  ];

  // Map a template key to a create-form draft: { title, description, tasks },
  // where each task is the server shape taskTypeToConfig produces. Pure and
  // fresh on every call. Unknown keys return null. views.js adds the local id.
  function templateToDraft(key) {
    var t = QUEST_TEMPLATES.find(function (x) { return x.key === key; });
    if (!t) return null;
    return {
      title: t.title,
      description: t.description,
      tasks: t.tasks.map(function (task) {
        var m = taskTypeToConfig(task.choice, task.fields);
        return { type: m.type, title: task.title, config: m.config, xp_reward: 10, completion_mode: 'one_time' };
      }),
    };
  }

  // True when a drafted task is still missing a field the server requires
  // (url, network_id, token_id), so the save guard can explain that in plain
  // words instead of the server's validation error.
  function taskNeedsSetup(task) {
    var t = task || {};
    var c = t.config || {};
    if (t.type === 'social') return !c.url;
    if (t.type === 'on_chain') {
      if (!Number.isFinite(c.network_id)) return true;
      if (c.method === 'erc20_balance' && !c.token_id) return true;
    }
    return false;
  }

  // A duplicated quest is titled "<title> Copy" (no parentheses), matching the
  // button copy.
  function duplicateTitle(title) {
    return String(title || '').trim() + ' Copy';
  }

  // The reorder payload is an ordered id list; the sort_order it maps to is the
  // list index. Pure so the mapping is pinned by a test.
  function reorderSortOrders(ids) {
    return (ids || []).map(function (id, i) { return { id: Number(id), sort_order: i }; });
  }

  return {
    STATUS_MAP: STATUS_MAP, statusBucket: statusBucket, statusPill: statusPill, STATUS_BUCKETS: STATUS_BUCKETS,
    TYPE_CHOICES: TYPE_CHOICES, taskTypeToConfig: taskTypeToConfig, choiceForTask: choiceForTask,
    duplicateTitle: duplicateTitle, reorderSortOrders: reorderSortOrders,
    QUEST_TEMPLATES: QUEST_TEMPLATES, templateToDraft: templateToDraft, taskNeedsSetup: taskNeedsSetup,
  };
});
