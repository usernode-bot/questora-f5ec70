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
                            starts_at, ends_at, status, featured, xp_multiplier)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (project_id, slug) DO UPDATE SET status = EXCLUDED.status, description = EXCLUDED.description
     RETURNING id`,
    [projectId, slug, name, extra.description, extra.banner_url, extra.category, extra.chains || [],
      extra.starts_at, extra.ends_at, extra.status, !!extra.featured, extra.xp_multiplier || 1]
  );
  return rows[0].id;
}

async function upsertQuest(campaignId, title, extra, tasks) {
  // Idempotency guard: seeded quests are found by campaign + title.
  const existing = await pool.query(
    'SELECT id FROM quests WHERE campaign_id = $1 AND title = $2 ORDER BY id LIMIT 1',
    [campaignId, title]
  );
  if (existing.rows.length) return existing.rows[0].id;
  const { rows } = await pool.query(
    `INSERT INTO quests (campaign_id, title, description, sort_order, is_required, xp_reward, points_reward, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'published')
     RETURNING id`,
    [campaignId, title, extra.description || null, extra.sort_order || 0,
      extra.is_required !== false, extra.xp || 0, extra.points || 0]
  );
  const questId = rows[0].id;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    await pool.query(
      `INSERT INTO quest_tasks (quest_id, type, title, config, sort_order, verification_type, proof_required)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [questId, t.type, t.title, JSON.stringify(t.config || {}), i,
        ['quiz', 'wallet_connect'].includes(t.type) ? 'automatic' : 'manual',
        ['url_proof', 'manual', 'social'].includes(t.type)]
    );
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

async function completeQuest(questId, userId, xp) {
  await pool.query(
    `INSERT INTO quest_completions (quest_id, user_id, status, xp_awarded)
     VALUES ($1, $2, 'completed', $3) ON CONFLICT (quest_id, user_id) DO NOTHING`,
    [questId, userId, xp]
  );
  await pool.query(
    `INSERT INTO xp_events (user_id, amount, source_type, source_id)
     VALUES ($1, $2, 'quest', $3) ON CONFLICT (source_type, source_id, user_id) DO NOTHING`,
    [userId, xp, questId]
  );
  await pool.query(
    `INSERT INTO points_events (system_id, user_id, amount, source_type, source_id)
     SELECT ps.id, $1, $2, 'quest', $3 FROM points_systems ps WHERE ps.key = 'global'
     ON CONFLICT (source_type, source_id, user_id, system_id) DO NOTHING`,
    [userId, Math.round(xp / 2), questId]
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
  ];
  const userIds = {};
  for (const u of USERS) userIds[u.username] = await upsertUser(u.username, u.display_name);
  const projectIds = {};
  for (const p of projectDefs) {
    projectIds[p.name] = await upsertProject(
      userIds[`staging-demo-user-${p.user}`], p.name,
      { description: p.description, logo_url: p.logo_url, website: p.website });
  }

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
    category: 'Community', status: 'live', featured: true,
    starts_at: new Date(Date.now() - 7 * 864e5), ends_at: new Date(Date.now() + 21 * 864e5),
  });
  const campDev = await upsertCampaign(projectIds['Staging demo Nebula AI'], 'Staging demo Developer Journey', {
    description: 'Staging demo campaign: developer quests and contributions.',
    category: 'Developer', status: 'live', featured: true,
    starts_at: new Date(Date.now() - 3 * 864e5), ends_at: new Date(Date.now() + 30 * 864e5),
  });
  const campExplore = await upsertCampaign(projectIds['Staging demo Nova Gaming'], 'Staging demo Community Explorer', {
    description: 'Staging demo campaign: explore the community.',
    category: 'Social', status: 'live',
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

  // User history: users 1-3 complete the whole Welcome Campaign.
  const welcomeQuests = [q1, q2, q3];
  for (const uname of ['staging-demo-user-1', 'staging-demo-user-2', 'staging-demo-user-3']) {
    const uid = userIds[uname];
    for (const qid of welcomeQuests) await completeQuest(qid, uid, 100);
    await pool.query(
      `INSERT INTO user_badges (user_id, badge_id, source_type, source_id)
       VALUES ($1, $2, 'quest', $3) ON CONFLICT (user_id, badge_id) DO NOTHING`,
      [uid, platformBadge, q3]
    );
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

  console.log('[seed] staging demo data ready');
}

module.exports = { seed };
