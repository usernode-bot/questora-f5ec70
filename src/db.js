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
  address VARCHAR(64) NOT NULL,
  chain_namespace VARCHAR(32) NOT NULL DEFAULT 'eip155',
  verified_at TIMESTAMPTZ,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (address, chain_namespace)
);
CREATE INDEX IF NOT EXISTS wallets_user_idx ON wallets (user_id);

CREATE TABLE IF NOT EXISTS wallet_challenges (
  id SERIAL PRIMARY KEY,
  nonce VARCHAR(128) UNIQUE NOT NULL,
  wallet_address VARCHAR(64) NOT NULL,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, slug)
);
CREATE INDEX IF NOT EXISTS campaigns_status_ends_idx ON campaigns (status, ends_at);

CREATE TABLE IF NOT EXISTS quests (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  instructions TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_required BOOLEAN NOT NULL DEFAULT TRUE,
  xp_reward INTEGER NOT NULL DEFAULT 0,
  points_reward INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'published',
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
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
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
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate, IS_STAGING, PRIVATE_TABLES };
