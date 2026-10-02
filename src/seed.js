const { pool, IS_STAGING } = require('./db');
const { slugify } = require('./util');

// Staging-only demo data. Idempotent, obviously fake, never the visitor.
// All private-table rows (submissions, audits) are re-seeded here too since
// staging copies of those tables start empty.

const USERS = [1, 2, 3, 4, 5, 6].map(i => ({
  username: `staging-demo-user-${i}`, display_name: `Staging demo user ${i}`,
}));

async function upsertUser(username, display_name) {
  const idr = username.replace(/\D/g, '');
  const { rows } = await pool.query(
    `INSERT INTO users (usernode_id, username, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (usernode_id) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [900000 + Number(idr), username, display_name]
  );
  return rows[0].id;
}

async function upsertProject(ownerId, name, extra) {
  const slug = slugify(name);
  const { rows } = await pool.query(
    `INSERT INTO projects (slug, owner_user_id, name, description, logo_url, website)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (slug) DO UPDATE SET description = EXCLUDED.description
     RETURNING id`,
    [slug, ownerId, name, extra.description, extra.logo_url, extra.website]
  );
  await pool.query(
    `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')
     ON CONFLICT (project_id, user_id) DO NOTHING`, [rows[0].id, ownerId]);
  return rows[0].id;
}

async function upsertCampaign(projectId, name, extra) {
  const slug = slugify(name);
  const { rows } = await pool.query(
    `INSERT INTO campaigns (project_id, slug, name, description, banner_url, category, chains,
                            starts_at, ends_at, status, featured, xp_multiplier, visibility, rules)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (project_id, slug) DO UPDATE SET
       status = EXCLUDED.status, description = EXCLUDED.description,
       visibility = EXCLUDED.visibility, rules = EXCLUDED.rules
     RETURNING id`,
    [projectId, slug, name, extra.description, extra.banner_url, extra.category, extra.chains || [],
      extra.starts_at, extra.ends_at, extra.status, !!extra.featured, extra.xp_multiplier || 1,
      extra.visibility || 'public', extra.rules || null]
  );
  return rows[0].id;
}

async function upsertQuest(campaignId, title, extra, tasks) {
  // Idempotency guard: seeded quests are found by campaign + title.
  const existing = await pool.query(
    'SELECT id, slug FROM quests WHERE campaign_id = $1 AND title = $2 ORDER BY id LIMIT 1',
    [campaignId, title]
  );
  if (existing.rows.length) {
    // Keep the seeded status/type/dates current across re-seeds.
    await pool.query(
      `UPDATE quests SET status = $2, quest_type = $3, starts_at = $4, ends_at = $5 WHERE id = $1`,
      [existing.rows[0].id, extra.status || 'active', extra.quest_type || null,
        extra.starts_at || null, extra.ends_at || null]);
    return existing.rows[0].id;
  }
  let slug = slugify(title) || ('quest-' + Date.now());
  const clash = await pool.query('SELECT 1 FROM quests WHERE campaign_id = $1 AND slug = $2', [campaignId, slug]);
  if (clash.rows.length) slug = slug + '-' + Math.floor(Math.random() * 9000 + 1000);
  const { rows } = await pool.query(
    `INSERT INTO quests (campaign_id, slug, title, description, sort_order, is_required, xp_reward,
                         points_reward, status, quest_type, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [campaignId, slug, title, extra.description || null, extra.sort_order || 0,
      extra.is_required !== false, extra.xp || 0, extra.points || 0,
      extra.status || 'active', extra.quest_type || null, extra.starts_at || null, extra.ends_at || null]
  );
  const questId = rows[0].id;
  const campScope = await pool.query('SELECT project_id FROM campaigns WHERE id = $1', [campaignId]);
  const projectId = campScope.rows[0] ? campScope.rows[0].project_id : null;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const ins = await pool.query(
      `INSERT INTO quest_tasks (quest_id, type, title, config, sort_order, verification_type, proof_required,
                                project_id, campaign_id, xp_reward, completion_mode, max_completions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [questId, t.type, t.title, JSON.stringify(t.config || {}), i,
        ['quiz', 'wallet_connect', 'on_chain'].includes(t.type) ? 'automatic' : 'manual',
        ['url_proof', 'manual', 'social'].includes(t.type), projectId, campaignId,
        Math.max(0, parseInt(t.xp_reward, 10) || 0), t.completion_mode || 'one_time',
        Math.max(1, parseInt(t.max_completions, 10) || 1)]
    );
    const ver = await pool.query(
      `INSERT INTO task_versions (task_id, version, config) VALUES ($1, 1, $2) RETURNING id`,
      [ins.rows[0].id, JSON.stringify(t.config || {})]);
    await pool.query('UPDATE quest_tasks SET current_version_id = $2 WHERE id = $1', [ins.rows[0].id, ver.rows[0].id]);
  }
  await pool.query(`INSERT INTO quest_conditions (quest_id, operator, config) VALUES ($1, 'all', '{}')`, [questId]);
  if (extra.badge_key) {
    const b = await pool.query('SELECT id FROM badges WHERE key = $1 AND project_id IS NULL LIMIT 1', [extra.badge_key]);
    if (b.rows.length) {
      await pool.query(`INSERT INTO rewards (quest_id, kind, config) VALUES ($1, 'badge', $2)`,
        [questId, JSON.stringify({ badge_id: b.rows[0].id })]);
    }
  }
  return questId;
}

async function upsertBadge(projectId, key, name, icon, rarity, description) {
  const { rows } = await pool.query(
    `INSERT INTO badges (project_id, key, name, icon, rarity, description)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id, key) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [projectId, key, name, icon, rarity, description]
  );
  return rows[0].id;
}

async function completeQuest(questId, userId, xp, seasonId) {
  const scope = await pool.query(
    `SELECT q.campaign_id, c.project_id FROM quests q JOIN campaigns c ON c.id = q.campaign_id WHERE q.id = $1`,
    [questId]);
  const campaignId = scope.rows[0] ? scope.rows[0].campaign_id : null;
  const projectId = scope.rows[0] ? scope.rows[0].project_id : null;
  await pool.query(
    `INSERT INTO quest_completions (quest_id, user_id, project_id, campaign_id, status, xp_awarded)
     VALUES ($1, $2, $3, $4, 'completed', $5) ON CONFLICT (quest_id, user_id) DO NOTHING`,
    [questId, userId, projectId, campaignId, xp]
  );
  await pool.query(
    `INSERT INTO xp_events (user_id, amount, source_type, source_id, season_id, project_id, campaign_id, quest_id)
     VALUES ($1, $2, 'quest', $3, $4, $5, $6, $3) ON CONFLICT (source_type, source_id, user_id) DO NOTHING`,
    [userId, xp, questId, seasonId || null, projectId, campaignId]
  );
  // One scoped points row, on the project's own system when one exists.
  await pool.query(
    `INSERT INTO points_events (system_id, user_id, amount, source_type, source_id, project_id, campaign_id, quest_id)
     SELECT COALESCE((SELECT id FROM points_systems WHERE project_id = $4 ORDER BY id LIMIT 1),
                     (SELECT id FROM points_systems WHERE key = 'global' LIMIT 1)),
            $1, $2, 'quest', $3, $4, $5, $3
     ON CONFLICT (source_type, source_id, user_id, system_id) DO NOTHING`,
    [userId, Math.round(xp / 2), questId, projectId, campaignId]
  );
}

async function seed() {
  if (!IS_STAGING) return;

  await pool.query(
    `INSERT INTO points_systems (project_id, key, name)
     VALUES (NULL, 'global', 'Global points')
     ON CONFLICT (project_id, key) DO NOTHING`
  );

  // 5 projects owned by users 1-5.
  const projectDefs = [
    { name: 'Staging demo Octra Builders', user: 1, description: 'Staging demo project for builder quests.', logo_url: null, website: 'https://example.com/octra' },
    { name: 'Staging demo Nebula AI', user: 2, description: 'Staging demo project for AI quests.', logo_url: null, website: 'https://example.com/nebula' },
    { name: 'Staging demo Nova Gaming', user: 3, description: 'Staging demo project for gaming quests.', logo_url: null, website: 'https://example.com/nova' },
    { name: 'Staging demo Open DeFi', user: 4, description: 'Staging demo project for DeFi quests.', logo_url: null, website: 'https://example.com/defi' },
    { name: 'Staging demo Chain Academy', user: 5, description: 'Staging demo project for learning quests.', logo_url: null, website: 'https://example.com/academy' },
    // Archived (soft-deleted): owned by user 6, hidden from the public
    // directory, restorable through PATCH status='active'.
    { name: 'Staging demo Legacy Vault', user: 6, description: 'Staging demo project: archived, kept for the restore path.', logo_url: null, website: 'https://example.com/legacy' },
  ];
  const userIds = {};
  for (const u of USERS) userIds[u.username] = await upsertUser(u.username, u.display_name);
  // Deterministic invite codes for the demo users (Phase 2 referral demo).
  for (let i = 1; i <= 6; i++) {
    await pool.query(
      `UPDATE users SET ref_code = $1 WHERE username = $2 AND ref_code IS NULL`,
      [`demo-ref-${i}`, `staging-demo-user-${i}`]);
  }
  const projectIds = {};
  const projectSystemIds = {};
  for (const p of projectDefs) {
    projectIds[p.name] = await upsertProject(
      userIds[`staging-demo-user-${p.user}`], p.name,
      { description: p.description, logo_url: p.logo_url, website: p.website });
    const sys = await pool.query(
      `INSERT INTO points_systems (project_id, key, name) VALUES ($1, 'default', $2)
       ON CONFLICT (project_id, key) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [projectIds[p.name], p.name + ' points']);
    projectSystemIds[p.name] = sys.rows[0].id;
  }
  // Soft-delete the Legacy Vault so the directory filter has an archived row.
  await pool.query(
    `UPDATE projects SET status = 'archived', deleted_at = NOW() WHERE slug = $1 AND deleted_at IS NULL`,
    [slugify('Staging demo Legacy Vault')]);

  // Season (Phase 3): a 2x demo season, more recent than the Season 1 row
  // the migration creates, so seasons.current() picks this one in staging
  // and the profile/leaderboard previews show a seasonal multiplier.
  const demoSeason = await pool.query(
    `INSERT INTO seasons (slug, name, starts_at, ends_at, xp_multiplier)
     VALUES ('staging-demo-season', 'Staging demo Season', $1, $2, 2.0)
     ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [new Date(Date.now() - 1 * 864e5), new Date(Date.now() + 29 * 864e5)]);
  const seasonId = demoSeason.rows.length ? demoSeason.rows[0].id
    : (await pool.query(`SELECT id FROM seasons WHERE slug = 'staging-demo-season'`)).rows[0].id;

  // 8 badges: one platform badge + project badges, mixed rarities.
  const platformBadge = await upsertBadge(null, 'early-builder', 'Staging demo Early Builder', null, 'rare', 'Staging demo badge for finishing a campaign.');
  await upsertBadge(projectIds['Staging demo Octra Builders'], 'octra-contributor', 'Staging demo Octra Contributor', null, 'common', 'Staging demo badge for Octra Builders quests.');
  await upsertBadge(projectIds['Staging demo Nebula AI'], 'nebula-explorer', 'Staging demo Nebula Explorer', null, 'common', 'Staging demo badge for Nebula AI quests.');
  await upsertBadge(projectIds['Staging demo Nova Gaming'], 'nova-player', 'Staging demo Nova Player', null, 'common', 'Staging demo badge for Nova Gaming quests.');
  await upsertBadge(projectIds['Staging demo Open DeFi'], 'defi-pioneer', 'Staging demo DeFi Pioneer', null, 'rare', 'Staging demo badge for Open DeFi quests.');
  await upsertBadge(projectIds['Staging demo Chain Academy'], 'academy-graduate', 'Staging demo Academy Graduate', null, 'common', 'Staging demo badge for Chain Academy quests.');
  await upsertBadge(null, 'quest-master', 'Staging demo Quest Master', null, 'epic', 'Staging demo badge for completing 10 quests.');
  await upsertBadge(null, 'community-champion', 'Staging demo Community Champion', null, 'legendary', 'Staging demo badge for outstanding community work.');

  // 5 campaigns in every visible state.
  const campWelcome = await upsertCampaign(projectIds['Staging demo Octra Builders'], 'Staging demo Welcome Campaign', {
    description: 'Staging demo campaign: your first steps on Questora.',
    category: 'Community', status: 'active', featured: true, rules: 'Complete every quest to finish the campaign.',
    starts_at: new Date(Date.now() - 7 * 864e5), ends_at: new Date(Date.now() + 21 * 864e5),
  });
  // A second campaign in the same project, so the project leaderboard sums
  // more than one campaign and differs from any single campaign board.
  const campGrowth = await upsertCampaign(projectIds['Staging demo Octra Builders'], 'Staging demo Growth Sprint', {
    description: 'Staging demo campaign: a short sprint with its own board.',
    category: 'Community', status: 'active', featured: false,
    starts_at: new Date(Date.now() - 1 * 864e5), ends_at: new Date(Date.now() + 9 * 864e5),
  });
  // A paused and an archived campaign so the status filters have data.
  await upsertCampaign(projectIds['Staging demo Octra Builders'], 'Staging demo Paused Pilot', {
    description: 'Staging demo campaign: paused, so it is not joinable.',
    category: 'Community', status: 'paused',
    starts_at: new Date(Date.now() - 2 * 864e5), ends_at: new Date(Date.now() + 12 * 864e5),
  });
  await upsertCampaign(projectIds['Staging demo Octra Builders'], 'Staging demo Archived Draft', {
    description: 'Staging demo campaign: archived, kept for reference.',
    category: 'Community', status: 'archived', visibility: 'unlisted',
    starts_at: new Date(Date.now() - 40 * 864e5), ends_at: new Date(Date.now() - 10 * 864e5),
  });
  const campDev = await upsertCampaign(projectIds['Staging demo Nebula AI'], 'Staging demo Developer Journey', {
    description: 'Staging demo campaign: developer quests and contributions.',
    category: 'Developer', status: 'active', featured: true,
    starts_at: new Date(Date.now() - 3 * 864e5), ends_at: new Date(Date.now() + 30 * 864e5),
  });
  const campExplore = await upsertCampaign(projectIds['Staging demo Nova Gaming'], 'Staging demo Community Explorer', {
    description: 'Staging demo campaign: explore the community.',
    category: 'Social', status: 'active',
    starts_at: new Date(Date.now() - 864e5), ends_at: new Date(Date.now() + 3 * 864e5),
  });
  await upsertCampaign(projectIds['Staging demo Open DeFi'], 'Staging demo On-Chain Pioneer', {
    description: 'Staging demo campaign: on-chain activities (scheduled).',
    category: 'DeFi', status: 'scheduled',
    starts_at: new Date(Date.now() + 5 * 864e5), ends_at: new Date(Date.now() + 40 * 864e5),
  });
  await upsertCampaign(projectIds['Staging demo Chain Academy'], 'Staging demo Builder Season', {
    description: 'Staging demo campaign: a past season (ended).',
    category: 'Education', status: 'ended',
    starts_at: new Date(Date.now() - 60 * 864e5 * 30), ends_at: new Date(Date.now() - 7 * 864e5),
  });

  // ~12 quests across campaigns, all five task types represented.
  const quizConfig = {
    pass_score: 80,
    questions: [
      { q: 'What does XP measure on Questora?', options: ['Your progress', 'Your wallet balance', 'Your gas fees'], answer: 0 },
      { q: 'Who verifies a quest you complete?', options: ['The frontend', 'The server', 'Nobody'], answer: 1 },
      { q: 'What does a badge represent?', options: ['A reward', 'An achievement', 'A transaction'], answer: 1 },
    ],
  };
  const q1 = await upsertQuest(campWelcome, 'Connect Wallet', { description: 'Staging demo quest: link a wallet by signing a message.', xp: 100, points: 50, sort_order: 0 }, [
    { type: 'wallet_connect', title: 'Connect and sign', config: {} },
  ]);
  const q2 = await upsertQuest(campWelcome, 'Join Community', { description: 'Staging demo quest: visit the community space.', xp: 50, points: 25, sort_order: 1 }, [
    { type: 'social', title: 'Visit and confirm', config: { url: 'https://example.com/community', action: 'join' } },
  ]);
  const q3 = await upsertQuest(campWelcome, 'Complete Quiz', { description: 'Staging demo quest: prove what you know. Pass at 80%.', xp: 150, points: 75, sort_order: 2 }, [
    { type: 'quiz', title: 'Questora basics quiz', config: quizConfig },
  ]);
  await upsertQuest(campWelcome, 'Submit Proof', { description: 'Staging demo quest: share a link to something you built.', xp: 80, points: 40, sort_order: 3 }, [
    { type: 'url_proof', title: 'Share your work', config: { placeholder: 'https://your-work.example' } },
  ]);
  await upsertQuest(campDev, 'Submit GitHub Contribution', { description: 'Staging demo quest: link a pull request or issue.', xp: 200, points: 100, sort_order: 0 }, [
    { type: 'url_proof', title: 'Link your contribution', config: { placeholder: 'https://github.com/...' } },
  ]);
  await upsertQuest(campDev, 'Hold Token', { description: 'Staging demo quest: balance checks need an RPC, so this one is reviewed manually in staging.', xp: 120, points: 60, sort_order: 1 }, [
    { type: 'manual', title: 'Share your balance proof', config: {} },
  ]);
  await upsertQuest(campExplore, 'Introduce Yourself', { description: 'Staging demo quest: say hello in the community.', xp: 40, points: 20, sort_order: 0 }, [
    { type: 'manual', title: 'Write your introduction', config: {} },
  ]);
  await upsertQuest(campExplore, 'Follow the Project', { description: 'Staging demo quest: follow Nova Gaming.', xp: 30, points: 15, sort_order: 1 }, [
    { type: 'social', title: 'Follow', config: { url: 'https://example.com/nova', action: 'follow' } },
  ]);

  // Four more quests reach the spec's ~12 total, including one LOCKED quest
  // that demonstrates the prerequisite feature on the campaign checklist. It
  // requires Connect Wallet and Complete Quiz first, so a fresh visitor sees
  // it locked with its reason while demo users 1-3 could finish it.
  const qLocked = await upsertQuest(campWelcome, 'Claim Veteran Status', { description: 'Staging demo quest: unlock this one by finishing Connect Wallet and Complete Quiz first.', xp: 120, points: 60, sort_order: 4 }, [
    { type: 'manual', title: 'Say you are ready', config: {} },
  ]);
  await pool.query(
    `UPDATE quest_conditions SET operator = 'all', config = $2 WHERE quest_id = $1`,
    [qLocked, JSON.stringify({ requires_quests: [q1, q3] })]);
  await upsertQuest(campDev, 'Answer the Protocol Quiz', { description: 'Staging demo quest: a second quiz for the developer track.', xp: 90, points: 45, sort_order: 2 }, [
    { type: 'quiz', title: 'Developer track quiz', config: {
      pass_score: 80,
      questions: [
        { q: 'Who grades a quiz submission?', options: ['The project reviewer', 'The server', 'The browser'], answer: 1 },
        { q: 'When does a rejection need a reason?', options: ['Always', 'Never', 'Only for quizzes'], answer: 0 },
      ],
    } },
  ]);
  await upsertQuest(campDev, 'Write a Guide', { description: 'Staging demo quest: publish a short guide and link it.', xp: 140, points: 70, sort_order: 3 }, [
    { type: 'url_proof', title: 'Link your guide', config: { placeholder: 'https://your-guide.example' } },
  ]);
  await upsertQuest(campExplore, 'Attend the Community Call', { description: 'Staging demo quest: join the weekly call and say hi.', xp: 60, points: 30, sort_order: 2 }, [
    { type: 'social', title: 'Join the call', config: { url: 'https://example.com/call', action: 'join' } },
  ]);

  // Growth Sprint quests (second Octra campaign) plus one draft quest so the
  // quest status filter has a non-active row.
  const qRefer = await upsertQuest(campGrowth, 'Staging demo Refer a Builder', { description: 'Staging demo quest: bring a fellow builder along.', xp: 50, points: 25, quest_type: 'Social', sort_order: 0 }, [
    { type: 'social', title: 'Share your invite', config: { url: 'https://example.com/invite', action: 'join' } },
  ]);
  const qVote = await upsertQuest(campGrowth, 'Staging demo Vote on Proposal', { description: 'Staging demo quest: cast a vote on the open proposal.', xp: 75, points: 35, quest_type: 'Submission', sort_order: 1 }, [
    { type: 'manual', title: 'Confirm you voted', config: {} },
  ]);
  await upsertQuest(campGrowth, 'Staging demo Draft Idea', { description: 'Staging demo quest: still a draft, not yet published.', xp: 40, points: 20, quest_type: 'Submission', status: 'draft', sort_order: 2 }, [
    { type: 'manual', title: 'Draft task', config: {} },
  ]);

  // A draft and a scheduled campaign in the same project so the campaign
  // table's status filter and the empty-state copy have data at every state.
  const campDraft = await upsertCampaign(projectIds['Staging demo Octra Builders'], 'Staging demo Orbit Lab', {
    description: 'Staging demo campaign: a draft, not yet published.',
    category: 'Community', status: 'draft',
    starts_at: new Date(Date.now() + 14 * 864e5), ends_at: new Date(Date.now() + 45 * 864e5),
  });
  const campScheduled = await upsertCampaign(projectIds['Staging demo Octra Builders'], 'Staging demo Signal Boost', {
    description: 'Staging demo campaign: scheduled to start soon.',
    category: 'Community', status: 'scheduled',
    starts_at: new Date(Date.now() + 2 * 864e5), ends_at: new Date(Date.now() + 20 * 864e5),
  });
  // Quest status variety so the quest table's status filter is exercisable.
  await upsertQuest(campScheduled, 'Staging demo Scheduled Quest', { description: 'Staging demo quest: scheduled to open with its campaign.', xp: 60, points: 30, quest_type: 'Social', status: 'scheduled', sort_order: 0 }, [
    { type: 'social', title: 'Share the news', config: { url: 'https://example.com/boost', action: 'visit' } },
  ]);
  await upsertQuest(campGrowth, 'Staging demo Paused Quest', { description: 'Staging demo quest: paused while the team reviews it.', xp: 45, points: 20, quest_type: 'Submission', status: 'paused', sort_order: 3 }, [
    { type: 'manual', title: 'Confirm a review is pending', config: {} },
  ]);
  await upsertQuest(campGrowth, 'Staging demo Ended Quest', { description: 'Staging demo quest: this one has ended.', xp: 30, points: 15, quest_type: 'Social', status: 'ended', sort_order: 4 }, [
    { type: 'social', title: 'Old social task', config: { url: 'https://example.com/old', action: 'visit' } },
  ]);
  await upsertQuest(campDraft, 'Staging demo Archived Quest', { description: 'Staging demo quest: archived, kept for reference.', xp: 25, points: 10, quest_type: 'Submission', status: 'archived', sort_order: 0 }, [
    { type: 'manual', title: 'Archived task', config: {} },
  ]);

  // Credential rewards (Phase 2): completing the quiz quest issues one.
  await pool.query(
    `INSERT INTO rewards (quest_id, kind, config)
     SELECT $1, 'credential', '{"title": "Staging demo Questora Basics Credential"}'::jsonb
     WHERE NOT EXISTS (SELECT 1 FROM rewards WHERE quest_id = $1 AND kind = 'credential')`,
    [q3]);
  // One seeded credential with a fixed UUID so the public page is a stable
  // deep link in staging.
  await pool.query(
    `INSERT INTO credentials (id, issuer_project_id, recipient_user_id, title, criteria)
     VALUES ('00000000-0000-4000-8000-000000000001', $1, $2,
             'Staging demo Welcome Credential',
             '{"description": "Completed every required quest in the Staging demo Welcome Campaign."}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [projectIds['Staging demo Octra Builders'], userIds['staging-demo-user-1']]);

  // User history: users 1-3 complete the whole Welcome Campaign, feeding
  // both the global and the Octra Builders project points boards.
  const welcomeQuests = [q1, q2, q3];
  for (const uname of ['staging-demo-user-1', 'staging-demo-user-2', 'staging-demo-user-3']) {
    const uid = userIds[uname];
    for (const qid of welcomeQuests) await completeQuest(qid, uid, 100, seasonId);
    await pool.query(
      `INSERT INTO user_badges (user_id, badge_id, source_type, source_id)
       VALUES ($1, $2, 'quest', $3) ON CONFLICT (user_id, badge_id) DO NOTHING`,
      [uid, platformBadge, q3]
    );
  }
  // Uneven history so the project, campaign and quest boards all differ:
  // user 1 also completes both Growth Sprint quests; user 2 completes one;
  // user 4 completes one. User 1 is therefore the Octra project leader with
  // more XP than either campaign board alone.
  await completeQuest(qRefer, userIds['staging-demo-user-1'], 50, seasonId);
  await completeQuest(qVote, userIds['staging-demo-user-1'], 75, seasonId);
  await completeQuest(qRefer, userIds['staging-demo-user-2'], 50, seasonId);
  await completeQuest(qVote, userIds['staging-demo-user-4'], 75, seasonId);
  // Cross-project activity: users 1 and 2 also complete the Nebula AI board,
  // so project isolation is visible (user 1 is high on both projects, and
  // neither board's total leaks into the other).
  const devQuests = (await pool.query(
    `SELECT id FROM quests WHERE campaign_id = $1 AND status = 'active' ORDER BY sort_order`, [campDev])).rows;
  for (const uname of ['staging-demo-user-1', 'staging-demo-user-2']) {
    for (const row of devQuests) await completeQuest(row.id, userIds[uname], 100, seasonId);
  }
  // Membership roles so the permissions model has non-owner data: user 2 is
  // an admin on Octra Builders, user 3 a reviewer, user 4 an analyst.
  // The admin grant carries an explicit empty permissions map, so the
  // default-deny rule on delete_project is visible rather than implicit.
  const memberRoles = {
    'staging-demo-user-2': { role: 'admin', permissions: {} },
    'staging-demo-user-3': { role: 'reviewer', permissions: {} },
    'staging-demo-user-4': { role: 'analyst', permissions: {} },
  };
  for (const [uname, def] of Object.entries(memberRoles)) {
    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role, permissions) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [projectIds['Staging demo Octra Builders'], userIds[uname], def.role, JSON.stringify(def.permissions)]);
  }
  // User 4 has a pending submission (review queue non-empty).
  const u4 = userIds['staging-demo-user-4'];
  const qJoin = await pool.query(`SELECT id FROM quest_tasks WHERE quest_id = $1 AND type = 'social'`, [q2]);
  await pool.query(
    `INSERT INTO task_submissions (task_id, quest_id, user_id, proof_type, status)
     VALUES ($1, $2, $3, 'social', 'pending')`,
    [qJoin.rows[0].id, q2, u4]
  );
  // User 6 has a rejected submission with a reason.
  const u6 = userIds['staging-demo-user-6'];
  const qQuiz = await pool.query(`SELECT id FROM quest_tasks WHERE quest_id = $1 AND type = 'quiz'`, [q3]);
  await pool.query(
    `INSERT INTO task_submissions (task_id, quest_id, user_id, proof_type, proof_data, status, review_note, reviewed_at)
     VALUES ($1, $2, $3, 'quiz', $4, 'rejected', $5, NOW())`,
    [qQuiz.rows[0].id, q3, u6, JSON.stringify({ answers: [0, 1, 2] }), 'Score 33% (needs 80%). Retake the quiz to try again.']
  );
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, link)
     VALUES ($1, 'submission_rejected', 'Submission rejected', $2, $3)`,
    [u6, 'Your quiz score was below the pass threshold. You can retake it.', '/quest/' + q3]
  );

  // Referrals (Phase 2): one qualified (user 3 finished 3 quests via
  // user 1's invite, referrer paid once) and one still pending (user 5 has
  // not completed any quests yet).
  const refQualified = await pool.query(
    `INSERT INTO referrals (referrer_user_id, referee_user_id, code, status, qualified_at, rewarded_at)
     VALUES ($1, $2, 'demo-ref-1', 'qualified', NOW(), NOW())
     ON CONFLICT (referee_user_id) DO NOTHING RETURNING id`,
    [userIds['staging-demo-user-1'], userIds['staging-demo-user-3']]);
  if (refQualified.rows.length) {
    await pool.query(
      `INSERT INTO xp_events (user_id, amount, source_type, source_id, season_id)
       VALUES ($1, 100, 'referral', $2, $3) ON CONFLICT (source_type, source_id, user_id) DO NOTHING`,
      [userIds['staging-demo-user-1'], refQualified.rows[0].id, seasonId]);
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'referral_qualified', 'Invite qualified', $2)`,
      [userIds['staging-demo-user-1'], '@staging-demo-user-3 finished 3 quests. +100 XP.']);
  }
  await pool.query(
    `INSERT INTO referrals (referrer_user_id, referee_user_id, code, status)
     VALUES ($1, $2, 'demo-ref-2', 'pending')
     ON CONFLICT (referee_user_id) DO NOTHING`,
    [userIds['staging-demo-user-2'], userIds['staging-demo-user-5']]);

  // Reputation (Phase 3): itemized rows behind the profile panel. One
  // quest_completed event per completed quest, plus the qualified referral
  // credited to user 1. No risk signals here: the risk engine reads those,
  // so seeding them would fabricate a signal the app's own logic concludes.
  for (const uname of ['staging-demo-user-1', 'staging-demo-user-2', 'staging-demo-user-3']) {
    const uid = userIds[uname];
    for (const qid of welcomeQuests) {
      await pool.query(
        `INSERT INTO reputation_events (user_id, category, delta, source_type, source_id)
         VALUES ($1, 'quest_completed', 5, 'quest', $2) ON CONFLICT DO NOTHING`,
        [uid, qid]);
    }
  }
  if (refQualified.rows.length) {
    await pool.query(
      `INSERT INTO reputation_events (user_id, category, delta, source_type, source_id)
       VALUES ($1, 'referral_qualified', 10, 'referral', $2) ON CONFLICT DO NOTHING`,
      [userIds['staging-demo-user-1'], refQualified.rows[0].id]);
  }

  // Achievements (Phase 3): users 1-3 have completed quests, so their
  // 'first-quest' achievement is unlocked on the preview.
  await pool.query(
    `INSERT INTO user_achievements (user_id, achievement_id)
     SELECT u.id, a.id FROM users u
     JOIN achievements a ON a.key = 'first-quest'
     WHERE u.username IN ('staging-demo-user-1', 'staging-demo-user-2', 'staging-demo-user-3')
     ON CONFLICT DO NOTHING`);

  // Teams (Phase 3): one demo crew owned by user 1 with members 1-3.
  const team = await pool.query(
    `INSERT INTO teams (slug, name, tagline, owner_user_id, join_code)
     VALUES ('staging-demo-quest-crew', 'Staging demo Quest Crew', 'Staging demo team for testing the team board.',
             $1, 'demo-crew')
     ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [userIds['staging-demo-user-1']]);
  if (team.rows.length) {
    for (const uname of ['staging-demo-user-1', 'staging-demo-user-2', 'staging-demo-user-3']) {
      await pool.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (team_id, user_id) DO NOTHING`,
        [team.rows[0].id, userIds[uname], uname === 'staging-demo-user-1' ? 'owner' : 'member']);
    }
  }

  // Wallets (multi-chain link flow): fake, verified wallets per demo user so
  // the Profile Wallets panel has rows to show. Distinct per user and chain,
  // never a value any real account could hold.
  const demoWallets = [
    ['staging-demo-user-1', 'eip155', '0x000000000000000000000000000000000000d001', true],
    ['staging-demo-user-1', 'solana', 'StaGingDemoSoL111111111111111111111111111', false],
    ['staging-demo-user-1', 'sui', '0x000000000000000000000000000000000000000000000000000000000000d001', false],
    ['staging-demo-user-1', 'aptos', '0x000000000000000000000000000000000000000000000000000000000000d002', false],
    ['staging-demo-user-1', 'octra', 'oct1stagingdemo0000000000000000wallet', false],
    ['staging-demo-user-2', 'eip155', '0x000000000000000000000000000000000000d002', true],
    ['staging-demo-user-2', 'solana', 'StaGingDemoSoL222222222222222222222222222', false],
  ];
  for (const [uname, chain, address, primary] of demoWallets) {
    if (!userIds[uname]) continue;
    await pool.query(
      `INSERT INTO wallets (user_id, address, chain_namespace, verified_at, is_primary)
       VALUES ($1, $2, $3, NOW(), $4)
       ON CONFLICT (address, chain_namespace) DO NOTHING`,
      [userIds[uname], address, chain, primary]);
  }


  // ---- On-chain Simple Mode seed (Slice 1) ----
  // A project-scoped EVM testnet with a public, credential-free primary RPC
  // and one backup, plus an obviously fake ERC-20. The demo tasks are left to
  // fail honestly when a visitor runs them (a real zero balance, or an RPC that
  // answers but has never seen the submitted hash). History rows are seeded
  // only against a fake demo identity, never the visitor.
  const defiProject = projectIds['Staging demo Open DeFi'];
  const netRes = await pool.query(
    `INSERT INTO task_networks (project_id, chain_namespace, chain_id, name, native_symbol, native_decimals,
       explorer_url, explorer_tx_url, explorer_address_url, is_testnet, finality_model, address_format)
     VALUES ($1, 'eip155', 11155111, 'Staging demo Sepolia', 'ETH', 18,
       'https://sepolia.etherscan.io', 'https://sepolia.etherscan.io/tx/{tx}',
       'https://sepolia.etherscan.io/address/{address}', TRUE, 'n_confirmations', '0x-40-hex')
     ON CONFLICT (project_id, chain_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`, [defiProject]);
  const networkId = netRes.rows[0].id;
  await pool.query(
    `INSERT INTO task_rpcs (network_id, url, kind, priority, is_primary, timeout_ms, max_retries)
     SELECT $1, 'https://ethereum-sepolia-rpc.publicnode.com', 'https', 0, TRUE, 8000, 1
     WHERE NOT EXISTS (SELECT 1 FROM task_rpcs WHERE network_id = $1 AND is_primary)`, [networkId]);
  await pool.query(
    `INSERT INTO task_rpcs (network_id, url, kind, priority, is_primary, timeout_ms, max_retries)
     SELECT $1, 'https://rpc.sepolia.org', 'https', 1, FALSE, 8000, 1
     WHERE NOT EXISTS (SELECT 1 FROM task_rpcs WHERE network_id = $1 AND priority = 1)`, [networkId]);
  const tokRes = await pool.query(
    `INSERT INTO task_tokens (network_id, project_id, contract_address, token_type, symbol, name, decimals, metadata_source)
     VALUES ($1, $2, '0x0000000000000000000000000000000000d3m0', 'erc20', 'USDX', 'Staging demo USDX', 18, 'manual')
     ON CONFLICT (network_id, contract_address) DO UPDATE SET symbol = EXCLUDED.symbol
     RETURNING id`, [networkId, defiProject]);
  const tokenId = tokRes.rows[0].id;

  const campOnchain = await upsertCampaign(defiProject, 'Staging demo On-Chain Basics', {
    description: 'Staging demo campaign: Simple Mode on-chain checks (native balance and a transaction).',
    category: 'DeFi', status: 'active', featured: false, chains: ['eip155'],
    starts_at: new Date(Date.now() - 2 * 864e5), ends_at: new Date(Date.now() + 28 * 864e5),
  });
  const qNative = await upsertQuest(campOnchain, 'Staging demo Hold Sepolia ETH', {
    description: 'Staging demo quest: verify you hold at least 0.05 Sepolia ETH automatically.',
    xp: 60, points: 30, sort_order: 0, quest_type: 'Submission',
  }, [
    { type: 'on_chain', title: 'Hold at least 0.05 ETH', xp_reward: 60, config: {
      method: 'native_balance', network_id: networkId,
      requirement: { amount: '0.05', operator: 'gte' } } },
  ]);
  const qTx = await upsertQuest(campOnchain, 'Staging demo Make a Transaction', {
    description: 'Staging demo quest: submit a Sepolia transaction hash to have it verified automatically.',
    xp: 80, points: 40, sort_order: 1, quest_type: 'Submission',
  }, [
    { type: 'on_chain', title: 'Submit a confirmed transaction', xp_reward: 80, config: {
      method: 'transaction', network_id: networkId, confirmations: 1 } },
  ]);
  // A public task list row for the demo token balance, for the builder demo.
  await upsertQuest(campOnchain, 'Staging demo Hold USDX', {
    description: 'Staging demo quest: verify a token balance automatically.',
    xp: 50, points: 25, sort_order: 2, quest_type: 'Submission',
  }, [
    { type: 'on_chain', title: 'Hold at least 100 USDX', xp_reward: 50, config: {
      method: 'erc20_balance', network_id: networkId, token_id: tokenId,
      requirement: { amount: '100', operator: 'gte' } } },
  ]);

  // One history row against a fake identity so the dashboard has on-chain rows
  // without fabricating the answer a visitor's own Verify will compute.
  const netTask = (await pool.query(
    `SELECT id, current_version_id FROM quest_tasks WHERE quest_id = $1 ORDER BY sort_order LIMIT 1`, [qNative])).rows[0];
  if (netTask) {
    await pool.query(
      `INSERT INTO verification_attempts (task_id, task_version_id, user_id, wallet_address, chain_id, method,
         input, status, reason, evidence, latency_ms)
       VALUES ($1, $2, $3, '0x000000000000000000000000000000000000dEaD', 11155111, 'native_balance',
         '{"wallet_address":"0x000000000000000000000000000000000000dEaD"}'::jsonb, 'VERIFIED',
         'Balance is at least 0.05 ETH', '{"evidence":{"balance_base_units":"50000000000000000","decimals":18}}'::jsonb, 120)
       ON CONFLICT DO NOTHING`, [netTask.id, netTask.current_version_id, userIds['staging-demo-user-1']]);
    const demoKey = `user:${userIds['staging-demo-user-1']}:task:${netTask.id}:once`;
    await pool.query(
      `INSERT INTO task_completions (task_id, task_version_id, user_id, project_id, campaign_id, quest_id,
         wallet_address, chain_id, method, evidence, completion_period, idempotency_key, xp_awarded, status)
       VALUES ($1, $2, $3, $4, $5, $6, '0x000000000000000000000000000000000000dEaD', 11155111, 'native_balance',
         '{"balance_base_units":"50000000000000000"}'::jsonb, 'once', $7, 0, 'completed')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [netTask.id, netTask.current_version_id, userIds['staging-demo-user-1'], defiProject, campOnchain, qNative, demoKey]);
    // A backup RPC URL, so the failover path has a second endpoint. Idempotent
    // by the (network, priority) pair above; nothing else to do here.
  }

  console.log('[seed] staging demo data ready');
}

module.exports = { seed };
