# SelfLatitude Companion - working notes

- Monorepo (npm workspaces): `server/` Express + TypeScript + better-sqlite3, `client/` React + Vite. See README.md for setup and docs/API.md for the endpoint contract. Update docs/API.md whenever a route or response shape changes.
- Run: `npm run dev`. On this machine the API is on :5111 (`PORT` in `server/.env`) and the client on :5177 (`client/vite.config.ts`), because 4000 and 5173 are taken by other apps. The Vite proxy reads `API_PORT`, defaulting to 5111 - keep it in step with `PORT`. Tests: `npm test` (server vitest, in-memory SQLite). Type-check client: `cd client && npx tsc --noEmit -p tsconfig.json`.
- `APP_URL` in `server/.env` must be the client's address (:5177), not the API's: it is used for emailed links and for the allowed-origin check. In development any localhost port is accepted anyway.
- Design tokens live in `client/src/styles/tokens.css` (from the SelfLatitude style guide). Use the `--sl-*` variables and the classes in `base.css`; do not scatter hex values.
- Security invariants: customer OpenAI keys are AES-256-GCM encrypted and only `last4` is ever returned; admin endpoints return counts, never conversation/memory/journal content; important admin actions go through `audit()`; never log request bodies.
- Usage rules: reservations happen inside a transaction (`reserveIncluded`); failed replies must call `releaseUsage`; `assertCanSend` runs before the student's message is saved.
- Companion config is versioned: edit the draft, preview, publish; `getPublished()` is the only source used for student chats.
