# SelfLatitude Companion

A private, course-specific AI companion for students of **SelfLatitude Foundations**. Students sign in, chat with a Companion grounded in SelfLatitude's own instructions and course materials (via the OpenAI API), keep a private journal, and control what the Companion remembers. The owner manages instructions, starters, models, course files, users, and usage limits from an administration area without code changes.

Stack: **React + Vite** (client) · **Node.js + Express + TypeScript** (API) · **SQLite** (better-sqlite3, FTS5 + embeddings for course retrieval) · **OpenAI Responses API** · **Nginx** (TLS + reverse proxy) · Docker Compose for the server.

## What it does

**For students**
- A ChatGPT-style chat grounded in the Foundations course, with streaming replies, saved history, search, archive, rename, copy, stop and regenerate.
- Fast / Medium / Extended response depth, and a choice of the models the owner has approved.
- Structured memory across chats behind a per-conversation toggle. Nothing is remembered without explicit approval, and every memory can be edited or deleted.
- A private journal: monthly calendar, entry list, autosaving editor, download, and an optional "Discuss with Companion" that attaches one entry to a conversation.
- Temporary chats that are never saved and never touch memory.
- A monthly allowance with a visible meter, and the option to connect their own OpenAI key when it runs out.
- Profile with picture, name, sign-in email and password; plan and remaining credits; a Help page; and full export and deletion of their data.

**For the owner**
- Edit the Companion's name, description, instructions, safety rules, starters, models and course files, preview the draft in a test chat, publish it as a numbered version, and roll back.
- Manage plans, users, access, per-user usage overrides, temporary passwords and one-time sign-in links.
- Connect OpenAI, SMTP and JVZoo, and edit the five transactional email templates.
- See the payment log, the audit trail and the privacy-request queue.

All of it changes at runtime. Nothing in that list needs a developer or a redeployment.

```
selflatitude/
├── client/            React app (Vite). src/pages, src/components, src/api, src/styles/tokens.css
├── server/            Express API. src/routes, src/lib, src/db (schema.sql, migrate, seed)
├── deploy/            nginx.conf (docker) and nginx-bare-metal.conf
├── scripts/           backup.sh, restore.sh, keepalive.sh
├── docs/              API.md (endpoints), DEPLOY.md (server runbook), CPANEL.md (cPanel install)
├── app.js             entry point for cPanel's "Setup Node.js App"
├── docker-compose.yml, Dockerfile, .env.example
```

## Quick start (development)

Requirements: Node 20+ (22 recommended), npm 10+.

```bash
npm install
cp .env.example server/.env          # then edit: set OPENAI_API_KEY, BOOTSTRAP_ADMIN_EMAIL/PASSWORD
npm run dev                          # starts the API and the client together
```

The client prints its address when it starts; open that. Ports are configurable: `PORT` in
`server/.env` for the API, `server.port` in `client/vite.config.ts` for the client, and `API_PORT`
for the proxy between them. Set `APP_URL` to whatever address you open in the browser, since emailed
links and the allowed-origin check use it.

- The first Super Admin is created on startup from `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` (only if no Super Admin exists).
- Sign in as that user, go to **Settings → Two-step verification** and enable MFA. Super Admin tools (Users, Audit, Privacy requests) stay locked until MFA is enabled and verified.
- `npm run seed` additionally creates a demo student (`student@example.com` / `student-demo-pass`) with 12 months of Companion access.
- Public sign-up is off by default. Create accounts under **Administration → Users**, or turn sign-up on under **Administration → Sign-in policy**.
- With no SMTP configured, emails (password resets, sign-in codes, welcome messages) are printed to the server console in development.
- With no OpenAI key, everything works except generating replies and semantic search. Add it under **Administration → OpenAI connection** or set `OPENAI_API_KEY`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run API (tsx watch) and client (Vite) together |
| `npm run build` | Compile server to `server/dist` and client to `client/dist` |
| `npm start` | Run the compiled API (serves `client/dist` too) |
| `npm test` | Server unit + integration tests (vitest, in-memory SQLite) |
| `npm run migrate` | Apply `server/src/db/schema.sql` (idempotent; also runs on startup) |
| `npm run seed` | Create bootstrap admin + demo student |
| `npm run rotate-key -w server` | Re-seal stored secrets, optionally under a new `ENCRYPTION_KEY` |
| `npm run index-course -w server` | Rebuild the course search index (`-- --all` to redo indexed files) |
| `./scripts/backup.sh DIR` | Encrypted backup of DB + course files (`BACKUP_PASSPHRASE`) |
| `./scripts/restore.sh FILE` | Restore a backup (stops/starts the app) |

## How it fits together

**Companion request pipeline** (`server/src/lib/chat.ts`): confirm access → choose included usage or the student's confirmed key → load the *published* instructions + safety rules → recent messages + rolling summary → relevant approved memories (only if the chat's toggle is on) → top course passages (FTS5 + embedding similarity) → stream from OpenAI → save reply with sources, model, prompt version, and usage.

**Usage** (`server/src/lib/usage.ts`): monthly period anchored on the Companion activation date; up to N completed replies or $X measured cost (owner-editable, per-user overrides). A cost estimate is *reserved* inside a transaction before each sponsored request and reconciled after, so simultaneous requests cannot exceed the limit. Failed/stopped-before-output replies are released and never counted.

**Customer API keys** (`server/src/routes/usage.ts`): validated against OpenAI, encrypted with AES-256-GCM (`ENCRYPTION_KEY`), only the last 4 characters are ever shown. Saving a key does not switch to it; the student must explicitly *activate* it for the rest of the period. At reset the app returns to included usage unless "keep using" was chosen.

**Memory**: the model may propose at most one `<memory_suggestion>` per reply; it is stored as *pending* and hidden from the streamed text. Nothing is used in later chats until the student approves it. Temporary chats never use or create memory.

**Owner configuration** (`server/src/lib/companion.ts`): draft → preview (test chat against the draft, not metered) → publish as a numbered version → restore any previous version into a new draft. Each assistant reply records the prompt version used.

**Plans and payments**: plans (`server/src/lib/plans.ts`) define price, how many months of Companion access a purchase grants, and the included usage for students on that plan. JVZoo posts every sale to `POST /api/webhooks/jvzoo`; the request is verified with JVZoo's `cverify` signature, claimed atomically against a unique receipt so retries and simultaneous deliveries cannot double-grant, then the student is created or extended and emailed their sign-in details. A refund or chargeback reverses exactly the purchase it refers to: the months that purchase granted come off, course access is only withdrawn if that purchase granted it and no other purchase did, and the student's other purchases keep their time. Cancelling a subscription takes nothing back, since the current period is already paid for. Every notification is visible in the admin area with what it granted and whether it has been reversed.

**Profile and help**: students manage their picture, name, sign-in email and password on the Profile page, and see their plan and remaining credits there. Changing the email sends a code to the new address, so a typo cannot lock anyone out. The Help page shows the support address and safety notice that SelfLatitude sets in the admin area.

**Accounts**: public sign-up is off by default. Accounts come from a JVZoo sale or from the Super Admin, who sees the password once so it can be copied, and can email a welcome message or a password-setup link instead. Two-step verification is either an authenticator app or a 6-digit code emailed to the student, and it is enforced on every endpoint, not only the admin area. Administrators must pass it before the Super Admin sections open; that requirement can be switched off under **Administration → Sign-in policy** for local development only, and a live site always enforces it: a session with just a password gets `mfa_required` until the code is entered, and it cannot re-enrol or remove the second factor.

**Email**: SMTP is configured in the admin area (encrypted password, test button) and falls back to `SMTP_*` environment variables. The welcome, renewal, password-reset, sign-in-code and invite emails are editable templates with placeholders.

**Secrets at rest**: `ENCRYPTION_KEY` is stretched with scrypt and split into purpose-specific keys, then everything sensitive is sealed with AES-256-GCM under a fresh IV: students' own OpenAI keys, SelfLatitude's platform key, the SMTP password, the JVZoo secret, and authenticator secrets. Sealed values carry a version tag so `npm run rotate-key -w server` can re-seal them under a new key. Sign-in codes are keyed-hashed and bound to the user and purpose, so a copy of the database cannot reveal a six-digit code by guessing all million of them. Session and link tokens are keyed with `SESSION_SECRET`, so a stolen database cannot be turned into a working cookie. In production the app refuses to start if either secret is weak.

**Privacy**: students export (JSON/Markdown), delete records, submit GDPR requests, and delete their account. Admin screens only ever show counts, never conversation, memory, or journal content. Admin actions are recorded in `audit_log`. Request logging strips ids and never logs bodies.

## Configuration

See `.env.example` for every variable. Editable at runtime in the admin area, with no deployment needed:

| Area | What the owner controls |
|---|---|
| Companion | Name, description, instructions, safety rules, starters, models (including pulling the live model list from OpenAI), depth presets, course files, draft/preview/publish/restore |
| OpenAI connection | SelfLatitude's platform API key (encrypted) |
| Plans | Price, duration, course entitlement, included replies and cost ceiling per plan |
| Usage limits | Global reply and cost limits, warning thresholds, retrieval and memory settings |
| Users | Create, edit, suspend, grant or renew access, per-user usage overrides, temporary passwords, one-time links |
| JVZoo & payments | Secret key, product-to-plan mapping, refund behaviour, and the full notification log |
| Email | SMTP server, test send, and the five email templates |
| Sign-in policy | Public sign-up on/off, emailed sign-in codes, admin MFA requirement |

## Testing

```bash
npm test
```

Covers cryptography (sealed-value round trip, the older format still opening, tampering rejected, keyed code hashes, unbiased generation), the guarantee that no secret is written to any table in the clear or returned by any endpoint, session invalidation on password change, per-account sign-in throttling, cross-site request blocking, login, closed sign-up, access control, MFA gating (authenticator and emailed codes, including expiry and single use), one-time links, monthly usage limits and plan-based limits, API-key secrecy (encrypted at rest, absent from exports and admin screens), memory approval, journal privacy, account deletion, and the JVZoo webhook (signature check, account creation, extension, refund, duplicate and concurrent delivery), plus unit tests for period maths, crypto, chunking, and HTML sanitising.

## Deployment

| Where | Guide |
|---|---|
| Your own server or a VPS (recommended) | [docs/DEPLOY.md](docs/DEPLOY.md) — Docker Compose + Nginx, TLS, backups, updates, restore test |
| Shared hosting with cPanel | [docs/CPANEL.md](docs/CPANEL.md) — needs *Setup Node.js App*, or SSH with a cron keepalive |

This is a long-running Node process with its own SQLite database, not a PHP app. On cPanel that
means the **Setup Node.js App** feature has to be available; the guide covers what to do when it is
not.

## Documentation

- [docs/API.md](docs/API.md) — every endpoint, request and response shape, and error code
- [docs/DEPLOY.md](docs/DEPLOY.md) — production runbook
- [docs/CPANEL.md](docs/CPANEL.md) — installing on cPanel
- [CLAUDE.md](CLAUDE.md) — conventions and invariants to keep in mind when changing the code

## Out of scope for the MVP

Native apps, community features, LMS/video hosting, voice, clinician dashboards, fine-tuning or self-hosted models, notifications based on inferred emotional state, gamification. Payments are handled by JVZoo: the app receives sales through the IPN webhook rather than hosting its own checkout.

## Ownership

Built for SelfLatitude. The repository, the domain, the server, the database, the OpenAI project and
all administrator credentials belong to SelfLatitude.

The Companion is an educational and personal-development tool. It is not therapy, medical care,
diagnosis, or an emergency service, and the published instructions and safety rules say so.
