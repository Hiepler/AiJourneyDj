# AI Journey DJ

**A telemetry-aware AI music director for road trips.** Tell it where you're headed and what mood
you're in; it composes a soundtrack with *shape* and keeps re-composing it as the drive actually
unfolds — pace, time of day, navigation phase, region, traffic, even a border crossing — and plays it
on Spotify, in the car.

Self-hostable, open source, single-user. Spotify-first (TIDAL is a fallback).

---

## The idea

A drive isn't a mood — it's a **trajectory**. You leave, you settle into a rhythm, something happens
(a jam clears, the sun drops, you cross into another country), and eventually you arrive. Most "smart"
playlists pick one vibe and hold it. AI Journey DJ treats the drive as a story with a **shape** and
**live plot twists**, and scores both:

1. **A narrative arc.** Every queue is built as a setlist — an opening that anchors the mood, tracks
   that build, an interlude to breathe, a climax, and a graceful resolution into arrival — not a flat
   list.
2. **The right song at the right moment.** Live telemetry is read as *signals over time*, not a single
   snapshot. When the situation changes, the soundtrack responds: the jam breaks and a banger lands;
   you cross into Italy and local hits slip in; the ETA ticks toward zero and a familiar anthem closes
   the drive.

Two systems make that work and feed each other: a recommendation engine that thinks in **roles, story
acts, and transparent scores**, and live Tesla telemetry that tells it how the drive is *really*
going. Most of the music intelligence is **deterministic and zero-token** — testable heuristics decide
*what kind of music* fits; the LLM is used only to *find real, current tracks* that match.

---

## How the engine thinks

### 🎚 The Musical Brief — telemetry in, intent out (zero tokens)

A deterministic **Musical Brief** is derived from live drive signals: an energy target, intensity,
eras, genres, valence, and mood words. It reads not just the current state (pace, phase, time,
weather, ETA, region) but the **trend** — accelerating nudges energy up and adds a "lifting" mood;
slowing eases it off; an approaching ETA tips the brief into a resolving register. Traffic delay,
acceleration style (stop-and-go vs. smooth glide) and a quiet cabin fuse in as additional drive
signals. No tokens, fully unit-tested.

### 🎬 Drive Story — a setlist with a beginning, middle and end

The brief is shaped by where you are in the journey's **narrative arc**:

`opening` → `act_one` → `interlude` → `climax` → `finale`

Each act carries an energy offset and a directive to the generator, so the climax peaks and the finale
resolves toward arrival. The very first track is an **opening-title anchor** — a familiar cut drawn
from your own taste — so the drive starts on something that feels like *yours*.

### ⚡ Journey Moments — the right song at the right moment

A pure, cooldown-guarded detector watches the telemetry history for moments worth scoring, and
re-curates with a directive, an energy shift and (where it makes sense) a dedicated priority slot:

| Moment | What the soundtrack does |
| --- | --- |
| **Traffic jam** | Eases into calmer, warmer selections — patient, pleasant cabin |
| **Jam release** | Celebrates the open road with an energy lift and one undeniable banger |
| **Border crossing** | Welcomes you with **current local hits** from the new country's charts |
| **Golden hour** | Lets the set swell cinematically with the light |
| **Temperature swing** | Brightens when it warms up, gets cozier when a cold front rolls in |
| **Arrival** | Closes with a beloved, familiar **anthem** as the finale |

Moments fire at most once per cooldown window, never hard-cut the current track, and degrade silently
if a data source is missing.

### 🎛 Lens selection + grounded generation

The brief **selects the right generators for this drive** from a lens catalog — focused/low-
distraction, cinematic warmth, steady momentum, a sharpened **geo-soundtrack lens** (artists and songs
with a *real* connection to the route and destination, found via web search), a **deep-cut explorer
lens** (B-sides, regional scenes, fresh releases — no superstars), a timeless anchor, a leftfield
bridge — instead of always running the same four. Chosen lenses run as parallel Gemini calls
(current/regional/explorer lenses web-grounded via Google Search for real, recent tracks).

### 🔭 Momentum Radio — discovery without an echo chamber

A third candidate source orbits the *current* moment instead of the global charts: it walks the
**Last.fm similar-artist/track graph** out from what's playing now, your wishes, and your taste, then
**inverts popularity** (favoring ranks ~5–30) so you get the great-but-not-obvious neighbors of music
you already like.

### 🌈 The Variety Doctrine — no more "the same five artists"

Real variety, enforced at several layers:

- **Hard artist ban** from a cross-journey play ledger — an artist you've heard recently is excluded
  outright (and surfaced to the LLM as an avoid-list), with automatic relaxation if the playable pool
  gets too thin.
- **Genre spread** in the buffer so no two same-mood tracks sit back-to-back when the pool allows.
- **Diversity balancing** across decades, genres and artists before tracks resolve on Spotify.

### 🗣 You steer it — vibe directives, wishes & skip-learning

- **Vibe toggles** in the cockpit — ⚡ Faster, 🎤 Singalong, ☀️ Stay awake — are *pinned* directives
  that shift the energy bias and mood tags until you toggle them off. One tap, one request.
- **Music wishes** by text or voice ("mehr Taylor Swift", "schneller", "nicht schon wieder Dua Lipa")
  parse into artist boosts, tempo shifts, mood/genre nudges or avoids, with a guaranteed quota so a
  wish actually shows up in the next queue.
- **Skip-learning** — skip a track (natively in the car via a progress heuristic, or in-app) and the
  engine learns the session's mood in real time: that artist gets penalized and its mood tags get a
  soft demotion for the rest of the drive.

### 🔎 Explainable curation — "Why this song?"

Every pick can explain itself. A server-composed **why-line** appears under *Now Playing* —
*"Jam cleared — the release banger"*, *"Local hit: trending in Italy right now"*, *"Because you like
Bonobo"*, *"Opening title — your familiar way in"* — so the curation is legible, not a black box.

### 🛰 Live Tesla telemetry — the engine's senses

Connect your car via the **Tesla Fleet API** (read-only polling, EU/US). The app maps speed, outside
temperature, battery, autopilot state, navigation destination/ETA, live route traffic delay, and turns
raw GPS into a **coarse region** server-side. It derives **trends** from recent snapshots (pace
`accelerating`/`slowing`/`steady`, ETA `approaching`/`steady`) and the **drive phase**
(departure → cruise → golden hour → arrival → …). Those signals flow straight into the brief, lens
selection and moment detection — a phase change re-curates automatically. It never wakes a sleeping
car and never sends raw GPS, VINs, or your streaming library to the AI.

### 🧭 Adaptive Drive Mode (calm / focus)

A deterministic, zero-token classifier reads recent telemetry and biases *what gets picked* to fit the
situation. **It's a comfort feature — not a safety or driver-assistance system — and makes no claims
about attention or cognitive load.**

- **Calm** in higher-attention situations — heavy traffic, low predicted range at arrival, or wintry
  cold — leaning energy down toward familiar, instrumental-leaning tracks.
- **Focus** on long, monotonous night-highway stretches — lifting energy toward engaging,
  forward-moving picks.

A cockpit chip shows the active mode and why (`Calm · heavy traffic`), with a one-tap master toggle.
Hysteresis keeps it from flapping on a single traffic light.

### 💸 Cost-aware by design

AI runs **only when the vibe actually changes** (phase shift, journey moment, vibe directive, wish);
routine buffer top-ups reuse the already-generated pool. Flash "thinking" is disabled for cheaper,
faster, complete responses. A persistent search cache means a 10-hour drive never hits rate limits.

---

## Engineering notes

- **Deterministic core, LLM at the edge.** The brief, story acts, moment rules, drive-mode classifier,
  ranking and diversity balancing are pure, seeded, and unit-tested. The LLM only *finds real tracks*
  for an intent the engine already decided — so behavior is reproducible and debuggable.
- **No-repeat guarantee** — every song plays at most once per journey, by exact track *and* by
  normalized song key (so "Song" and "Song – Live/Extended/Remaster" count as one).
- **Append-only playback model.** Spotify's Web API can't reorder or remove queued items, so the
  engine reconciles a 5-slot model and only appends forward, never duplicating — and survives native
  skips, external playback, and a browser that was backgrounded for 30 minutes.
- **Graceful everywhere** — every Spotify / AI / telemetry / Last.fm failure degrades quietly; the
  drive never breaks.
- **Every feature is env-gated** (defaults on) so you can A/B your own setup.

---

## Features

- **Cockpit UI** built for the landscape touchscreen — large tap targets, glanceable live context
  (phase · pace + trend · ETA + trend · weather · region), a live-telemetry badge, and a "why this
  song" line; no typing while driving (mood **presets**, recent-destination quick-picks, voice wishes).
- **Live start screen** — when the car is connected, the journey form pulls a fresh reading
  **on demand** (not at the next poll): it pre-fills the destination from the car's navigation, shows a
  live-telemetry badge + glanceable context (ETA · region · weather), and **seeds the very first queue**
  with real region/ETA/phase so the opening set is context-aware from track one.
- **Tap-to-steer** — vibe toggles (⚡🎤☀️), drive-phase and Vibe-Mix (Familiar ↔ Discover) controls
  re-tune the queue with a visible "re-tuning" moment.
- **Journey Moments & Drive Story** — situational re-curation and a narrative arc, on by default.
  Moments also surface as **celebratory cockpit banners** ("Welcome to Italy!", "Jam's cleared!")
  so the whole car shares the moment.
- **Family fun** — a **🧸 Kids mode** that welcomes clean Disney/film/animated singalongs the whole
  car enjoys (overriding family mode's usual avoidance), and a **synced karaoke / singalong view**:
  time-synced, line-by-line highlighting that follows playback on the car's or phone's native Spotify
  too (not just the in-browser player), duration-matched to the right recording, with a static
  fallback when no synced lyrics exist (via LRCLIB — free, no API key).
- **Adaptive Drive Mode** — automatic calm/focus selection bias from live telemetry. A comfort
  feature, explicitly not a safety system.
- **Spotify Connect device picker** — play on the in-browser player, your phone, or the car's native
  Spotify; full play/pause/skip control of the selected device.
- **Background-playback survival** — silent keep-alive + MediaSession so audio keeps going when the
  browser is minimized, and the car's mini-player skip buttons work.
- **Auto journey playlist** — every curated track is mirrored into a private Spotify playlist named for
  the trip, so you can replay the journey later.

---

## Architecture

npm-workspaces monorepo:

- `apps/web` — React + Vite PWA (the cockpit).
- `apps/api` — Fastify API, SQLite (`node:sqlite`), OAuth, playback orchestration, journey-moment
  detection at telemetry ingest, the Tesla Fleet poller, and a 60-second journey worker. In production
  it also serves the built SPA (one origin).
- `packages/recommendation` — the trend-aware Musical Brief, drive-story acts, the Adaptive Drive Mode
  classifier, adaptive lens selection, momentum-radio over the Last.fm similar graph, role-aware and
  scored candidate generation, the variety doctrine (artist ledger ban, genre spread), seeded ranking.
- `packages/spotify` — Spotify Web API adapter (search, playback, devices, playlists) + resolver.
- `packages/telemetry` — Tesla payload normalization, phase derivation.
- `packages/{core,crypto,open-music,tidal,test-fixtures}` — shared types, encrypted credential store,
  MusicBrainz/ListenBrainz enrichment, TIDAL adapter, fixtures.

**Stack:** TypeScript, Fastify 5, React 19, Vite, Vitest, Spotify Web Playback SDK + Web API, Gemini
(`generateContent` + Google Search grounding), Last.fm API, Tesla Fleet API.

---

## Quick start (mock mode — no credentials)

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`. The dev server proxies the API, so login + OAuth redirects work on the
same origin. The defaults ship with `SPOTIFY_MOCK=true` / `TIDAL_MOCK=true` / `XAI_MOCK=true`, so you
can start journeys and watch the queue update — drive story, moments and all — with no provider keys.

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
- **Last.fm** (free API key): set `LASTFM_API_KEY` to power geo/tag charts and Momentum Radio (the
  similar-artist graph). Without it those sources degrade gracefully and the engine still runs.
- **Tesla Fleet API** + **deployment (Docker / Coolify):** step-by-step in
  [`docs/deployment.md`](docs/deployment.md). The repo ships a single-container `Dockerfile` (the API
  serves the SPA) and an `.env.example` template.

Engine v2 features (drive story, journey moments, momentum radio, variety doctrine, vibe directives,
skip-learning, why-lines) are **on by default** and individually env-gated — see `.env.example`.
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
Telemetry-driven features react at the poll cadence, not in real time; there is no rain/wiper or
autopilot-engagement field in the Fleet API (weather is a temperature proxy). Adaptive Drive Mode and
journey moments bias song *selection* only (read-only Tesla access — no volume/DSP/BPM control) and are
**not** a safety or driver-assistance system.

## License

MIT — see [`LICENSE`](LICENSE).
