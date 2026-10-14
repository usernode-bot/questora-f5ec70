// Quest builder: pure helpers plus the guided create/edit wizard. The pure
// helpers (status vocabulary, task-type mapping, validation, draft storage)
// are DOM-free so tests/unit.test.js can pin them; the render functions are
// the only place the wizard touches the DOM, and views.js just points them at
// a section element. Loaded as a browser IIFE (window.QuestoraQuestBuilder)
// and as a CommonJS module for the unit tests.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.QuestoraQuestBuilder = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ---------- status vocabulary ----------
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
  var STATUS_BUCKETS = ['Draft', 'Published', 'Archived'];

  // ---------- task types ----------
  // Every builder choice maps to one of the six task types the server actually
  // verifies. No invented types: on-chain variants differ only in config.method
  // (and an optional contract), which the EVM verifier already reads.
  var TYPE_CHOICES = [
    { key: 'wallet_connect', label: 'Connect Wallet', hint: 'Users sign a message with their wallet. Verified automatically.' },
    { key: 'on_chain_transaction', label: 'On-chain Transaction', hint: 'Users submit a transaction hash on a configured network.' },
    { key: 'token_balance', label: 'Token Balance', hint: 'Users must hold at least an amount of a token on a configured network.' },
    { key: 'hold_token', label: 'Hold Token', hint: 'Users must hold at least an amount of a token on a configured network.' },
    { key: 'contract_interaction', label: 'Contract Interaction', hint: 'Users submit a transaction that calls a specific contract.' },
    { key: 'url_proof', label: 'Complete Form (link)', hint: 'Participants submit a link on the quest page. You review it.' },
    { key: 'quiz', label: 'Quiz', hint: 'Participants answer on the quest page. The server grades it instantly.' },
    { key: 'manual', label: 'Complete Form (text)', hint: 'Participants write a short proof on the quest page. You review it.' },
    { key: 'social', label: 'Visit Website', hint: 'Participants visit a link and confirm. You review it.' },
    { key: 'custom_manual', label: 'Custom Task', hint: 'Participants submit a free-text proof. You review it.' },
  ];

  // Guided builder: the five task types the wizard configures step by step. The
  // on-chain family is addressed by its own choice keys below; the map keys the
  // step UI.
  var TASK_TYPES = [
    { key: 'url_proof', label: 'Submit a link', hint: 'Participants submit a URL and you review it.' },
    { key: 'quiz', label: 'Quiz', hint: 'Participants answer questions and the server grades them.' },
    { key: 'social', label: 'Visit a link', hint: 'Participants visit a link and confirm it.' },
    { key: 'wallet_connect', label: 'Connect a wallet', hint: 'Participants sign a message with their wallet.' },
    { key: 'manual', label: 'Written proof', hint: 'Participants write a short proof and you review it.' },
  ];
  var CHOICE_TASK_TYPE = {
    wallet_connect: 'wallet_connect', on_chain_transaction: 'on_chain', token_balance: 'on_chain',
    hold_token: 'on_chain', contract_interaction: 'on_chain', url_proof: 'url_proof',
    quiz: 'quiz', manual: 'manual', custom_manual: 'manual', social: 'social',
  };
  var CHAIN_CHOICES = ['on_chain_transaction', 'token_balance', 'hold_token', 'contract_interaction'];
  // The fields each guided task type renders, as a pure model. The wizard's
  // Task step builds its DOM from this list, so "a url_proof task shows exactly
  // one URL field and no placeholder" is a testable property, not a layout
  // accident. Each key is both the DOM hook and the validation field name.
  var TASK_FIELDS = {
    url_proof: [
      { key: 'task_url', kind: 'url', label: 'Link participants must submit', placeholder: 'https://\u2026' },
    ],
    social: [
      { key: 'task_url', kind: 'url', label: 'Link to visit', placeholder: 'https://\u2026' },
      { key: 'task_action', kind: 'actionSelect', label: 'Action' },
    ],
    quiz: [
      { key: 'quiz_questions', kind: 'questions' },
      { key: 'quiz_pass_score', kind: 'passScore', label: 'Pass score (%)', hint: 'Participants must score at least this to pass. Default 80.' },
    ],
    wallet_connect: [
      { key: 'task_network_name', kind: 'networkName', label: 'Network (optional)', hint: 'Participants sign a message with their browser wallet. A network name is only shown to them.' },
    ],
    on_chain: [
      { key: 'task_network_id', kind: 'networkSelect', label: 'Network' },
    ],
    manual: [
      { key: 'task_instructions', kind: 'proofText', label: 'What proof should participants send?' },
    ],
  };
  function taskFields(choiceKey) {
    var type = taskTypeForChoice(choiceKey);
    return (TASK_FIELDS[type] || TASK_FIELDS.manual).slice();
  }

  var OPERATOR_WORD = { gte: 'at least', gt: 'more than', lte: 'at most', lt: 'less than', eq: 'exactly' };
  var SOCIAL_ACTIONS = ['visit', 'join', 'follow'];
  var MAX_QUIZ_OPTIONS = 6;
  var MIN_QUIZ_OPTIONS = 2;

  function isChainChoice(choiceKey) { return CHAIN_CHOICES.indexOf(choiceKey) >= 0; }
  function taskTypeForChoice(choiceKey) { return CHOICE_TASK_TYPE[choiceKey] || 'manual'; }
  function choiceLabel(choiceKey) {
    for (var i = 0; i < TYPE_CHOICES.length; i++) if (TYPE_CHOICES[i].key === choiceKey) return TYPE_CHOICES[i].label;
    return 'Task';
  }
  function typeLabel(serverType) {
    var map = {
      wallet_connect: 'Connect wallet', social: 'Social link', url_proof: 'Submit proof',
      quiz: 'Quiz', manual: 'Manual review', on_chain: 'On-chain check',
    };
    return map[serverType] || serverType || 'Task';
  }
  // Plain-language requirement line for an on-chain task, from the allow-listed
  // public config. Chain-neutral: it names an amount and a comparison.
  function requirementLine(config) {
    var c = config || {};
    var req = c.requirement;
    if (!req || req.amount === undefined || req.amount === '') return null;
    return 'Hold ' + (OPERATOR_WORD[req.operator] || 'at least') + ' ' + req.amount;
  }

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
      case 'url_proof': {
        var up = { type: 'url_proof', config: {} };
        if (fields.placeholder) up.config.placeholder = String(fields.placeholder).trim();
        return up;
      }
      case 'quiz':
        // The answer index travels only in the intended create/update body; it
        // is never rendered or held in any other client state.
        return { type: 'quiz', config: { pass_score: normalizedPassScore(fields.pass_score), questions: quizQuestionsForSave(fields.questions) } };
      case 'social':
        return { type: 'social', config: { url: String(fields.url || '').trim(), action: SOCIAL_ACTIONS.indexOf(fields.action) >= 0 ? fields.action : 'visit' } };
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
    if (t.type === 'quiz') return 'quiz';
    if (t.type === 'wallet_connect') return 'wallet_connect';
    return 'manual';
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

  // ---------- draft shape ----------
  // The draft is the in-memory form model. It is DOM-free and JSON-safe, and it
  // decides what validateQuestDraft grades and what the payload carries.
  function defaultDraft() {
    return {
      title: '', description: '', image_url: '', instructions: '',
      campaign_id: null, xp_reward: '', points_reward: '',
      starts_at: '', ends_at: '', badge_id: '', credential_title: '',
      visibility: 'public', max_participants: '', completion_limit: '',
      is_required: true, requires_quests: [], require_all: true,
      task_choice: 'url_proof', task_title: '', task_xp_reward: '',
      task_placeholder: '', task_url: '', task_action: 'visit', task_instructions: '',
      task_network_id: '', task_network_preset: '', task_network_name: '', task_token_id: '',
      task_contract: '', task_amount: '', task_operator: 'gte', task_confirmations: '',
      quiz_pass_score: 80,
      quiz_questions: [newQuestion(), newQuestion()],
    };
  }
  function newQuestion() { return { q: '', options: ['', ''], answer: -1 }; }
  // A complete, obviously-fake draft for a URL-reachable step deep link
  // (?step=task&task=quiz and friends), so a screenshot or a check can open any
  // step directly. Never stored: the wizard skips autosave in this mode.
  function demoDraft(choiceKey) {
    var d = defaultDraft();
    d.title = 'Staging demo quest';
    d.description = 'Example content for this preview, not a real quest.';
    d.xp_reward = '100';
    d.points_reward = '50';
    d.task_choice = choiceKey || 'url_proof';
    d.task_title = 'Staging demo task';
    d.task_xp_reward = '0';
    if (d.task_choice === 'social') { d.task_url = 'https://example.com/community'; d.task_action = 'join'; }
    else if (d.task_choice === 'quiz') {
      d.quiz_pass_score = 80;
      d.quiz_questions = [
        { q: 'What does XP measure on Questora?', options: ['Your progress', 'Your wallet balance', 'Your gas fees'], answer: 0 },
        { q: 'Who grades a quiz?', options: ['The browser', 'The server'], answer: 1 },
      ];
    } else if (d.task_choice === 'wallet_connect') { d.task_network_name = 'Sepolia'; }
    else if (d.task_choice === 'manual') { d.task_instructions = 'Paste a link to your post'; }
    else { d.task_url = 'https://example.com/staging-demo-work'; }
    return d;
  }
  function quizQuestionsForSave(questions) {
    return (questions || []).map(function (q) {
      var options = (q.options || []).map(function (o) { return String(o); });
      return { q: q.q, options: options, answer: Number(q.answer) };
    });
  }
  function normalizedPassScore(raw) {
    if (raw === '' || raw === null || raw === undefined) return 80;
    var n = Number(raw);
    return Number.isFinite(n) ? n : 80;
  }

  function isValidHttpUrl(value) {
    var s = String(value || '').trim();
    if (!s) return false;
    try { var u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch (e) { return false; }
  }
  function isPositiveInt(value) {
    if (typeof value === 'number') return Number.isInteger(value) && value > 0;
    var s = String(value === undefined || value === null ? '' : value).trim();
    return /^\d+$/.test(s) && Number(s) > 0;
  }

  // The one rule table, shape-matched by src/routes/quests.js: each rule is
  // { field, message, test(draft) }. `field` is the payload key the builder
  // reads, and the same field name the server returns in `fields`.
  function questDraftRules(draft) {
    draft = draft || {};
    var choice = draft.task_choice || draft.task_type;
    var serverType = taskTypeForChoice(choice);
    var rules = [
      { field: 'title', message: 'A quest title is required', test: function () { return !!String(draft.title || '').trim(); } },
      { field: 'xp_reward', message: 'Reward XP must be a positive whole number', test: function () { return isPositiveInt(draft.xp_reward); } },
    ];
    function taskRule(field, message, test) {
      rules.push({ field: field, message: message, test: test });
    }
    if (serverType === 'url_proof') {
      taskRule('task_url', 'Add the link participants must submit', function () { return !!String(draft.task_url || '').trim(); });
      taskRule('task_url', 'The link must start with http:// or https://', function () { return isValidHttpUrl(draft.task_url); });
    } else if (serverType === 'social') {
      taskRule('task_url', 'Add the link participants must visit', function () { return !!String(draft.task_url || '').trim(); });
      taskRule('task_url', 'The link must start with http:// or https://', function () { return isValidHttpUrl(draft.task_url); });
    } else if (serverType === 'quiz') {
      taskRule('quiz_pass_score', 'Pass score must be between 0 and 100', function () {
        var n = Number(draft.quiz_pass_score === '' || draft.quiz_pass_score === null || draft.quiz_pass_score === undefined ? 80 : draft.quiz_pass_score);
        return Number.isFinite(n) && n >= 0 && n <= 100;
      });
      taskRule('quiz_questions', 'Add at least one question', function () {
        return Array.isArray(draft.quiz_questions) && draft.quiz_questions.length >= 1;
      });
      var qs = Array.isArray(draft.quiz_questions) ? draft.quiz_questions : [];
      for (var i = 0; i < qs.length; i++) {
        (function (idx) {
          var q = qs[idx] || {};
          taskRule('quiz_questions[' + idx + ']', 'Question ' + (idx + 1) + ': question text is required', function () {
            return !!(q.q && String(q.q).trim());
          });
          taskRule('quiz_questions[' + idx + ']', 'Question ' + (idx + 1) + ': give between 2 and 6 options', function () {
            var opts = (q.options || []).filter(function (o) { return String(o || '').trim(); });
            return opts.length >= MIN_QUIZ_OPTIONS && (q.options || []).length <= MAX_QUIZ_OPTIONS;
          });
          taskRule('quiz_questions[' + idx + ']', 'Question ' + (idx + 1) + ': mark the correct option', function () {
            return Number.isInteger(q.answer) && q.answer >= 0 && q.answer < (q.options || []).length;
          });
        })(i);
      }
    } else if (serverType === 'wallet_connect') {
      taskRule('task_network_name', 'Choose or name the network participants connect on', function () {
        return !!String(draft.task_network_name || '').trim();
      });
    } else if (serverType === 'on_chain') {
      taskRule('task_network_id', 'Choose or add the network participants use', function () {
        return draft.task_network_id !== '' && draft.task_network_id !== null && draft.task_network_id !== undefined;
      });
    } else if (serverType === 'manual') {
      taskRule('task_instructions', 'Tell participants what proof to send', function () {
        return !!String(draft.task_instructions || '').trim();
      });
    }
    return rules;
  }

  // The shared rule shape: { ok, errors: { field: message } }. src/routes/quests.js
  // imports this and reuses questDraftRules so client and server agree.
  function validateQuestDraft(draft) {
    var rules = questDraftRules(draft);
    var errors = {};
    for (var i = 0; i < rules.length; i++) {
      if (errors[rules[i].field]) continue;
      var ok = false;
      try { ok = !!rules[i].test(); } catch (e) { ok = false; }
      if (!ok) errors[rules[i].field] = rules[i].message;
    }
    return { ok: Object.keys(errors).length === 0, errors: errors };
  }

  // Structural checks a server must still own (id shape, size caps). Shared so
  // client and server bound the same inputs.
  function sanitizeQuizQuestions(questions) {
    if (!Array.isArray(questions)) return { error: 'Questions must be a list', questions: null };
    if (questions.length < 1) return { error: 'At least one question is required', questions: null };
    if (questions.length > 100) return { error: 'A quiz can have at most 100 questions', questions: null };
    var out = [];
    for (var i = 0; i < questions.length; i++) {
      var q = questions[i] || {};
      if (!q.q || !String(q.q).trim()) return { error: 'Question ' + (i + 1) + ': question text is required', questions: null };
      if (!Array.isArray(q.options)) return { error: 'Question ' + (i + 1) + ': give between 2 and 6 options', questions: null };
      var options = q.options.map(function (o) { return String(o); });
      if (options.length < MIN_QUIZ_OPTIONS || options.length > MAX_QUIZ_OPTIONS) {
        return { error: 'Question ' + (i + 1) + ': give between 2 and 6 options', questions: null };
      }
      if (options.some(function (o) { return !o.trim(); })) return { error: 'Question ' + (i + 1) + ': every option needs text', questions: null };
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= options.length) {
        return { error: 'Question ' + (i + 1) + ': mark the correct option', questions: null };
      }
      out.push({ q: String(q.q).trim(), options: options, answer: Number(q.answer) });
    }
    return { error: null, questions: out };
  }

  // A quiz config safe to hand back to a browser: the correct-answer index is
  // dropped from every question. Used by the API so no response body (or DOM
  // attribute built from one) can leak the answer.
  function stripQuizAnswers(config) {
    if (!config || typeof config !== 'object') return config;
    var copy = {};
    for (var k in config) if (Object.prototype.hasOwnProperty.call(config, k)) copy[k] = config[k];
    if (Array.isArray(copy.questions)) {
      copy.questions = copy.questions.map(function (q) {
        var o = { q: q && q.q, options: (q && q.options) || [] };
        return o;
      });
    }
    return copy;
  }
  // Strip the answer from any task-shaped object ({ type, config } or a
  // task/version row) when its type is a quiz.
  function stripAnswersFromTask(task) {
    if (!task || !task.config || task.type !== 'quiz') return task;
    var copy = {};
    for (var k in task) if (Object.prototype.hasOwnProperty.call(task, k)) copy[k] = task[k];
    copy.config = stripQuizAnswers(task.config);
    return copy;
  }
  function configLeaksAnswer(config) {
    if (!config || !Array.isArray(config.questions)) return false;
    return config.questions.some(function (q) { return q && Object.prototype.hasOwnProperty.call(q, 'answer'); });
  }

  // ---------- draft / payload mapping ----------
  // The saved payload for a quest's tasks. Built from the draft only, and it is
  // the single place an answer index is written into a request body.
  function tasksFromDraft(draft) {
    var choice = draft.task_choice;
    var fields = {
      url: draft.task_url, placeholder: draft.task_placeholder, action: draft.task_action,
      network_id: draft.task_network_id, token_id: draft.task_token_id, contract: draft.task_contract,
      amount: draft.task_amount, operator: draft.task_operator, confirmations: draft.task_confirmations,
      pass_score: draft.quiz_pass_score, questions: draft.quiz_questions,
      instructions: draft.task_instructions, network_name: draft.task_network_name,
    };
    var mapped = taskTypeToConfig(choice, fields);
    if (choice === 'manual' && String(draft.task_instructions || '').trim()) {
      mapped.config.instructions = String(draft.task_instructions).trim();
    }
    return [{ type: mapped.type, title: draft.title ? String(draft.title).trim() : choiceLabel(choice), config: mapped.config, xp_reward: Math.max(0, parseInt(draft.task_xp_reward, 10) || 0) }];
  }
  // The body POST /campaigns/:id/quests (or PATCH /quests/:id) receives. The
  // answer index lives only here, and only for the intended call.
  function questFromDraft(draft) {
    draft = draft || {};
    var int = function (v, dflt) { var n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; };
    var body = {
      // Marks this body as a builder draft, so src/routes/quests.js grades it
      // with the same field-level rules the browser just ran.
      draft: true,
      title: String(draft.title || '').trim(),
      description: String(draft.description || '').trim() || undefined,
      image_url: String(draft.image_url || '').trim() || undefined,
      instructions: String(draft.instructions || '').trim() || undefined,
      xp_reward: Math.max(0, int(draft.xp_reward, 0)),
      points_reward: Math.max(0, int(draft.points_reward, 0)),
      starts_at: draft.starts_at || null,
      ends_at: draft.ends_at || null,
      visibility: draft.visibility === 'unlisted' ? 'unlisted' : 'public',
      max_participants: draft.max_participants ? Math.max(1, int(draft.max_participants, 1)) : null,
      completion_limit: Math.max(1, int(draft.completion_limit, 1)),
      is_required: draft.is_required !== false,
      badge_id: draft.badge_id || null,
      credential_title: String(draft.credential_title || '').trim() || null,
      requires_quests: (draft.requires_quests || []).map(Number).filter(Number.isFinite),
      require_all: draft.require_all !== false,
      tasks: tasksFromDraft(draft),
    };
    return body;
  }
  // Everything a preview card can safely show: the payload without its task
  // configs (so the answer index never reaches a renderer).
  function previewModel(draft) {
    draft = draft || {};
    var choice = draft.task_choice;
    var serverType = taskTypeForChoice(choice);
    return {
      title: String(draft.title || '').trim() || 'Untitled quest',
      description: String(draft.description || '').trim(),
      xp_reward: draft.xp_reward,
      points_reward: draft.points_reward,
      type: serverType,
      typeLabel: typeLabel(serverType),
      detail: previewDetail(draft, choice, serverType),
      quizQuestionCount: serverType === 'quiz' && Array.isArray(draft.quiz_questions) ? draft.quiz_questions.length : 0,
      passScore: serverType === 'quiz' ? normalizedPassScore(draft.quiz_pass_score) : null,
    };
  }
  function previewDetail(draft, choice, serverType) {
    if (serverType === 'url_proof') return 'Participants submit a link. You review it.';
    if (serverType === 'social') return draft.task_url ? 'Visit ' + String(draft.task_url).trim() : 'A link to visit';
    if (serverType === 'quiz') {
      var n = Array.isArray(draft.quiz_questions) ? draft.quiz_questions.length : 0;
      return n + (n === 1 ? ' question' : ' questions') + ', pass at ' + normalizedPassScore(draft.quiz_pass_score) + '%. The server grades it.';
    }
    if (serverType === 'wallet_connect') return 'Participants sign a message' + (draft.task_network_name ? ' on ' + String(draft.task_network_name).trim() : '') + '.';
    if (serverType === 'on_chain') {
      var line = requirementLine({ requirement: draft.task_amount ? { amount: draft.task_amount, operator: draft.task_operator } : null });
      return line ? line + ' on the configured network.' : 'An on-chain check on the configured network.';
    }
    var text = String(draft.task_instructions || '').trim();
    return text ? 'Send: ' + text : 'Participants write a proof. You review it.';
  }

  // ---------- draft storage ----------
  var DRAFT_VERSION = 1;
  function draftKey(projectId) { return 'questora:quest-draft:' + String(projectId == null ? 'unknown' : projectId); }
  function draftStorage(store) {
    if (store) return store;
    try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) { /* private mode */ }
    return null;
  }
  function saveDraft(projectId, draft, store) {
    var s = draftStorage(store);
    if (!s) return false;
    try { s.setItem(draftKey(projectId), JSON.stringify({ v: DRAFT_VERSION, savedAt: Date.now(), draft: draft })); return true; }
    catch (e) { return false; }
  }
  function loadDraft(projectId, store) {
    var s = draftStorage(store);
    if (!s) return null;
    var raw;
    try { raw = s.getItem(draftKey(projectId)); } catch (e) { return null; }
    if (!raw) return null;
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return null; }
    if (!parsed || typeof parsed !== 'object' || !parsed.draft || typeof parsed.draft !== 'object') return null;
    // Merge over the defaults so a shape from an older build still loads.
    return Object.assign(defaultDraft(), parsed.draft, { savedAt: parsed.savedAt || null });
  }
  // Whether mounting the wizard may start autosaving straight away. It must
  // not while an unanswered restore banner is showing, or the empty form would
  // overwrite the stored draft before the creator chooses. Autosave resumes on
  // the first edit (and immediately after a restore).
  function shouldAutoSaveOnMount(opts) {
    opts = opts || {};
    return !opts.demoMode && !opts.hasSavedDraft;
  }
  function clearDraft(projectId, store) {
    var s = draftStorage(store);
    if (!s) return false;
    try { s.removeItem(draftKey(projectId)); return true; } catch (e) { return false; }
  }

  // ---------- DOM: the guided wizard ----------
  // Renders into `mount` (an element views.js already mounted and loaded). All
  // DOM building for the create/edit flow lives here.
  //
  // ctx = {
  //   QUI, api, base, project, campaigns, allQuests, isEdit, questId,
  //   breadcrumb (html string), toast, navigate(path), reload(), onDirty(bool),
  //   storage (localStorage or null),
  // }
  function renderQuestWizard(mount, ctx) {
    var QUI = ctx.QUI;
    var api = ctx.api;
    var el = QUI.el;
    var esc = QUI.escapeHtml;
    var icon = QUI.icon;
    var toast = ctx.toast || function () {};
    var base = ctx.base;
    var isEdit = !!ctx.isEdit;
    var questId = ctx.questId;
    var project = ctx.project || {};
    var projectId = project.id;
    // The staging ?demo=1 read (views.js forwards it) rides along on the two
    // reads the capture identity cannot otherwise pass, so the wizard's
    // network and token pickers load for a screenshot instead of 403ing.
    var demoQs = ctx.demo ? '?demo=' + encodeURIComponent(ctx.demo) : '';

    var STEPS = [
      { key: 'basics', label: 'Basics' },
      { key: 'task', label: 'Task' },
      { key: 'reward', label: 'Reward' },
      { key: 'review', label: 'Review' },
    ];
    var state = {
      step: 'basics',
      draft: defaultDraft(),
      networks: [], tokens: [], presets: [], presetsError: false,
      badges: [], campaigns: ctx.campaigns || [],
      serverTask: null, editTaskId: null,
      savedDraft: null, restoreBannerEl: null,
      extraTaskCount: 0, status: null, dirty: false, blocked: false,
    };

    var INPUT_CLS = 'w-full rounded-lg bg-surface-container-high border border-line-strong px-3 py-2.5 min-h-[44px] text-sm placeholder:text-content-tertiary focus:outline-none focus:border-accent';
    var LABEL_CLS = 'block text-xs text-content-secondary mb-1';
    var ERR_CLS = 'field-error text-xs text-error mt-1 hidden';
    var CARD_CLS = 'rounded-2xl border border-line bg-surface p-5';
    var BTN_PRIMARY = QUI.BTN_PRIMARY;
    var BTN_SECONDARY = QUI.BTN_SECONDARY;

    var root = el('<div class="pb-28"></div>');
    mount.replaceChildren(root);
    root.appendChild(el('<p class="text-sm text-content-secondary animate-pulse">Loading the quest builder\u2026</p>'));

    // ---- loading ----
    var reads = [
      api.get('/api/v1/network-presets').catch(function () { state.presetsError = true; return { presets: [] }; }),
      api.get('/api/v1/projects/' + encodeURIComponent(projectId) + '/networks' + demoQs).catch(function () { return { networks: [] }; }),
      api.get('/api/v1/projects/' + encodeURIComponent(projectId) + '/tokens' + demoQs).catch(function () { return { tokens: [] }; }),
      api.get('/api/v1/badges').catch(function () { return { badges: [] }; }),
      isEdit ? api.get('/api/v1/quests/' + encodeURIComponent(questId)) : Promise.resolve(null),
      isEdit ? api.get('/api/v1/quests/' + encodeURIComponent(questId) + '/tasks') : Promise.resolve({ tasks: [] }),
      isEdit ? api.get('/api/v1/quests/' + encodeURIComponent(questId) + '/rewards').catch(function () { return {}; }) : Promise.resolve({}),
    ];
    Promise.all(reads).then(function (r) {
      state.presets = r[0].presets || [];
      state.networks = r[1].networks || [];
      state.tokens = r[2].tokens || [];
      state.badges = r[3].badges || [];
      var quest = r[4] ? r[4].quest : null;
      var tasks = r[5] ? (r[5].tasks || []) : [];
      if (quest) hydrateFromQuest(quest, tasks, r[6] || {});
      else if (ctx.seedCampaign != null && state.draft.campaign_id == null) state.draft.campaign_id = String(ctx.seedCampaign);
      // A step deep link (?step=/?task=) opens straight into that step, so a
      // screenshot or a check reaches it without clicking. On create it also
      // fills a labelled demo draft; it never autosaves or overwrites a real
      // saved draft. On edit it only moves the step, so a real quest's own data
      // is never replaced by demo content.
      var bootStep = ctx.boot && STEPS.some(function (x) { return x.key === ctx.boot.step; }) ? ctx.boot.step : null;
      if (ctx.boot && (ctx.boot.step || ctx.boot.task) && !isEdit) {
        state.demoMode = true;
        state.draft = demoDraft(ctx.boot.task || 'url_proof');
        if (state.draft.campaign_id == null && state.campaigns.length) state.draft.campaign_id = String(state.campaigns[0].id);
      }
      if (bootStep) state.step = bootStep;
      if (!state.demoMode) {
        var saved = loadDraft(projectId, ctx.storage);
        if (saved && !isEmptyDraft(saved)) state.savedDraft = saved;
      }
      buildChrome();
      renderStep();
      // An untouched form must not overwrite a stored draft before the creator
      // has answered the restore banner, or a reload would silently lose it.
      // Autosave resumes from the first edit (and after a restore).
      if (shouldAutoSaveOnMount({ demoMode: state.demoMode, hasSavedDraft: !!state.savedDraft })) autoSave();
    }).catch(function (err) {
      root.replaceChildren(el('<div class="rounded-xl border border-error/40 bg-error-bg p-4 text-sm text-error">' + esc(err.message) + '</div>'));
    });

    function hydrateFromQuest(quest, tasks, reward) {
      var d = state.draft;
      d.title = quest.title || '';
      d.description = quest.description || '';
      d.image_url = quest.image_url || '';
      d.instructions = quest.instructions || '';
      d.campaign_id = quest.campaign_id == null ? null : String(quest.campaign_id);
      d.xp_reward = quest.xp_reward == null ? '' : String(quest.xp_reward);
      d.points_reward = quest.points_reward == null ? '' : String(quest.points_reward);
      d.starts_at = quest.starts_at ? new Date(quest.starts_at).toISOString().slice(0, 10) : '';
      d.ends_at = quest.ends_at ? new Date(quest.ends_at).toISOString().slice(0, 10) : '';
      d.badge_id = reward.badge_id == null ? '' : String(reward.badge_id);
      d.credential_title = reward.credential_title || '';
      d.visibility = quest.visibility === 'unlisted' ? 'unlisted' : 'public';
      d.max_participants = quest.max_participants == null ? '' : String(quest.max_participants);
      d.completion_limit = quest.completion_limit == null ? '' : String(quest.completion_limit);
      d.is_required = quest.is_required !== false;
      d.requires_quests = (reward.requires_quests || []).map(Number);
      d.require_all = reward.require_all !== false;
      state.status = quest.status || null;
      d.quest_type = quest.quest_type || '';
      var task = tasks[0] || null;
      state.serverTask = task;
      state.editTaskId = task ? task.id : null;
      state.extraTaskCount = Math.max(0, tasks.length - 1);
      if (task) hydrateTask(task);
    }
    function hydrateTask(task) {
      var d = state.draft;
      var cfg = task.config || {};
      d.title = d.title || task.title || '';
      d.task_choice = choiceForTask(task);
      d.task_title = task.title || '';
      d.task_xp_reward = task.xp_reward == null ? '' : String(task.xp_reward);
      if (task.type === 'quiz') {
        d.quiz_pass_score = cfg.pass_score == null ? 80 : Number(cfg.pass_score);
        d.quiz_questions = (cfg.questions || []).length ? cfg.questions.map(function (q) {
          return { q: q.q || '', options: (q.options || ['', '']).slice(), answer: Number.isInteger(q.answer) ? q.answer : -1 };
        }) : [newQuestion(), newQuestion()];
      } else if (task.type === 'social') {
        d.task_url = cfg.url || '';
        d.task_action = SOCIAL_ACTIONS.indexOf(cfg.action) >= 0 ? cfg.action : 'visit';
      } else if (task.type === 'url_proof') {
        d.task_placeholder = cfg.placeholder || '';
      } else if (task.type === 'on_chain') {
        d.task_network_id = cfg.network_id == null ? '' : String(cfg.network_id);
        d.task_token_id = cfg.token_id == null ? '' : String(cfg.token_id);
        d.task_contract = cfg.contract || '';
        d.task_amount = cfg.requirement ? String(cfg.requirement.amount) : '';
        d.task_operator = cfg.requirement ? (cfg.requirement.operator || 'gte') : 'gte';
        d.task_confirmations = cfg.confirmations == null ? '' : String(cfg.confirmations);
      } else if (task.type === 'manual') {
        d.task_instructions = cfg.instructions || '';
      }
    }

    // ---- chrome ----
    function buildChrome() {
      root.replaceChildren();
      if (ctx.breadcrumb) root.appendChild(el('<div class="mb-4">' + ctx.breadcrumb + '</div>'));
      if (!state.campaigns.length && !isEdit) {
        root.appendChild(el(QUI.emptyState('This project has no campaigns yet. Create a campaign first.', 'Create campaign', base + '/campaigns?new=campaign')));
        state.blocked = true;
        return;
      }
      if (state.demoMode) {
        root.appendChild(el('<div class="rounded-xl border border-info/40 bg-info-bg p-3 mb-4 text-sm text-info">Staging demo: this is an example quest, not a real one.</div>'));
      }
      state.restoreBannerEl = restoreBanner();
      if (state.restoreBannerEl) root.appendChild(state.restoreBannerEl);
      root.appendChild(stepIndicator());
      root.appendChild(el('<div class="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-5 items-start"><div class="wizard-step"></div><aside class="preview-slot lg:sticky lg:top-4"></aside></div>'));
      root.appendChild(actionBar());
      state.stepEl = root.querySelector('.wizard-step');
      state.previewEl = root.querySelector('.preview-slot');
    }

    function stepIndicator() {
      var wrap = el('<ol class="flex items-center gap-1 mb-5 overflow-x-auto" aria-label="Quest steps"></ol>');
      STEPS.forEach(function (s, i) {
        var item = el('<li class="flex items-center gap-1 shrink-0"></li>');
        var btn = el('<span class="skip-step inline-flex items-center gap-2 px-3 py-2 min-h-[44px] rounded-full text-sm font-medium" data-step="' + s.key + '" role="button" tabindex="0">' +
          '<span class="step-num w-6 h-6 rounded-full inline-flex items-center justify-center text-xs">' + (i + 1) + '</span>' +
          '<span>' + esc(s.label) + '</span></span>');
        btn.addEventListener('click', function () { goStep(s.key); });
        btn.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goStep(s.key); } });
        item.appendChild(btn);
        if (i < STEPS.length - 1) item.appendChild(el('<span class="text-content-tertiary" aria-hidden="true">' + icon('chevron_right', { class: 'w-4 h-4' }) + '</span>'));
        wrap.appendChild(item);
      });
      return wrap;
    }

    function restoreBanner() {
      if (!state.savedDraft) return null;
      var banner = el('<div class="resume-banner rounded-xl border border-info/40 bg-info-bg p-4 mb-4 flex items-center gap-3 flex-wrap">' +
        '<span class="text-sm text-info flex-1">You have an unsaved draft of this quest.</span>' +
        '<button type="button" class="restore ' + BTN_PRIMARY + '">Restore draft</button>' +
        '<button type="button" class="discard ' + BTN_SECONDARY + '">Discard</button></div>');
      banner.querySelector('.restore').addEventListener('click', function () {
        state.draft = Object.assign(defaultDraft(), state.savedDraft);
        state.savedDraft = null;
        if (banner.parentNode) banner.remove();
        renderStep();
        setDirty(true);
        autoSave();
        toast('Draft restored');
      });
      banner.querySelector('.discard').addEventListener('click', function () {
        state.savedDraft = null;
        clearDraft(projectId, ctx.storage);
        if (banner.parentNode) banner.remove();
        toast('Draft discarded');
      });
      return banner;
    }

    // ---- step dispatch ----
    function renderStep() {
      if (state.blocked || !state.stepEl) return;
      state.stepEl.replaceChildren();
      if (state.step === 'basics') state.stepEl.appendChild(renderBasics());
      else if (state.step === 'task') state.stepEl.appendChild(renderTask());
      else if (state.step === 'reward') state.stepEl.appendChild(renderReward());
      else state.stepEl.appendChild(renderReview());
      renderPreview();
      syncStepIndicator();
      clearFieldErrors();
      setDirty(state.dirty);
    }

    // A labelled field wrapper carrying its validation key. `control` is either
    // an element or an html string.
    function field(label, control, fieldName, hint) {
      var wrap = el('<div class="field" data-field="' + fieldName + '"><label class="' + LABEL_CLS + '">' + esc(label) + '</label>' +
        (hint ? '<p class="text-xs text-content-tertiary mb-1">' + esc(hint) + '</p>' : '') + '<p class="' + ERR_CLS + '"></p></div>');
      var err = wrap.querySelector('.field-error');
      if (typeof control === 'string') wrap.insertBefore(el(control), err);
      else if (control) wrap.insertBefore(control, err);
      return wrap;
    }
    function input(cls, html) { return '<input class="' + cls + ' ' + INPUT_CLS + '" ' + html + '>'; }

    function renderBasics() {
      var d = state.draft;
      var sec = el('<section class="' + CARD_CLS + ' space-y-3"><h2 class="font-semibold mb-1">Quest basics</h2><p class="text-sm text-content-secondary mb-2">What participants see first.</p></section>');
      var grid = el('<div class="space-y-3"></div>');
      sec.appendChild(grid);
      grid.appendChild(field('Title', input('wiz-title', 'maxlength="200" placeholder="Quest title" value="' + esc(d.title) + '"'), 'title'));
      grid.appendChild(field('Description (optional)', '<textarea class="wiz-desc ' + INPUT_CLS + '" rows="2" placeholder="What is this quest about?">' + esc(d.description) + '</textarea>', 'description'));
      grid.appendChild(field('Cover image URL (optional)', input('wiz-image', 'placeholder="https://\u2026" value="' + esc(d.image_url) + '"'), 'image_url'));
      grid.appendChild(field('Instructions (optional)', '<textarea class="wiz-instr ' + INPUT_CLS + '" rows="2" placeholder="How should participants complete this quest?">' + esc(d.instructions) + '</textarea>', 'instructions'));
      var camp = el('<select class="wiz-campaign ' + INPUT_CLS + '"' + (isEdit ? ' disabled' : '') + '></select>');
      camp.appendChild(el('<option value="">Choose a campaign</option>'));
      state.campaigns.forEach(function (c) { camp.appendChild(el('<option value="' + c.id + '">' + esc(c.name) + '</option>')); });
      camp.value = d.campaign_id == null ? '' : String(d.campaign_id);
      grid.appendChild(field('Campaign', camp, 'campaign_id', isEdit ? 'The campaign cannot change after creation.' : ''));
      var dates = el('<div class="grid sm:grid-cols-2 gap-3"></div>');
      dates.appendChild(field('Starts (optional)', input('wiz-start', 'type="date" value="' + esc(d.starts_at) + '"'), 'starts_at'));
      dates.appendChild(field('Ends (optional)', input('wiz-end', 'type="date" value="' + esc(d.ends_at) + '"'), 'ends_at'));
      grid.appendChild(dates);
      wire(sec);
      return sec;
    }

    function renderTask() {
      var sec = el('<section class="' + CARD_CLS + ' space-y-3"><h2 class="font-semibold mb-1">Task</h2><p class="text-sm text-content-secondary mb-2">What participants must do.</p></section>');
      var typeField = el('<div class="field" data-field="task_choice"><span class="' + LABEL_CLS + '">Task type</span><div class="wiz-types space-y-2"></div></div>');
      var list = typeField.querySelector('.wiz-types');
      TASK_TYPES.forEach(function (t) {
        var active = state.draft.task_choice === t.key;
        var btn = el('<button type="button" class="wiz-type min-h-[44px] w-full text-left rounded-lg border px-3 py-2.5 ' +
          (active ? 'border-accent bg-accent/10' : 'border-line-strong bg-surface-container-high hover:bg-surface-container-highest') + '" data-type="' + t.key + '" aria-pressed="' + active + '">' +
          '<span class="block text-sm font-medium">' + esc(t.label) + '</span>' +
          '<span class="block text-xs text-content-secondary">' + esc(t.hint) + '</span></button>');
        btn.addEventListener('click', function () {
          state.draft.task_choice = t.key;
          state.draft.task_title = '';
          renderStep();
          setDirty(true);
        });
        list.appendChild(btn);
      });
      sec.appendChild(typeField);
      sec.appendChild(fillTaskFields());
      var extra = el('<div class="grid sm:grid-cols-2 gap-3"></div>');
      extra.appendChild(field('Task XP (optional)', input('wiz-task-xp', 'type="number" min="0" placeholder="0" value="' + esc(state.draft.task_xp_reward) + '"'), 'task_xp_reward', 'Extra XP for this task, on top of the quest reward.'));
      sec.appendChild(extra);
      sec.appendChild(field('Task title (optional)', input('wiz-task-title', 'maxlength="200" placeholder="' + esc(choiceLabel(state.draft.task_choice)) + '" value="' + esc(state.draft.task_title) + '"'), 'task_title'));
      wire(sec);
      return sec;
    }

    function fillTaskFields() {
      var d = state.draft;
      var h = el('<div class="space-y-3"></div>');
      taskFields(d.task_choice).forEach(function (f) {
        h.appendChild(taskField(f));
      });
      return h;
    }
    function taskField(f) {
      var d = state.draft;
      if (f.kind === 'questions') return quizEditor();
      if (f.kind === 'url') {
        return field(f.label, input('wiz-url', 'placeholder="' + f.placeholder + '" value="' + esc(d.task_url) + '"'), f.key);
      }
      if (f.kind === 'actionSelect') {
        var act = el('<select class="wiz-action ' + INPUT_CLS + '"><option value="visit">Visit the link</option><option value="join">Join the community</option><option value="follow">Follow the account</option></select>');
        act.value = SOCIAL_ACTIONS.indexOf(d.task_action) >= 0 ? d.task_action : 'visit';
        return field(f.label, act, f.key);
      }
      if (f.kind === 'passScore') {
        return field(f.label, input('wiz-pass', 'type="number" min="0" max="100" value="' + esc(d.quiz_pass_score) + '"'), f.key, f.hint);
      }
      if (f.kind === 'networkName') {
        // Network names come from the shared preset catalog (never duplicated
        // here); typing another name is still allowed.
        var nameField = field(f.label, input('wiz-net-name', 'list="wiz-net-names" placeholder="e.g. Ethereum or Sepolia" value="' + esc(d.task_network_name) + '"'), f.key, f.hint);
        var dl = el('<datalist id="wiz-net-names"></datalist>');
        state.presets.forEach(function (pr) { dl.appendChild(el('<option value="' + esc(pr.name) + '"></option>')); });
        nameField.insertBefore(dl, nameField.querySelector('.field-error'));
        return nameField;
      }
      if (f.kind === 'networkSelect') {
        var net = el('<select class="wiz-network ' + INPUT_CLS + '"></select>');
        net.appendChild(el('<option value="">Choose a network</option>'));
        state.networks.forEach(function (n) { net.appendChild(el('<option value="' + n.id + '">' + esc(n.name) + '</option>')); });
        net.value = d.task_network_id == null ? '' : String(d.task_network_id);
        return field(f.label, net, f.key, 'Networks are managed in project settings.');
      }
      // proofText
      return field(f.label, '<textarea class="wiz-task-instr ' + INPUT_CLS + '" rows="2" placeholder="e.g. Paste a link to your post">' + esc(d.task_instructions) + '</textarea>', f.key);
    }

    function quizEditor() {
      var d = state.draft;
      var box = el('<div class="field" data-field="quiz_questions"><div class="space-y-3"></div><p class="' + ERR_CLS + '"></p></div>');
      var inner = box.firstElementChild;
      inner.appendChild(el('<div class="flex items-center justify-between gap-2"><h3 class="text-sm font-medium">Questions</h3><span class="text-xs text-content-secondary">' + d.quiz_questions.length + (d.quiz_questions.length === 1 ? ' question' : ' questions') + '</span></div>'));
      d.quiz_questions.forEach(function (q, qi) { inner.appendChild(questionBlock(q, qi)); });
      var addQ = el('<button type="button" class="wiz-add-q ' + BTN_SECONDARY + '">' + icon('add', { class: 'w-4 h-4' }) + '<span>Add question</span></button>');
      addQ.addEventListener('click', function () { d.quiz_questions.push(newQuestion()); renderStep(); setDirty(true); });
      inner.appendChild(addQ);
      return box;
    }

    function questionBlock(q, qi) {
      var block = el('<div class="rounded-xl border border-line bg-surface-container p-3 space-y-2" data-q="' + qi + '"></div>');
      var top = el('<div class="flex items-center justify-between gap-2"><span class="text-xs font-medium text-content-secondary">Question ' + (qi + 1) + '</span></div>');
      var rm = el('<button type="button" class="wiz-rm-q min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-error" aria-label="Remove question">' + icon('delete') + '</button>');
      if (state.draft.quiz_questions.length <= 1) { rm.disabled = true; rm.className = 'wiz-rm-q min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-lg bg-surface-container-high text-content-disabled'; }
      rm.addEventListener('click', function () {
        state.draft.quiz_questions.splice(qi, 1);
        renderStep(); setDirty(true);
      });
      top.appendChild(rm);
      block.appendChild(top);
      block.appendChild(field('Question text', input('wiz-q-text', 'placeholder="Question text" value="' + esc(q.q) + '"'), 'quiz_questions[' + qi + ']'));
      var optsWrap = el('<div class="space-y-2"><p class="text-xs text-content-secondary">Options. Mark the correct one.</p><div class="wiz-opts space-y-2"></div><p class="' + ERR_CLS + '"></p></div>');
      var opts = optsWrap.querySelector('.wiz-opts');
      q.options.forEach(function (opt, oi) {
        var row = el('<div class="flex items-center gap-2" data-o="' + oi + '">' +
          '<input type="radio" name="wiz-correct-' + qi + '" class="wiz-correct w-5 h-5 shrink-0"' + (Number(q.answer) === oi ? ' checked' : '') + ' aria-label="Mark option ' + (oi + 1) + ' as the correct answer">' +
          '<input class="wiz-opt flex-1 ' + INPUT_CLS + '" placeholder="Option ' + (oi + 1) + '" value="' + esc(opt) + '">' +
          '<button type="button" class="wiz-rm-opt min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-content-secondary" aria-label="Remove option">' + icon('close', { class: 'w-4 h-4' }) + '</button></div>');
        row.querySelector('.wiz-correct').addEventListener('change', function () { q.answer = oi; state.draft.quiz_questions[qi].answer = oi; setDirty(true); });
        var rmOpt = row.querySelector('.wiz-rm-opt');
        if (q.options.length <= MIN_QUIZ_OPTIONS) rmOpt.disabled = true;
        rmOpt.addEventListener('click', function () {
          q.options.splice(oi, 1);
          if (Number(q.answer) === oi) q.answer = -1;
          else if (Number(q.answer) > oi) q.answer = Number(q.answer) - 1;
          renderStep(); setDirty(true);
        });
        opts.appendChild(row);
      });
      var addOpt = el('<button type="button" class="wiz-add-opt text-sm font-medium text-accent-text min-h-[44px] inline-flex items-center gap-1">' + icon('add', { class: 'w-4 h-4' }) + '<span>Add option</span></button>');
      if (q.options.length >= MAX_QUIZ_OPTIONS) { addOpt.disabled = true; addOpt.className = 'wiz-add-opt text-sm font-medium text-content-disabled min-h-[44px] inline-flex items-center gap-1'; }
      addOpt.addEventListener('click', function () { q.options.push(''); renderStep(); setDirty(true); });
      block.appendChild(optsWrap);
      block.appendChild(addOpt);
      return block;
    }

    function renderReward() {
      var d = state.draft;
      var sec = el('<section class="' + CARD_CLS + ' space-y-3"><h2 class="font-semibold mb-1">Reward</h2><p class="text-sm text-content-secondary mb-2">What participants earn.</p></section>');
      var grid = el('<div class="space-y-3"></div>');
      sec.appendChild(grid);
      grid.appendChild(field('Quest XP reward', input('wiz-xp', 'type="number" min="1" step="1" placeholder="e.g. 100" value="' + esc(d.xp_reward) + '"'), 'xp_reward', 'Every quest needs a positive whole number of XP.'));
      grid.appendChild(field('Points reward (optional)', input('wiz-points', 'type="number" min="0" placeholder="0" value="' + esc(d.points_reward) + '"'), 'points_reward'));
      var badge = el('<select class="wiz-badge ' + INPUT_CLS + '"><option value="">No badge</option></select>');
      state.badges.forEach(function (b) { badge.appendChild(el('<option value="' + b.id + '">' + esc(b.name) + (b.project_id ? '' : ' (platform)') + '</option>')); });
      badge.value = d.badge_id == null ? '' : String(d.badge_id);
      grid.appendChild(field('Badge (optional)', badge, 'badge_id'));
      grid.appendChild(field('Credential title (optional)', input('wiz-cred', 'placeholder="e.g. Basics Certified" value="' + esc(d.credential_title) + '"'), 'credential_title'));
      var prereq = el('<select class="wiz-prereq ' + INPUT_CLS + '" multiple size="4"></select>');
      (ctx.allQuests || []).forEach(function (q) { prereq.appendChild(el('<option value="' + q.id + '">' + esc(q.title) + (q.campaign_name ? ' \u00b7 ' + esc(q.campaign_name) : '') + '</option>')); });
      var sel = new Set((d.requires_quests || []).map(Number));
      prereq.querySelectorAll('option').forEach(function (o) { if (sel.has(Number(o.value))) o.selected = true; });
      var requireAll = el('<label class="flex items-center gap-2 text-sm text-content-secondary mt-2 min-h-[44px]"><input type="checkbox" class="wiz-require-all w-5 h-5"> Require all selected quests</label>');
      requireAll.querySelector('input').checked = d.require_all !== false;
      var prereqWrap = field('Prerequisite quests (optional)', prereq, 'requires_quests');
      prereqWrap.appendChild(requireAll);
      grid.appendChild(prereqWrap);
      var opts = el('<details class="rounded-xl border border-line bg-surface-container p-4"><summary class="cursor-pointer font-medium select-none min-h-[44px] inline-flex items-center">More options</summary><div class="mt-3 grid sm:grid-cols-2 gap-3"></div></details>');
      var oGrid = opts.querySelector('div');
      var vis = el('<select class="wiz-vis ' + INPUT_CLS + '"><option value="public">Public</option><option value="unlisted">Unlisted</option></select>');
      vis.value = d.visibility === 'unlisted' ? 'unlisted' : 'public';
      oGrid.appendChild(field('Visibility', vis, 'visibility'));
      oGrid.appendChild(field('Max participants (optional)', input('wiz-max', 'type="number" min="1" placeholder="No limit" value="' + esc(d.max_participants) + '"'), 'max_participants'));
      oGrid.appendChild(field('Completion limit', input('wiz-limit', 'type="number" min="1" placeholder="1" value="' + esc(d.completion_limit) + '"'), 'completion_limit'));
      var required = el('<label class="flex items-center gap-2 text-sm text-content-secondary self-end min-h-[44px]"><input type="checkbox" class="wiz-required w-5 h-5"' + (d.is_required !== false ? ' checked' : '') + '> Required to finish the campaign</label>');
      oGrid.appendChild(required);
      sec.appendChild(opts);
      wire(sec);
      return sec;
    }

    function renderReview() {
      var d = state.draft;
      var sec = el('<section class="' + CARD_CLS + '"><h2 class="font-semibold mb-1">Review</h2><p class="text-sm text-content-secondary mb-3">Check everything before you save.</p></section>');
      var summary = el('<dl class="divide-y divide-line-subtle"></dl>');
      function row(label, value) {
        if (value === undefined || value === null || value === '') return;
        summary.appendChild(el('<div class="flex gap-4 py-2.5"><dt class="text-sm text-content-secondary w-40 shrink-0">' + esc(label) + '</dt><dd class="text-sm min-w-0">' + value + '</dd></div>'));
      }
      var m = previewModel(d);
      row('Title', esc(m.title));
      row('Campaign', esc(campaignName(d.campaign_id)));
      row('Quest XP', esc(String(d.xp_reward || 0)));
      if (d.points_reward) row('Points', esc(String(d.points_reward)));
      row('Task', esc(typeLabel(m.type)) + ' \u00b7 ' + esc(m.detail));
      if (m.type === 'quiz') row('Questions', esc(String(m.quizQuestionCount)) + ', pass at ' + esc(String(m.passScore)) + '%');
      if (d.badge_id) row('Badge', esc(badgeName(d.badge_id)));
      if (d.credential_title) row('Credential', esc(d.credential_title));
      if ((d.requires_quests || []).length) row('Requires first', esc(prereqNames(d.requires_quests)));
      row('Visibility', esc(d.visibility === 'unlisted' ? 'Unlisted' : 'Public'));
      row('Required to finish', d.is_required !== false ? 'Yes' : 'No');
      if (isEdit && state.status) row('Status', esc(statusPill(state.status)));
      if (state.extraTaskCount > 0) row('Other tasks', esc(String(state.extraTaskCount)) + ' more stay on this quest');
      sec.appendChild(summary);
      var res = validateQuestDraft(d);
      if (!res.ok) {
        var box = el('<div class="mt-4 rounded-xl border border-error/40 bg-error-bg p-4"><p class="text-sm text-error font-medium mb-1">Fix these before you save:</p><ul class="list-disc ml-5 text-sm text-error"></ul></div>');
        var ul = box.querySelector('ul');
        Object.keys(res.errors).forEach(function (f) { ul.appendChild(el('<li>' + esc(res.errors[f]) + '</li>')); });
        sec.appendChild(box);
      }
      return sec;
    }

    // ---- preview card ----
    // Reuses the participant quest card's markup (badgePill + the task row) so
    // it renders exactly what a participant sees, and never carries an answer
    // index: previewModel reads only non-config draft fields.
    function renderPreview() {
      if (!state.previewEl) return;
      var m = previewModel(state.draft);
      var xp = parseInt(state.draft.xp_reward, 10);
      var points = parseInt(state.draft.points_reward, 10);
      var card = el('<div class="rounded-2xl border border-line bg-surface p-5"><p class="text-xs font-medium text-content-secondary mb-3">Preview: what participants see</p>' +
        '<h3 class="text-lg font-semibold mb-1">' + esc(m.title) + '</h3>' +
        '<p class="text-sm text-content-secondary mb-3">' + esc(m.description || 'No description yet') + '</p>' +
        '<div class="flex flex-wrap gap-2 mb-4">' + QUI.badgePill('+' + (Number.isFinite(xp) ? xp : 0) + ' XP') + (points ? QUI.badgePill('+' + points + ' points') : '') + '</div>' +
        '<div class="rounded-xl border border-line bg-surface-container p-4"><div class="flex items-start gap-3">' +
        '<span class="w-6 h-6 rounded-full border-2 border-line-strong shrink-0 mt-0.5 flex items-center justify-center text-xs" aria-hidden="true"></span>' +
        '<div class="min-w-0 flex-1"><p class="font-medium">' + esc(state.draft.task_title || m.title) + '</p>' +
        '<p class="text-xs text-content-secondary">' + esc(m.typeLabel) + '</p>' +
        '<p class="text-xs text-content-secondary mt-1">' + esc(m.detail) + '</p></div></div></div>' +
        '<p class="text-xs text-content-tertiary mt-3">This draft is kept on this device until you save it.</p></div>');
      state.previewEl.replaceChildren(card);
    }

    // ---- action bar ----
    function actionBar() {
      var bar = el('<div class="fixed bottom-0 left-0 right-0 z-30 border-t border-line bg-surface/95 backdrop-blur px-4 py-3">' +
        '<div class="max-w-3xl mx-auto flex items-center gap-2 flex-wrap">' +
        '<span class="wiz-dirty text-xs text-warning hidden">Unsaved changes</span><span class="flex-1"></span>' +
        '<a href="' + base + '/quests" class="wiz-cancel ' + BTN_SECONDARY + '">Cancel</a>' +
        '<button type="button" class="wiz-back ' + BTN_SECONDARY + ' hidden">Back</button>' +
        '<button type="button" class="wiz-next ' + BTN_PRIMARY + '">Next</button>' +
        '<button type="button" class="wiz-save ' + BTN_SECONDARY + ' hidden">' + (isEdit ? 'Save draft' : 'Save draft') + '</button>' +
        '<button type="button" class="wiz-publish ' + BTN_PRIMARY + ' hidden">' + (isEdit ? 'Save changes' : 'Publish') + '</button>' +
        '</div></div>');
      bar.querySelector('.wiz-cancel').addEventListener('click', function (e) { if (!confirmLeave()) e.preventDefault(); });
      bar.querySelector('.wiz-back').addEventListener('click', function () { var i = stepIndex(); if (i > 0) goStep(STEPS[i - 1].key); });
      bar.querySelector('.wiz-next').addEventListener('click', function () { var i = stepIndex(); if (i < STEPS.length - 1) goStep(STEPS[i + 1].key); });
      bar.querySelector('.wiz-save').addEventListener('click', function () { submit('draft', bar.querySelector('.wiz-save')); });
      bar.querySelector('.wiz-publish').addEventListener('click', function () { submit(isEdit ? null : 'active', bar.querySelector('.wiz-publish')); });
      return bar;
    }

    function stepIndex() { for (var i = 0; i < STEPS.length; i++) if (STEPS[i].key === state.step) return i; return 0; }
    function goStep(key) { readStepIntoDraft(); state.step = key; renderStep(); }

    function syncStepIndicator() {
      var idx = stepIndex();
      root.querySelectorAll('.skip-step').forEach(function (b, i) {
        var current = i === idx, done = i < idx;
        b.className = 'skip-step inline-flex items-center gap-2 px-3 py-2 min-h-[44px] rounded-full text-sm font-medium ' +
          (current ? 'bg-accent text-accent-contrast' : done ? 'bg-surface-container-high text-content-primary' : 'bg-surface-container text-content-secondary');
        var num = b.querySelector('.step-num');
        if (num) num.className = 'step-num w-6 h-6 rounded-full inline-flex items-center justify-center text-xs ' + (current ? 'bg-accent-contrast/20' : 'bg-surface-container-highest');
      });
      var back = root.querySelector('.wiz-back');
      var next = root.querySelector('.wiz-next');
      var save = root.querySelector('.wiz-save');
      var pub = root.querySelector('.wiz-publish');
      if (!next) return;
      back.classList.toggle('hidden', idx === 0);
      next.classList.toggle('hidden', idx === STEPS.length - 1);
      if (save) save.classList.toggle('hidden', idx !== STEPS.length - 1);
      pub.classList.toggle('hidden', idx !== STEPS.length - 1);
    }

    function readStepIntoDraft() {
      if (!state.stepEl) return;
      var d = state.draft;
      var val = function (sel) { var n = state.stepEl.querySelector(sel); return n ? n.value : ''; };
      if (state.step === 'basics') {
        d.title = val('.wiz-title'); d.description = val('.wiz-desc'); d.image_url = val('.wiz-image'); d.instructions = val('.wiz-instr');
        var camp = state.stepEl.querySelector('.wiz-campaign'); if (camp) d.campaign_id = camp.value || null;
        d.starts_at = val('.wiz-start'); d.ends_at = val('.wiz-end');
      } else if (state.step === 'task') {
        d.task_xp_reward = val('.wiz-task-xp'); d.task_title = val('.wiz-task-title');
        var type = taskTypeForChoice(d.task_choice);
        if (type === 'url_proof' || type === 'social') d.task_url = val('.wiz-url');
        if (type === 'social') d.task_action = val('.wiz-action') || 'visit';
        if (type === 'manual') d.task_instructions = val('.wiz-task-instr');
        if (type === 'wallet_connect') d.task_network_name = val('.wiz-net-name');
        if (type === 'on_chain') { var n = state.stepEl.querySelector('.wiz-network'); if (n) d.task_network_id = n.value; }
        if (type === 'quiz') {
          d.quiz_pass_score = val('.wiz-pass');
          state.stepEl.querySelectorAll('[data-q]').forEach(function (block) {
            var qi = Number(block.getAttribute('data-q'));
            var q = d.quiz_questions[qi]; if (!q) return;
            q.q = block.querySelector('.wiz-q-text').value;
            q.options = [];
            block.querySelectorAll('[data-o]').forEach(function (r) {
              q.options.push(r.querySelector('.wiz-opt').value);
              if (r.querySelector('.wiz-correct').checked) q.answer = Number(r.getAttribute('data-o'));
            });
          });
        }
      } else if (state.step === 'reward') {
        d.xp_reward = val('.wiz-xp'); d.points_reward = val('.wiz-points');
        var b = state.stepEl.querySelector('.wiz-badge'); if (b) d.badge_id = b.value;
        d.credential_title = val('.wiz-cred');
        var pr = state.stepEl.querySelector('.wiz-prereq'); if (pr) d.requires_quests = Array.prototype.map.call(pr.selectedOptions, function (o) { return Number(o.value); });
        var ra = state.stepEl.querySelector('.wiz-require-all'); if (ra) d.require_all = ra.checked;
        var v = state.stepEl.querySelector('.wiz-vis'); if (v) d.visibility = v.value;
        d.max_participants = val('.wiz-max'); d.completion_limit = val('.wiz-limit');
        var rq = state.stepEl.querySelector('.wiz-required'); if (rq) d.is_required = rq.checked;
      }
    }

    // Remove the restore banner once a decision is moot (the creator started
    // editing, or the draft was restored or discarded).
    function dismissRestoreBanner() {
      if (!state.savedDraft) return;
      state.savedDraft = null;
      var banner = root.querySelector('.resume-banner');
      if (banner && banner.parentNode) banner.remove();
    }

    // ---- inline validation ----
    function applyFieldErrors(errors) {
      clearFieldErrors();
      if (!state.stepEl) return;
      var first = null;
      Object.keys(errors || {}).forEach(function (f) {
        var holder = fieldRoot(f);
        if (!holder) return;
        var msg = holder.querySelector('.field-error');
        if (msg) { msg.textContent = errors[f]; msg.classList.remove('hidden'); }
        holder.classList.add('is-invalid');
        if (!first) first = holder;
      });
      if (first && typeof first.scrollIntoView === 'function') { try { first.scrollIntoView({ block: 'center' }); } catch (e) {} }
    }
    function fieldRoot(f) {
      if (!state.stepEl) return null;
      var m = /^quiz_questions\[(\d+)\]$/.exec(f);
      if (m) return state.stepEl.querySelector('[data-q="' + m[1] + '"]');
      if (f === 'quiz_questions') return state.stepEl.querySelector('[data-field="quiz_questions"]');
      return state.stepEl.querySelector('[data-field="' + f + '"]');
    }
    function clearFieldErrors() {
      if (!state.stepEl) return;
      state.stepEl.querySelectorAll('.field-error').forEach(function (n) { n.textContent = ''; n.classList.add('hidden'); });
      state.stepEl.querySelectorAll('.is-invalid').forEach(function (n) { n.classList.remove('is-invalid'); });
    }

    function wire(sec) {
      sec.addEventListener('input', onEdit);
      sec.addEventListener('change', onEdit);
      sec.addEventListener('blur', onBlur, true);
    }
    function onEdit(e) {
      // Typing settles the restore question: drop the banner (the stored draft
      // is now what the creator is editing) so it cannot linger over the form.
      dismissRestoreBanner();
      readStepIntoDraft();
      setDirty(true);
      renderPreview();
      autoSave();
      var t = e.target;
      if (t && t.closest) {
        var holder = t.closest('[data-field], [data-q]');
        if (holder) { var msg = holder.querySelector('.field-error'); if (msg) { msg.textContent = ''; msg.classList.add('hidden'); } holder.classList.remove('is-invalid'); }
      }
    }
    function onBlur(e) {
      var t = e.target;
      if (!t || !t.classList) return;
      var cls = String(t.className || '');
      var mapped = null;
      if (cls.indexOf('wiz-title') >= 0) mapped = 'title';
      else if (cls.indexOf('wiz-xp') >= 0) mapped = 'xp_reward';
      else if (cls.indexOf('wiz-url') >= 0) mapped = 'task_url';
      else if (cls.indexOf('wiz-pass') >= 0) mapped = 'quiz_pass_score';
      else if (cls.indexOf('wiz-task-instr') >= 0) mapped = 'task_instructions';
      else if (cls.indexOf('wiz-net-name') >= 0) mapped = 'task_network_name';
      else if (cls.indexOf('wiz-network') >= 0) mapped = 'task_network_id';
      if (!mapped) return;
      readStepIntoDraft();
      var res = validateQuestDraft(state.draft);
      var holder = fieldRoot(mapped);
      if (!holder) return;
      var msg = holder.querySelector('.field-error');
      if (!msg) return;
      if (res.errors[mapped]) { msg.textContent = res.errors[mapped]; msg.classList.remove('hidden'); holder.classList.add('is-invalid'); }
      else { msg.textContent = ''; msg.classList.add('hidden'); holder.classList.remove('is-invalid'); }
    }

    var saveTimer = null;
    function autoSave() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { saveDraft(projectId, state.draft, ctx.storage); }, 400);
    }
    function setDirty(v) {
      state.dirty = !!v;
      var d = root.querySelector('.wiz-dirty');
      if (d) d.classList.toggle('hidden', !state.dirty);
      if (typeof ctx.onDirty === 'function') ctx.onDirty(state.dirty);
    }
    function confirmLeave() {
      if (!state.dirty) return true;
      return window.confirm('You have unsaved changes. Leave without saving?');
    }

    // ---- submit ----
    function submit(status, btn) {
      readStepIntoDraft();
      var res = validateQuestDraft(state.draft);
      if (!res.ok) {
        var first = Object.keys(res.errors)[0];
        var step = errorStep(first);
        if (step !== state.step) goStep(step); else applyFieldErrors(res.errors);
        if (step === state.step) applyFieldErrors(res.errors);
        toast(res.errors[first], true);
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }
      var body = questFromDraft(state.draft);
      if (status) body.status = status;
      var finish = function (r) {
        clearDraft(projectId, ctx.storage);
        setDirty(false);
        if (btn) btn.disabled = false;
        var quest = r && r.quest ? r.quest : null;
        toast(isEdit ? 'Changes saved' : (status === 'draft' ? 'Quest saved as a draft' : 'Quest published'));
        if (quest && ctx.navigate) ctx.navigate(base + '/quests/' + encodeURIComponent(quest.id) + '/edit');
        else if (ctx.reload) ctx.reload();
      };
      var fail = function (err) {
        if (btn) { btn.disabled = false; btn.textContent = isEdit ? 'Save changes' : 'Publish'; }
        if (err && err.fields) applyFieldErrors(err.fields);
        toast(err && err.message ? err.message : 'Could not save the quest', true);
      };
      var call;
      if (isEdit) {
        var task = body.tasks[0];
        var taskCall = state.editTaskId
          ? api.patch('/api/v1/tasks/' + encodeURIComponent(state.editTaskId), { title: body.title, xp_reward: task.xp_reward, completion_mode: 'one_time', config: task.config })
          : api.post('/api/v1/quests/' + encodeURIComponent(questId) + '/tasks', { type: task.type, title: body.title, config: task.config, xp_reward: task.xp_reward });
        call = taskCall.then(function () { return api.patch('/api/v1/quests/' + encodeURIComponent(questId), body); });
      } else {
        var campaignId = state.draft.campaign_id;
        body.campaign_id = Number(campaignId);
        var key = 'quest-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
        call = api.post('/api/v1/campaigns/' + encodeURIComponent(campaignId) + '/quests', body, { headers: { 'Idempotency-Key': key } });
      }
      Promise.resolve(call).then(finish).catch(fail);
    }

    function errorStep(fieldName) {
      if (fieldName === 'title' || fieldName === 'campaign_id') return 'basics';
      if (fieldName === 'xp_reward' || fieldName === 'points_reward') return 'reward';
      return 'task';
    }
    function campaignName(id) {
      if (id == null || id === '') return '';
      var c = state.campaigns.filter(function (x) { return String(x.id) === String(id); })[0];
      return c ? c.name : '';
    }
    function badgeName(id) {
      var b = state.badges.filter(function (x) { return String(x.id) === String(id); })[0];
      return b ? b.name : '';
    }
    function prereqNames(ids) {
      var set = (ids || []).map(Number);
      return (ctx.allQuests || []).filter(function (q) { return set.indexOf(Number(q.id)) >= 0; }).map(function (q) { return q.title; }).join(', ');
    }
    function isEmptyDraft(d) {
      return !String(d.title || '').trim() && !String(d.task_url || '').trim() && !String(d.description || '').trim();
    }

    return {
      destroy: function () { if (saveTimer) clearTimeout(saveTimer); },
      isDirty: function () { return state.dirty; },
      confirmLeave: confirmLeave,
    };
  }

  return {
    STATUS_MAP: STATUS_MAP, statusBucket: statusBucket, statusPill: statusPill, STATUS_BUCKETS: STATUS_BUCKETS,
    TYPE_CHOICES: TYPE_CHOICES, TASK_TYPES: TASK_TYPES, taskTypeToConfig: taskTypeToConfig, choiceForTask: choiceForTask,
    duplicateTitle: duplicateTitle, reorderSortOrders: reorderSortOrders,
    defaultDraft: defaultDraft, demoDraft: demoDraft, newQuestion: newQuestion, validateQuestDraft: validateQuestDraft,
    questDraftRules: questDraftRules, taskTypeForChoice: taskTypeForChoice, isChainChoice: isChainChoice,
    typeLabel: typeLabel, choiceLabel: choiceLabel, requirementLine: requirementLine,
    isValidHttpUrl: isValidHttpUrl, isPositiveInt: isPositiveInt, taskFields: taskFields,
    quizQuestionsForSave: quizQuestionsForSave, sanitizeQuizQuestions: sanitizeQuizQuestions,
    stripQuizAnswers: stripQuizAnswers, stripAnswersFromTask: stripAnswersFromTask, configLeaksAnswer: configLeaksAnswer,
    tasksFromDraft: tasksFromDraft, questFromDraft: questFromDraft, previewModel: previewModel,
    draftKey: draftKey, saveDraft: saveDraft, loadDraft: loadDraft, clearDraft: clearDraft,
    shouldAutoSaveOnMount: shouldAutoSaveOnMount,
    renderQuestWizard: renderQuestWizard,
  };
});
