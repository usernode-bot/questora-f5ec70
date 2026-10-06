# Questora

A Web3 quest, campaign and community engagement platform built on Homeroom.

Projects create campaigns and quests. Users complete quest checklists, get
verified server-side, and earn XP, points, badges and leaderboard position.

## What works

- **Discover** featured, trending, new and ending-soon campaigns by category.
  The Explore screen (`/`) lists each project at most once across the whole
  page: `GET /api/v1/discover` fills Featured, Trending, New and Ending soon
  in order and skips any project already shown in an earlier section, so a
  project with several active campaigns no longer repeats three or more times.
- **Campaigns** group ordered quests with a progress checklist
- **Five task types**: connect wallet (signature-verified), social link
  (visit and confirm), URL/proof submission, quiz (server-graded), manual
  review
- **Server-side verification**: quiz answers never reach the browser, wallet
  ownership is proven by `personal_sign` message recovery, everything else
  lands in a human review queue
- **Idempotent rewards**: XP, points and badges are awarded in one database
  transaction with UNIQUE constraints, so retries can never double-pay
- **Levels** from admin-editable thresholds (never hardcoded)
- **Profiles** at `/u/{username}` with badges, activity and rank
- **Leaderboards** scoped to a project, campaign or quest
- **Creator wizard** at `/create`: project, campaign, first quest
- **Project dashboard**: participants, review queue (approve/reject with
  required reason), analytics
- **Notifications** with per-category preferences
- **Public credential pages** at `/credentials/{id}`: verifiable achievement
  cards (issuer, recipient, criteria, expiry) reachable without signing in
- **Project points systems**: each project has its own points ledger and
  leaderboard (on the project page's Points tab), separate from global XP
- **Referrals**: share `/join?ref={code}` from the profile invite card;
  the referee qualifies by completing quests (checked server-side, count
  configurable by admins) and the referrer is paid XP exactly once
- **Full-text search** at `/search` across people, projects, campaigns
  and quests
- **Admin** section: users, roles, campaign pause/archive, global review
  queue, level thresholds, audit log (who, what, when, before, after)

## Architecture

- Node.js + Express, vanilla JS frontend, precompiled Tailwind CSS
- Postgres schema applied idempotently on boot (`src/db.js`)
- Sensitive tables (`task_submissions`, `verification_events`,
  `wallet_challenges`, `social_accounts`, `reward_claims`, `audit_logs`)
  are marked `staging:private`
- Staging boot seeds idempotent, obviously fake demo data
  (`staging-demo-*` users, projects, campaigns, quests, badges)
- Auth uses the platform-issued RS256 iframe JWT only, pinned to
  algorithm, issuer and audience

## Environment

All platform vars (`DATABASE_URL`, `USERNODE_JWT_PUBLIC_KEY`,
`USERNODE_APP_ID`, `PORT`, `USERNODE_ENV`) are injected by Homeroom.
The app declares one secret in `dapp.json`:

- `ADMIN_USERNAMES` (required, private): comma-separated usernames that
  get the admin section. Staging default: `staging-demo-admin`.

## Development

```bash
npm install
npm run build:css
DATABASE_URL=postgres://... USERNODE_ENV=staging node server.js
```

## Tests

```bash
DATABASE_URL=postgres://... USERNODE_ENV=staging npm test
```

Unit tests cover the verifier registry, level curve, helpers and referral
rule defaults. The integration test boots the real migration + staging seed
block against the scratch database and proves reward idempotency, private
table marking, credential issuance and the referral claim/qualify flow.
