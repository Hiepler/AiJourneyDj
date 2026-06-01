# AI Journey DJ

**A telemetry-aware AI music director for Tesla road trips.** Tell it where you're headed and what
mood you're in; it curates a soundtrack that keeps adapting to how the drive actually unfolds —
pace, time of day, navigation phase, region — and plays it on Spotify, in the car.

Self-hostable, open source, single-user. Spotify-first (TIDAL is a fallback).

---

## Why it's different

Most "smart" playlists pick a vibe once. AI Journey DJ treats the drive as a living context and
re-curates as that context changes. Two systems do the heavy lifting:

### 🎚 The recommendation engine

A deterministic **Musical Brief** is derived from live drive signals (pace bucket, drive phase, time
of day, weather feel, ETA, region) — energy target, intensity, eras, genres, mood words. Zero tokens,
fully testable.

That brief drives a **Multi-Lens generator**: several Gemini calls run in parallel, each with a
distinct lens —

- **current** (web-grounded via Google Search — real, recently charting/viral tracks),
- **classics** (timeless, cross-decade),
- **cross-genre** (deliberate, fitting surprises — the discovery counterweight),
- **regional** (artists evocative of the destination).

Their candidates are merged by a **diversity balancer** that spreads picks across decades, genres and
artists, then resolved on Spotify (with a persistent search cache so a 10-hour drive never hits rate
limits).

On top of that:

- **No-repeat guarantee** — every song plays at most once per journey, by exact track *and* by
  normalized song key (so "Song" and "Song – Live/Extended/Remaster" count as one).
- **Personalization** — your Spotify top artists become a favored-genre signal, blended in via an
  adjustable **Vibe-Mix** (Familiar ↔ Discover) right in the cockpit.
- **Cost-aware** — AI runs only when the vibe actually changes; routine buffer top-ups reuse the
  already-generated pool. Flash "thinking" is disabled for cheaper, faster, complete responses.

### 🛰 Live Tesla telemetry

Connect your car via the **Tesla Fleet API** (read-only polling, EU/US). The app maps speed,
outside temperature, battery, navigation destination and ETA, and turns raw GPS into a **coarse
region** server-side. Telemetry derives the **drive phase** (departure → cruise → golden hour →
arrival → …); a phase change automatically re-curates the queue. It never wakes a sleeping car and
never sends raw GPS, VINs, or your streaming library to the AI.

---

## Features

- **Cockpit UI** built for the Tesla landscape touchscreen — large tap targets, glanceable live
  context (phase · pace · ETA · weather · region), no typing while driving (mood **presets**, recent-
  destination quick-picks).
- **Tap-to-steer** the soundtrack: change drive phase or the Vibe-Mix and the queue re-tunes with a
  visible "re-tuning" moment.
- **Spotify Connect device picker** — play on the in-browser player, your phone, or the car's native
  Spotify; full play/pause/skip control of the selected device.
- **Background-playback survival** — silent keep-alive + MediaSession so audio keeps going when the
  Tesla browser is minimized, and the car's mini-player skip buttons work.
- **Auto journey playlist** — every curated track is mirrored into a private Spotify playlist named
  for the trip, so you can replay the journey later.
- **Graceful by design** — every Spotify/AI/telemetry failure degrades quietly; the drive never
  breaks. TIDAL remains a full playlist + deep-link fallback.

---

## Architecture

npm-workspaces monorepo:

- `apps/web` — React + Vite PWA (the cockpit).
- `apps/api` — Fastify API, SQLite (`node:sqlite`), OAuth, playback orchestration, the Tesla Fleet
  poller, and a 60-second journey worker. In production it also serves the built SPA (one origin).
- `packages/recommendation` — the Musical Brief, Multi-Lens scout, diversity balancing, song keys.
- `packages/spotify` — Spotify Web API adapter (search, playback, devices, playlists) + resolver.
- `packages/telemetry` — Tesla payload normalization, phase derivation.
- `packages/{core,crypto,open-music,tidal,test-fixtures}` — shared types, encrypted credential store,
  MusicBrainz/ListenBrainz enrichment, TIDAL adapter, fixtures.

**Stack:** TypeScript, Fastify 5, React 19, Vite, Vitest, Spotify Web Playback SDK + Web API,
Gemini (`generateContent` + Google Search grounding), Tesla Fleet API.

---

## Quick start (mock mode — no credentials)

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`. The dev server proxies the API, so login + OAuth redirects work on the
same origin. The defaults ship with `SPOTIFY_MOCK=true` / `TIDAL_MOCK=true` / `XAI_MOCK=true`, so you
can start journeys and watch the queue update with no provider keys.

```bash
npm run typecheck   # all workspaces
npm run test        # full Vitest suite
npm run lint
npm run build       # web bundle
```

## Going live

- **Spotify** (Premium required): create an app, add `https://<domain>/auth/spotify/callback`, set
  `SPOTIFY_CLIENT_ID/SECRET` + `SPOTIFY_MOCK=false`. Scopes include `user-top-read` (personalization)
  and `playlist-modify-private` (journey playlist) — reconnect once after upgrading.
- **AI scout:** set `XAI_MOCK=false` + `GEMINI_API_KEY` (`SONG_SCOUT=multilens`, the default). Grok is
  an optional fallback (`SONG_SCOUT=xai`, `XAI_API_KEY`).
- **Tesla Fleet API** + **deployment (Docker / Coolify):** step-by-step in
  [`docs/deployment.md`](docs/deployment.md). The repo ships a single-container `Dockerfile`
  (the API serves the SPA) and an `.env.example` template.

Confirm the active scout and connections at `GET /health`.

## Privacy

Data minimization is a design goal, not an afterthought:

- Raw GPS is used only transiently to derive a coarse region; it is never stored or sent to the AI.
- The AI receives only abstracted journey context — no VINs, no raw coordinates, no streaming-library
  data, no Spotify/TIDAL catalog content.
- Credentials are encrypted at rest in SQLite (`APP_SECRET`); the Tesla integration is read-only and
  never wakes a sleeping vehicle.

## Status & limitations

Built for self-hosted, non-commercial, single-user use; it does not redistribute audio or expose
streaming as a service. Spotify Web Playback needs Premium + a DRM/EME-capable browser. Whether the
car's *native* Spotify appears in the Connect device list depends on Tesla firmware/region. Spotify's
Web API can't reorder/remove queued items, so the engine only appends forward (and never duplicates).

## License

MIT — see [`LICENSE`](LICENSE).
