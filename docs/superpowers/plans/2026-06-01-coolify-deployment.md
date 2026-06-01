# Coolify Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app deployable as a single Docker image on Coolify, where the Fastify API also serves the built web SPA (same origin) with SQLite on a persistent volume.

**Architecture:** The API serves `apps/web/dist` via `@fastify/static` (guarded so tests/dev are untouched); a root Dockerfile installs deps, builds the web, and runs the API with `tsx` (matching dev, which reliably handles the TS workspace exports + `node:sqlite`).

**Tech Stack:** Node 24, Fastify 5, `@fastify/static`, tsx, Vite, Docker, Coolify.

---

## File Structure

- **Modify** `apps/api/package.json` — add `@fastify/static`.
- **Modify** `apps/api/src/app.ts` — serve the SPA when a built `dist` is present.
- **Create** `apps/api/test/staticWeb.test.ts` — SPA-serving test.
- **Modify** `package.json` (root) — add `start:prod` script.
- **Create** `Dockerfile` + `.dockerignore` (repo root).
- **Modify** `docs/deployment.md` — Coolify steps.

All commands run from repo root `/Users/benedikthiepler/projects/priv/tidal`.

---

## Task 1: API serves the built SPA

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/staticWeb.test.ts`

- [ ] **Step 1: Add the dependency**

In `apps/api/package.json`, add to `dependencies` (keep alphabetical near the other `@fastify/*`):

```json
    "@fastify/static": "^8.0.0",
```

Then install:

Run: `npm install`
Expected: lockfile updates, `@fastify/static` present.

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/staticWeb.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

const tmpDirs: string[] = [];
afterEach(() => {
  delete process.env.WEB_DIST_DIR;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-static-"));
  tmpDirs.push(dir);
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "true",
    CORS_ORIGIN: "http://localhost:5173"
  });
}

describe("static SPA serving", () => {
  it("serves index.html for non-API GET routes and keeps API routes JSON", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "ai-journey-dj-webdist-"));
    tmpDirs.push(webDir);
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>JourneyDJ</title>");
    process.env.WEB_DIST_DIR = webDir;

    const { app } = await buildApp(testConfig());

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("JourneyDJ");

    const spaRoute = await app.inject({ method: "GET", url: "/cockpit" });
    expect(spaRoute.statusCode).toBe(200);
    expect(spaRoute.body).toContain("JourneyDJ");

    // API still serves JSON (health) and 404s unknown API paths instead of the SPA.
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    const unknownApi = await app.inject({ method: "GET", url: "/journeys/does-not-exist/nope" });
    expect(unknownApi.statusCode).toBe(404);

    await app.close();
  });

  it("does not serve a SPA when no dist is configured (dev/test default)", async () => {
    const { app } = await buildApp(testConfig());
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/api/test/staticWeb.test.ts`
Expected: FAIL — `/` returns 404 (no static serving yet) in the first test.

- [ ] **Step 4: Implement SPA serving in `buildApp`**

In `apps/api/src/app.ts`, add imports at the top (with the other imports):

```ts
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
```

Replace the end of `buildApp`:

```ts
  await registerJourneyRoutes(app, journeyService, store, tidalAuth, spotifyAuth);
  await registerTelemetryRoutes(app, config, journeyService);

  return { app, store, journeyService, teslaAuth };
}
```

with:

```ts
  await registerJourneyRoutes(app, journeyService, store, tidalAuth, spotifyAuth);
  await registerTelemetryRoutes(app, config, journeyService);

  // In production (or when WEB_DIST_DIR is set), the API also serves the built web SPA so the whole
  // app lives on one origin (no CORS; OAuth/Spotify same-origin; one domain for Tesla's public key).
  const webDist = process.env.WEB_DIST_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  const serveWeb = process.env.WEB_DIST_DIR ? existsSync(webDist) : config.NODE_ENV === "production" && existsSync(webDist);
  if (serveWeb) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    const apiPrefixes = ["/health", "/auth", "/journeys", "/history", "/internal", "/spotify", "/.well-known"];
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split("?")[0];
      const isApi = apiPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
      if (request.method === "GET" && !isApi) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not found" });
    });
  }

  return { app, store, journeyService, teslaAuth };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run apps/api/test/staticWeb.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json package-lock.json apps/api/src/app.ts apps/api/test/staticWeb.test.ts
git commit -m "feat(api): serve the built web SPA from the API in production"
```

---

## Task 2: Dockerfile + .dockerignore + start script

**Files:**
- Modify: `package.json` (root)
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Add the production start script**

In root `package.json`, add to `scripts` (after `"build"`):

```json
    "start:prod": "tsx apps/api/src/index.ts",
```

- [ ] **Step 2: Create `.dockerignore`**

Create `.dockerignore`:

```
node_modules
**/node_modules
**/dist
**/*.test.ts
apps/web/e2e
playwright-report
test-results
docs
.git
.github
data
*.db
*.db-*
.env
.env.*
*.log
.DS_Store
```

- [ ] **Step 3: Create the `Dockerfile`**

Create `Dockerfile`:

```dockerfile
# Single-container deploy: API (tsx) serves the built web SPA on one origin.
FROM node:24-bookworm-slim

WORKDIR /app

# Install all workspace deps (dev deps included — needed to build the web bundle).
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci

# Build the web SPA → apps/web/dist (served by the API at runtime).
RUN npm run build -w @ai-journey-dj/web

ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
ENV API_PORT=3000
EXPOSE 3000

# tsx runs the TypeScript API directly (matches dev; resolves the .ts workspace exports + node:sqlite).
CMD ["npm", "run", "start:prod"]
```

- [ ] **Step 4: Build the image to verify it compiles (requires Docker)**

Run: `docker build -t ai-journey-dj .`
Expected: build succeeds through `npm run build -w @ai-journey-dj/web` and ends tagged `ai-journey-dj`.
(If Docker is unavailable in this environment, skip and run it on the deploy host; the steps above are the verification.)

- [ ] **Step 5: Smoke-test the container (requires Docker)**

Run:
```bash
docker run --rm -e APP_SECRET=test-secret -e SPOTIFY_MOCK=true -e XAI_MOCK=true -e DATABASE_PATH=/data/dj.db -v dj-data:/data -p 3000:3000 ai-journey-dj &
sleep 5
curl -s localhost:3000/health
curl -s localhost:3000/ | head -c 80
```
Expected: `/health` returns JSON `{"ok":true,...}`; `/` returns the SPA HTML.

- [ ] **Step 6: Commit**

```bash
git add package.json Dockerfile .dockerignore
git commit -m "build: single-container Dockerfile (web build + tsx API) for Coolify"
```

---

## Task 3: Coolify + onboarding docs

**Files:**
- Modify: `docs/deployment.md`

- [ ] **Step 1: Prepend the Coolify section**

In `docs/deployment.md`, add this section at the top (before the existing "## 1. Host"):

```markdown
## 0. Deploy on Coolify (single container)

1. In Coolify: New → **Application** → connect this Git repo + branch.
2. **Build Pack: Dockerfile** (the repo root `Dockerfile`).
3. **Port:** `3000`. **Domain:** `aijourneydj.ruhrco.de` → Coolify provisions Let's Encrypt TLS.
4. **Persistent Storage:** add a volume mounted at `/data` (SQLite lives here).
5. **Environment variables** (from `.env.example`, production values):
   - `APP_SECRET` (long random), `DATABASE_PATH=/data/ai-journey-dj.db`
   - `API_BASE_URL=https://aijourneydj.ruhrco.de`, `APP_BASE_URL=https://aijourneydj.ruhrco.de`, `CORS_ORIGIN=https://aijourneydj.ruhrco.de`
   - `SPOTIFY_MOCK=false`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI=https://aijourneydj.ruhrco.de/auth/spotify/callback`
   - `XAI_MOCK=false`, `GEMINI_API_KEY`
   - Tesla: `TESLA_FLEET_ENABLED=true`, `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TESLA_REDIRECT_URI=https://aijourneydj.ruhrco.de/auth/tesla/callback`, `TESLA_PUBLIC_KEY_PEM`
6. **Healthcheck path:** `/health`.
7. Deploy. Then verify `https://aijourneydj.ruhrco.de/health` and that the app UI loads.
8. Tesla onboarding (sections below): verify the public-key URL, `POST /auth/tesla/register-partner`, `/auth/tesla/login`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/deployment.md
git commit -m "docs: Coolify single-container deployment steps"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck all workspaces**

Run: `npm run typecheck --workspaces`
Expected: exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `./node_modules/.bin/vitest run`
Expected: all files pass (previous total + 2 static tests), 0 failures.

- [ ] **Step 3: Lint changed files**

Run: `npx eslint apps/api/src/app.ts`
Expected: `No issues found`.

- [ ] **Step 4: Commit any lint fixes (only if Step 3 required changes)**

```bash
git add -A
git commit -m "chore(api): lint cleanup for SPA serving"
```

---

## Self-Review Notes

- **Spec coverage:** §1 Dockerfile+.dockerignore (Task 2), §2 API-serves-SPA (Task 1), §3 persistence/config (Dockerfile env + docs Task 3), §4 Coolify steps (Task 3), §5 verification (Task 4 + Task 2 smoke test). Covered.
- **Test isolation:** SPA serving is gated — only when `WEB_DIST_DIR` is set (the test) or `NODE_ENV==="production"` with a real dist. Normal tests (no env, NODE_ENV=test) keep the prior 404 behavior; the second test asserts exactly that.
- **Runtime choice:** `start:prod` uses `tsx` (already an `apps/api` dependency, hoisted to root `node_modules/.bin`), matching dev — avoids the fragile compiled-bundle path.
- **No placeholders.** Docker steps are marked as requiring Docker (run on the host if unavailable locally).
```
