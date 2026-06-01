# AI Journey DJ

**A telemetry-aware AI music director for Tesla road trips.** Tell it where you're headed and what
mood you're in; it composes a soundtrack that keeps adapting to how the drive actually unfolds —
pace, time of day, navigation phase, region — and plays it on Spotify, in the car.

Self-hostable, open source, single-user. Spotify-first (TIDAL is a fallback).

---

## Why it's different

Most "smart" playlists pick a vibe once. AI Journey DJ reads the **trajectory** of the drive — not a
single snapshot — and composes a **setlist with shape**: an opener that anchors the mood, tracks that
carry momentum, a bridge, a well-placed surprise, and a graceful arrival. Two systems make that
possible and feed each other: a recommendation engine that thinks in **roles and scores**, and live
Tesla telemetry that tells it how the drive is *actually* unfolding — including whether you're
speeding up, easing off, or closing in on the destination.

### 🎚 The recommendation engine

A deterministic **Musical Brief** is derived from live drive signals — energy target, intensity,
eras, genres, mood words. It reads not just the current state (pace, phase, time, weather, ETA,
region) but the **trend**: accelerating nudges energy up and adds a "lifting" mood; slowing eases it
off; an approaching ETA tips the brief into a resolving register. Zero tokens, fully testable.

That brief **selects the right generators for this drive** from a lens catalog — focused/low-
distraction, cinematic warmth, steady momentum, regional texture, a timeless anchor, a leftfield
bridge, a resolving-arrival lens — instead of always running the same four. The chosen lenses run as
parallel Gemini calls (the current/regional lenses web-grounded via Google Search for real, recent
tracks).

Every candidate comes back with two things that make the queue a setlist rather than a list:

- a **role** — `anchor` · `momentum` · `bridge` · `surprise` · `resolution` — so picks have a
  function in the journey arc, and
- a transparent **score** across `contextFit`, `telemetryFit`, `tasteFit`, `diversityGain`,
  `novelty` and a `fatiguePenalty`, plus the privacy-safe drive signals that influenced it.

A **diversity balancer** then spreads the selection across decades, genres and artists before
resolving on Spotify (with a persistent search cache so a 10-hour drive never hits rate limits).

On top of that:

- **No-repeat guarantee** — every song plays at most once per journey, by exact track *and* by
  normalized song key (so "Song" and "Song – Live/Extended/Remaster" count as one).
- **Personalization** — your Spotify top artists become a favored-genre signal, blended in via an
  adjustable **Vibe-Mix** (Familiar ↔ Discover) right in the cockpit.
- **Cost-aware** — AI runs only when the vibe actually changes; routine buffer top-ups reuse the
  already-generated pool. Flash "thinking" is disabled for cheaper, faster, complete responses.

### 🛰 Live Tesla telemetry — the engine's senses

Connect your car via the **Tesla Fleet API** (read-only polling, EU/US). The app maps speed, outside
temperature, battery, autopilot state, navigation destination and ETA, and turns raw GPS into a
**coarse region** server-side. Crucially, it doesn't just read the latest value — it derives **trends**
from recent snapshots (pace `accelerating`/`slowing`/`steady`, ETA `approaching`/`steady`) and the
**drive phase** (departure → cruise → golden hour → arrival → …).

This is where the two systems meet: those telemetry trends flow straight into the Musical Brief and
lens selection, so the soundtrack lifts when you open up the throttle and starts resolving as you
near the destination — a phase change re-curates the queue automatically. It never wakes a sleeping
car and never sends raw GPS, VINs, or your streaming library to the AI.

### 🧭 Adaptive Drive Mode (calm / focus)

The engine's situational awareness: a telemetry-driven layer that nudges *what gets picked* to fit
the driving situation. **It is a comfort feature — not a safety or driver-assistance system — and it
makes no claims about attention or cognitive load.**

A deterministic, zero-token classifier reads recent telemetry and flips the brief into one of two
modes:

- **Calm** in higher-attention situations — heavy traffic (live route delay), low predicted range at
  arrival, or wintry cold — leaning energy down toward familiar, instrumental-leaning tracks and
  dropping the deliberate "surprise" lens.
- **Focus** on long, monotonous night-highway stretches — lifting energy toward engaging,
  forward-moving picks.

The mode shifts the Musical Brief (energy, familiarity, mood, lens choice) and adds one plain-text
line to the Gemini prompts, so the *selection* changes with **no extra AI calls**. Hysteresis keeps
it from flapping on a single traffic light, and it never hard-cuts the current track. A cockpit chip
shows the active mode and why (`Calm · heavy traffic`), with a one-tap master toggle.

**Honest limits (read-only by design):** it biases song **selection** — it does not change volume,
apply audio processing, or limit BPM. There is no rain/wiper or autopilot-engagement field in the
Fleet API (weather is a temperature proxy), and it reacts at the telemetry poll cadence, not in real
time.

---

## Features

- **Cockpit UI** built for the Tesla landscape touchscreen — large tap targets, glanceable live
  context (phase · pace + trend · ETA + trend · weather · region) and a live-telemetry badge showing
  when real Tesla data last arrived; no typing while driving (mood **presets**, recent-destination
  quick-picks).
- **Tap-to-steer** the soundtrack: change drive phase or the Vibe-Mix and the queue re-tunes with a
  visible "re-tuning" moment.
- **Adaptive Drive Mode** — automatic calm/focus selection bias from live telemetry (heavy traffic,
  low range, night monotony), surfaced as a cockpit chip with a one-tap master toggle. A comfort
  feature, explicitly not a safety system.
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
- `packages/recommendation` — the trend-aware Musical Brief, the Adaptive Drive Mode classifier,
  adaptive lens selection, role-aware and scored candidate generation, diversity balancing, song keys.
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
Adaptive Drive Mode biases song *selection* only (read-only Tesla access — no volume/DSP/BPM control)
and is **not** a safety or driver-assistance system.

## License

MIT — see [`LICENSE`](LICENSE).
