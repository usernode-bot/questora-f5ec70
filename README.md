# Questora

A Web3 quest, campaign and community engagement platform built on Homeroom.

Projects create campaigns and quests. Users complete quest checklists, get
verified server-side, and earn XP, points, badges and leaderboard position.

## What works

- **Discover** featured, trending, new and ending-soon campaigns by category
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
- **Leaderboard** by XP or points
- **Creator wizard** at `/create`: project, campaign, first quest
- **Project dashboard**: participants, review queue (approve/reject with
  required reason), analytics
- **Notifications** with per-category preferences
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

Unit tests cover the verifier registry, level curve and helpers. The
integration test boots the real migration + staging seed block against the
scratch database and proves reward idempotency and private-table marking.
