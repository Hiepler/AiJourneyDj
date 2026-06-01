# Coolify Deployment (single container) — Design

**Date:** 2026-06-01
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** Root (Dockerfile, .dockerignore, docs), `apps/api` (serve the built SPA). No behavior changes to features.

## Goal

Package the app as a single Docker image deployable on Coolify at `https://aijourneydj.ruhrco.de`,
where the Fastify API also serves the built web SPA (same origin) and SQLite lives on a persistent
volume. This unblocks Tesla Fleet onboarding (public key + OAuth need a real reachable HTTPS domain).

## Decisions

- **Single container** (Approach A): one image, one origin, one domain → no CORS, OAuth/Spotify
  same-origin, and the one domain Tesla needs for the public key.
- **Runtime via `tsx`**, not a compiled bundle: workspace packages export TS source
  (`exports: "./src/index.ts"`), so `tsx apps/api/src/index.ts` (same as dev) reliably resolves them
  and `node:sqlite`; a tsup/externalization build would be fragile.
- **Node 24-slim** base image (`node:sqlite` runs unflagged; engines require ≥22.13).
- The API serves `apps/web/dist`; registration is **guarded on the dist dir existing** so tests and
  local dev are unaffected.

## Section 1 — Dockerfile + .dockerignore

Multi-stage-ish single Dockerfile (`Dockerfile` at repo root):
1. `FROM node:24-bookworm-slim`, `WORKDIR /app`.
2. Copy `package.json`, `package-lock.json`, and the workspace `package.json` files; `npm ci`.
3. Copy the rest of the repo.
4. `npm run build -w @ai-journey-dj/web` → produces `apps/web/dist`.
5. `ENV NODE_ENV=production`, `EXPOSE 3000`.
6. `CMD ["npm","run","start:prod"]` where root `start:prod` = `tsx apps/api/src/index.ts`
   (add this script; `tsx` is already an `apps/api` dependency). Keep dev deps installed (tsx, vite)
   — acceptable for a single-user app; image stays simple.

`.dockerignore`: `node_modules`, `apps/*/dist`, `**/*.test.ts`, `e2e`, `docs`, `.git`, `data`,
`*.db*`, editor/OS cruft — keep the build context lean and avoid copying local SQLite.

## Section 2 — API serves the SPA (`apps/api`)

- Add dependency `@fastify/static` to `apps/api`.
- In `buildApp`, after routes are registered, compute `webDist` from `import.meta.url`
  (`apps/api/src` → `../../web/dist`), overridable by `WEB_DIST_DIR`. If `existsSync(webDist)`:
  - `app.register(@fastify/static, { root: webDist, wildcard: false })`.
  - `app.setNotFoundHandler(...)`: for `GET` requests whose path is not an API route and does not
    look like a file, send `index.html` (SPA fallback); otherwise return the normal 404. API route
    prefixes (`/health`, `/auth`, `/journeys`, `/spotify`, `/internal`, `/.well-known`, `/auth/...`)
    are already registered and keep precedence.
- Guarded by `existsSync` → in tests/dev (no `apps/web/dist`) it is a no-op; the existing CORS config
  still covers the dev two-origin setup.

## Section 3 — Persistence & runtime config

- SQLite on a mounted volume: `DATABASE_PATH=/data/ai-journey-dj.db` (Coolify Persistent Storage →
  container path `/data`). `loadConfig` already `mkdirSync`s the dir.
- API binds `API_HOST=0.0.0.0`, `API_PORT=3000`. Healthcheck: `GET /health`.
- Production env (`.env.example` already has the template) with the real domain in `API_BASE_URL`,
  `APP_BASE_URL`, `CORS_ORIGIN`, `SPOTIFY_REDIRECT_URI`, `TESLA_REDIRECT_URI`, plus
  `SPOTIFY_MOCK=false`, `XAI_MOCK=false`, secrets, and Tesla/Gemini keys.

## Section 4 — Coolify steps (documented)

`docs/deployment.md` (extend the existing file) with: create a Coolify "Application" from the Git
repo, Build Pack = **Dockerfile**, set the domain `aijourneydj.ruhrco.de` (Coolify provisions
Let's Encrypt TLS), expose port 3000, attach **Persistent Storage** mapped to `/data`, paste the env
vars, deploy. Then the Tesla sequence: verify the public-key URL, `POST /auth/tesla/register-partner`,
`/auth/tesla/login`, enable `TESLA_FLEET_ENABLED=true`.

## Section 5 — Error handling & verification

- The static/SPA serving never shadows API routes (guarded + prefix precedence) and is skipped when
  `apps/web/dist` is absent.
- Verification: `docker build .` succeeds; running the image, `GET /health` returns `{ ok: true }`
  and `GET /` returns the SPA HTML; the full existing test suite stays green (static registration is
  guarded and untouched in tests); typecheck + lint clean.

## Out of scope

- CI/CD pipeline, multi-instance scaling, external Postgres (SQLite is fine single-user), Kafka
  broker (Tesla data uses the Fleet poller, not Kafka), production log shipping.
