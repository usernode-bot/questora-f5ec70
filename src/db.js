const { Pool } = require('pg');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PRIVATE_TABLES = [
  'wallet_challenges',
  'social_accounts',
  'task_submissions',
  'verification_events',
  'reward_claims',
  'audit_logs',
  'risk_signals',
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  usernode_id BIGINT UNIQUE,
  username VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  avatar_url TEXT,
  role VARCHAR(20) NOT NULL DEFAULT 'user',
  risk_state VARCHAR(20) NOT NULL DEFAULT 'normal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (username);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notify JSONB NOT NULL DEFAULT '{}',
  theme VARCHAR(10) NOT NULL DEFAULT 'dark',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address VARCHAR(128) NOT NULL,
  chain_namespace VARCHAR(32) NOT NULL DEFAULT 'eip155',
  public_key TEXT,
  verified_at TIMESTAMPTZ,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (address, chain_namespace)
);
CREATE INDEX IF NOT EXISTS wallets_user_idx ON wallets (user_id);

CREATE TABLE IF NOT EXISTS wallet_challenges (
  id SERIAL PRIMARY KEY,
  nonce VARCHAR(128) UNIQUE NOT NULL,
  wallet_address VARCHAR(128) NOT NULL,
  chain_namespace VARCHAR(32) NOT NULL DEFAULT 'eip155',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS social_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  handle VARCHAR(255),
  verified_at TIMESTAMPTZ,
  oauth_tokens JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(100) UNIQUE NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  logo_url TEXT,
  banner_url TEXT,
  website TEXT,
  social_links JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'owner',
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  banner_url TEXT,
  category VARCHAR(40),
  chains TEXT[] NOT NULL DEFAULT '{}',
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  xp_multiplier NUMERIC(6,2) NOT NULL DEFAULT 1.0,
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  visibility VARCHAR(20) NOT NULL DEFAULT 'public',
  rules TEXT,
  leaderboard_config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, slug)
);
CREATE INDEX IF NOT EXISTS campaigns_status_ends_idx ON campaigns (status, ends_at);

CREATE TABLE IF NOT EXISTS quests (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  slug VARCHAR(100),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  instructions TEXT,
  image_url TEXT,
  quest_type VARCHAR(40),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_required BOOLEAN NOT NULL DEFAULT TRUE,
  xp_reward INTEGER NOT NULL DEFAULT 0,
  points_reward INTEGER NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  visibility VARCHAR(20) NOT NULL DEFAULT 'public',
  max_participants INTEGER,
  completion_limit INTEGER NOT NULL DEFAULT 1,
  max_completions INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS quests_campaign_status_idx ON quests (campaign_id, status);

CREATE TABLE IF NOT EXISTS quest_tasks (
  id SERIAL PRIMARY KEY,
  quest_id INTEGER NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL,
  title VARCHAR(255) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  verification_type VARCHAR(30),
  proof_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS quest_tasks_quest_idx ON quest_tasks (quest_id, sort_order);

CREATE TABLE IF NOT EXISTS quest_conditions (
  id SERIAL PRIMARY KEY,
  quest_id INTEGER NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  operator VARCHAR(20) NOT NULL DEFAULT 'all',
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quest_completions (
  id SERIAL PRIMARY KEY,
  quest_id INTEGER NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'completed',
  xp_awarded INTEGER NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (quest_id, user_id)
);
CREATE INDEX IF NOT EXISTS quest_completions_user_idx ON quest_completions (user_id);

CREATE TABLE IF NOT EXISTS task_submissions (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES quest_tasks(id) ON DELETE CASCADE,
  quest_id INTEGER NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proof_type VARCHAR(30),
  proof_url TEXT,
  proof_data JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewer_id INTEGER REFERENCES users(id),
  review_note TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS task_submissions_status_quest_idx ON task_submissions (status, quest_id);
CREATE INDEX IF NOT EXISTS task_submissions_user_task_idx ON task_submissions (user_id, task_id);

CREATE TABLE IF NOT EXISTS verification_events (
  id SERIAL PRIMARY KEY,
  submission_id BIGINT,
  verifier VARCHAR(40) NOT NULL,
  result VARCHAR(20) NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS xp_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  source_type VARCHAR(40) NOT NULL,
  source_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_type, source_id, user_id)
);
CREATE INDEX IF NOT EXISTS xp_events_user_idx ON xp_events (user_id);

CREATE TABLE IF NOT EXISTS points_systems (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  key VARCHAR(60) NOT NULL,
  name VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, key)
);

CREATE TABLE IF NOT EXISTS points_events (
  id SERIAL PRIMARY KEY,
  system_id INTEGER NOT NULL REFERENCES points_systems(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  source_type VARCHAR(40) NOT NULL,
  source_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_type, source_id, user_id, system_id)
);
CREATE INDEX IF NOT EXISTS points_events_system_user_idx ON points_events (system_id, user_id);

CREATE TABLE IF NOT EXISTS level_thresholds (
  level INTEGER PRIMARY KEY,
  min_xp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key VARCHAR(60) PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS badges (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  key VARCHAR(60) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  icon TEXT,
  rarity VARCHAR(20) NOT NULL DEFAULT 'common',
  criteria JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, key)
);

CREATE TABLE IF NOT EXISTS user_badges (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_type VARCHAR(40),
  source_id INTEGER,
  PRIMARY KEY (user_id, badge_id)
);

CREATE TABLE IF NOT EXISTS rewards (
  id SERIAL PRIMARY KEY,
  quest_id INTEGER REFERENCES quests(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  supply_cap INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'available',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reward_claims (
  id SERIAL PRIMARY KEY,
  reward_id INTEGER NOT NULL REFERENCES rewards(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'available',
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reward_id, user_id)
);

CREATE TABLE IF NOT EXISTS credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  recipient_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  criteria JSONB NOT NULL DEFAULT '{}',
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY,
  referrer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  referee_user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  code VARCHAR(60),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  qualified_at TIMESTAMPTZ,
  rewarded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(40) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT,
  link TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_user_read_idx ON notifications (user_id, read_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id INTEGER,
  before JSONB,
  after JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

-- Phase 3: reputation is a transparent sum of per-signal deltas; the table
-- is the record, the profile panel reads the itemized rows. source_id
-- defaults to 0 (not NULL) so the UNIQUE constraint dedupes every category.
CREATE TABLE IF NOT EXISTS reputation_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category VARCHAR(40) NOT NULL,
  delta INTEGER NOT NULL,
  source_type VARCHAR(40) NOT NULL DEFAULT '',
  source_id INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (category, source_type, source_id, user_id)
);
CREATE INDEX IF NOT EXISTS reputation_events_user_idx ON reputation_events (user_id, category);

-- Phase 3: anti-sybil engine. One explainer row per (user, signal, key);
-- the combined severity escalates users.risk_state. Private: it is fraud
-- analysis about a specific account.
CREATE TABLE IF NOT EXISTS risk_signals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal VARCHAR(40) NOT NULL,
  signal_key VARCHAR(80) NOT NULL DEFAULT '',
  severity INTEGER NOT NULL DEFAULT 0,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, signal, signal_key)
);
CREATE INDEX IF NOT EXISTS risk_signals_user_idx ON risk_signals (user_id);

-- Phase 3: seasons. XP awarded while a season is active is stamped with
-- season_id so seasonal leaderboards are a plain filter on xp_events.
CREATE TABLE IF NOT EXISTS seasons (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(80) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  xp_multiplier NUMERIC(6,2) NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS achievements (
  id SERIAL PRIMARY KEY,
  key VARCHAR(60) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  criteria JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_achievements (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id INTEGER NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_type VARCHAR(40),
  source_id INTEGER,
  PRIMARY KEY (user_id, achievement_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(80) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  tagline TEXT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  join_code VARCHAR(12) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS teams_owner_idx ON teams (owner_user_id);

CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
    // Phase 2: stable per-user referral code for /join?ref= links.
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_code VARCHAR(20) UNIQUE');
    // Multi-chain wallets: Sui/Aptos addresses are 0x + 64 hex (66 chars), so
    // the address columns must hold more than 64; and Ed25519 chains need the
    // signer's public key stored to verify later.
    await client.query('ALTER TABLE wallets ALTER COLUMN address TYPE VARCHAR(128)');
    await client.query('ALTER TABLE wallets ADD COLUMN IF NOT EXISTS public_key TEXT');
    await client.query('ALTER TABLE wallet_challenges ALTER COLUMN wallet_address TYPE VARCHAR(128)');
    await client.query("ALTER TABLE wallet_challenges ADD COLUMN IF NOT EXISTS chain_namespace VARCHAR(32) NOT NULL DEFAULT 'eip155'");
    // Phase 3: seasonal XP ledger stamps and normalized proof fingerprints.
    await client.query('ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS season_id INTEGER REFERENCES seasons(id)');
    await client.query('ALTER TABLE task_submissions ADD COLUMN IF NOT EXISTS proof_hash VARCHAR(64)');
    // Multi-project restructure: explicit scope on every reward record so a
    // leaderboard is a scoped sum, never a mix of projects. Nullable because
    // referral / season XP belongs to no project.
    await client.query('ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL');
    await client.query('ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL');
    await client.query('ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS quest_id INTEGER REFERENCES quests(id) ON DELETE SET NULL');
    await client.query('ALTER TABLE points_events ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL');
    await client.query('ALTER TABLE points_events ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL');
    await client.query('ALTER TABLE points_events ADD COLUMN IF NOT EXISTS quest_id INTEGER REFERENCES quests(id) ON DELETE SET NULL');
    // Project Ownership: visibility + soft-delete state, and a per-member
    // permission override map so a grant can extend (or withhold) a role's
    // default abilities without inventing a new role.
    await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS banner_url TEXT');
    await client.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'public'");
    await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
    await client.query("ALTER TABLE project_members ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'");
    await client.query('CREATE INDEX IF NOT EXISTS projects_status_idx ON projects (status, deleted_at)');
    // Campaign / quest fields the multi-project spec adds.
    await client.query("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'public'");
    await client.query('ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS rules TEXT');
    await client.query("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS leaderboard_config JSONB NOT NULL DEFAULT '{}'");
    await client.query('ALTER TABLE quests ADD COLUMN IF NOT EXISTS slug VARCHAR(100)');
    await client.query('ALTER TABLE quests ADD COLUMN IF NOT EXISTS image_url TEXT');
    await client.query('ALTER TABLE quests ADD COLUMN IF NOT EXISTS quest_type VARCHAR(40)');
    await client.query('ALTER TABLE quests ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ');
    await client.query('ALTER TABLE quests ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ');
    await client.query("ALTER TABLE quests ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'public'");
    await client.query('ALTER TABLE quests ADD COLUMN IF NOT EXISTS max_participants INTEGER');
    await client.query('ALTER TABLE quests ADD COLUMN IF NOT EXISTS completion_limit INTEGER NOT NULL DEFAULT 1');
    await client.query('ALTER TABLE quest_completions ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL');
    await client.query('ALTER TABLE quest_completions ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL');
    await client.query('CREATE INDEX IF NOT EXISTS quest_completions_project_user_idx ON quest_completions (project_id, user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS quest_completions_campaign_user_idx ON quest_completions (campaign_id, user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS xp_events_project_user_idx ON xp_events (project_id, user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS xp_events_campaign_user_idx ON xp_events (campaign_id, user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS xp_events_quest_user_idx ON xp_events (quest_id, user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS points_events_project_user_idx ON points_events (project_id, user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS points_events_campaign_user_idx ON points_events (campaign_id, user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS points_events_quest_user_idx ON points_events (quest_id, user_id)');
    // Every project needs somewhere for points to land, even one created
    // before the points system existed. Idempotent, and a no-op in production
    // where the rows already exist.
    await client.query(`
      INSERT INTO points_systems (project_id, key, name)
      SELECT p.id, 'default', p.name FROM projects p
      WHERE NOT EXISTS (SELECT 1 FROM points_systems ps WHERE ps.project_id = p.id)`);
    // Backfill scope on pre-existing completions so a project/campaign board
    // can be told apart from the quest it was earned in.
    await client.query(`
      UPDATE quest_completions qc SET
        campaign_id = q.campaign_id,
        project_id = c.project_id
      FROM quests q JOIN campaigns c ON c.id = q.campaign_id
      WHERE qc.quest_id = q.id AND qc.project_id IS NULL`);
    // Status vocabulary: a running campaign is 'active', a live quest is
    // 'active' too (they were 'live' / 'published').
    await client.query("UPDATE campaigns SET status = 'active' WHERE status = 'live'");
    await client.query("UPDATE quests SET status = 'active' WHERE status = 'published'");
    // Backfill scope on pre-existing quest reward rows (one-time, idempotent).
    await client.query(`
      UPDATE xp_events e SET
        quest_id = e.source_id,
        campaign_id = q.campaign_id,
        project_id = c.project_id
      FROM quests q JOIN campaigns c ON c.id = q.campaign_id
      WHERE e.source_type = 'quest' AND e.quest_id IS NULL AND q.id = e.source_id`);
    await client.query(`
      UPDATE points_events e SET
        quest_id = e.source_id,
        campaign_id = q.campaign_id,
        project_id = c.project_id
      FROM quests q JOIN campaigns c ON c.id = q.campaign_id
      WHERE e.source_type = 'quest' AND e.quest_id IS NULL AND q.id = e.source_id`);
    // Quest slugs, backfilled from titles (only where still null).
    await client.query(`
      UPDATE quests SET slug = trim(both '-' from regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g'))
      WHERE slug IS NULL`);
    await client.query(`UPDATE quests SET slug = 'quest-' || id WHERE slug IS NULL OR slug = ''`);
    // Same title twice in one campaign would break the unique index below;
    // disambiguate duplicates with the row id.
    await client.query(`
      UPDATE quests q SET slug = q.slug || '-' || q.id
      FROM (
        SELECT id, row_number() OVER (PARTITION BY campaign_id, slug ORDER BY id) AS rn
        FROM quests
      ) d
      WHERE d.id = q.id AND d.rn > 1`);
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS quests_campaign_slug_key ON quests (campaign_id, slug)');
    // Fresh schemas lack gen_random_uuid (pgcrypto) on older servers.
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto').catch(() => {});
    for (const t of PRIVATE_TABLES) {
      await client.query(`COMMENT ON TABLE ${t} IS 'staging:private'`);
    }
    // The starter template's demo table is gone with the template.
    await client.query('DROP TABLE IF EXISTS presses');
    await client.query(`
      INSERT INTO level_thresholds (level, min_xp) VALUES (1, 0), (2, 1000), (3, 2500), (4, 5000), (5, 10000)
      ON CONFLICT (level) DO NOTHING
    `);
    await client.query(`
      INSERT INTO platform_settings (key, value) VALUES ('xp', '{"daily_cap": 5000, "multiplier": 1}'::jsonb)
      ON CONFLICT (key) DO NOTHING
    `);
    // Phase 3: the achievement catalogue is platform content, not staging
    // demo data, so it seeds in every environment.
    await client.query(`
      INSERT INTO achievements (key, name, description, criteria) VALUES
        ('first-quest', 'First Quest', 'Complete your first quest.',
          '{"metric": "quests_completed", "value": 1}'::jsonb),
        ('quest-machine', 'Quest Machine', 'Complete 10 quests.',
          '{"metric": "quests_completed", "value": 10}'::jsonb),
        ('xp-collector', 'XP Collector', 'Earn 1,000 XP.',
          '{"metric": "xp_earned", "value": 1000}'::jsonb),
        ('badge-collector', 'Badge Collector', 'Earn 5 badges.',
          '{"metric": "badges_earned", "value": 5}'::jsonb),
        ('community-connector', 'Community Connector', 'Have one invite qualify.',
          '{"metric": "referrals_qualified", "value": 1}'::jsonb)
      ON CONFLICT (key) DO NOTHING
    `);
    // Season 1 is the standing default season in every environment; admins
    // create later seasons from the admin panel.
    await client.query(`
      INSERT INTO seasons (slug, name, starts_at, ends_at, xp_multiplier)
      VALUES ('season-1', 'Season 1', date_trunc('hour', now()) - interval '7 days',
              date_trunc('hour', now()) + interval '83 days', 1.0)
      ON CONFLICT (slug) DO NOTHING
    `);
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate, IS_STAGING, PRIVATE_TABLES };
