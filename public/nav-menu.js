// Create-menu model. Pure data so it can be unit-tested without a DOM:
// given the projects the caller can manage, what may the Create menu offer?
// Project is always available; Campaign, Quest and Task only make sense once
// the caller runs at least one project, and each points at the real create
// surface inside that project's dashboard.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.QuestoraNavMenu = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // One source of truth for navigation destinations, so the desktop bar, the
  // mobile drawer and the bottom bar cannot drift. `icon` names resolve
  // through window.QUI.icon at render time. `match` is the active-route test.
  var NAV = [
    { label: 'Projects', path: '/projects', icon: 'folder', match: '^/projects' },
    { label: 'Campaigns', path: '/campaigns', icon: 'campaign', match: '^/campaigns' },
  ];
  // Top-level / high-frequency destinations, the ones the bottom bar shows.
  var BOTTOM_NAV = [
    { label: 'Projects', path: '/projects', icon: 'folder', match: '^/projects' },
    { label: 'Campaigns', path: '/campaigns', icon: 'campaign', match: '^/campaigns' },
    { label: 'Create', path: '/create', icon: 'add', match: '^/create' },
    { label: 'Profile', path: '/me', icon: 'account_circle', match: '^/me' },
  ];
  // Secondary destinations, drawer-only.
  var UTILITY_NAV = [
    { label: 'My Projects', path: '/my-projects', icon: 'folder', match: '^/my-projects' },
    { label: 'Profile', path: '/me', icon: 'person', match: '^/me' },
    { label: 'Connected Wallets', path: '/me?tab=wallets', icon: 'account_balance_wallet', match: '^/me' },
    { label: 'Settings', path: '/settings', icon: 'settings', match: '^/settings' },
  ];

  function base(slug) { return '/dashboard/projects/' + encodeURIComponent(slug); }

  function actionsFor(slug) {
    return [
      { key: 'campaign', label: 'Campaign', href: base(slug) + '/campaigns?new=campaign' },
      { key: 'quest', label: 'Quest', href: base(slug) + '/quests?new=quest' },
      { key: 'task', label: 'Task', href: base(slug) + '/quests?new=task' },
    ];
  }

  function createMenuItems(projects) {
    var list = (projects || []).filter(function (p) { return p && p.slug; });
    var model = {
      project: { key: 'project', label: 'Project', href: '/create', hint: 'Start a new project' },
      items: [],
      needsPicker: list.length > 1,
      projects: list,
      hint: '',
    };
    if (!list.length) {
      model.hint = 'Create a project first to add campaigns, quests and tasks.';
      return model;
    }
    // Every action belongs to exactly one project when there is only one;
    // with several, the descriptor is project-agnostic and the UI asks which.
    if (list.length === 1) {
      model.items = actionsFor(list[0].slug).map(function (a) {
        return Object.assign({}, a, { hint: 'In ' + list[0].name });
      });
    } else {
      model.items = [
        { key: 'campaign', label: 'Campaign' },
        { key: 'quest', label: 'Quest' },
        { key: 'task', label: 'Task' },
      ];
    }
    return model;
  }

  function projectActions(project) { return actionsFor(project.slug); }

  function matchRe(dest) { return new RegExp(dest.match); }

  return { NAV: NAV, BOTTOM_NAV: BOTTOM_NAV, UTILITY_NAV: UTILITY_NAV, matchRe: matchRe, createMenuItems: createMenuItems, projectActions: projectActions, actionsFor: actionsFor };
});
