# Architecture — how the engine thinks

> Deep dive into the recommendation engine. For the project overview, see the
> [README](../README.md). For the scientific hypothesis and how to test it, see
> [research.md](research.md).

The core principle: **what _kind_ of music fits the moment is decided by deterministic,
unit-tested logic on the drive data. The LLM is used for exactly one step — finding real,
current tracks for a brief that's already fixed.** Ranking, ordering, diversity and the
no-repeat rule are all pure, seeded heuristics. AI is a tool at the edge, not a brain at the
center.

---

## The Musical Brief — telemetry in, intent out (zero tokens)

A deterministic **Musical Brief** is derived from live drive signals: an energy target,
intensity, eras, genres, valence, and mood words. It reads not just the current state (pace,
phase, time, weather, ETA, region) but the **trend** — accelerating nudges energy up and adds a
"lifting" mood; slowing eases it off; an approaching ETA tips the brief into a resolving
register. Traffic delay, acceleration style (stop-and-go vs. smooth glide) and a quiet cabin
fuse in as additional drive signals. No tokens, fully unit-tested.

## Drive Story — a setlist with a beginning, middle and end

The brief is shaped by where you are in the journey's **narrative arc**:

`opening` → `act_one` → `interlude` → `climax` → `finale`

Each act carries an energy offset and a directive to the generator, so the climax peaks and the
finale resolves toward arrival. The very first track is an **opening-title anchor** — a familiar
cut drawn from your own taste — so the drive starts on something that feels like _yours_.

## Journey Moments — the right song at the right moment

A pure, cooldown-guarded detector watches the telemetry history for moments worth scoring, and
re-curates with a directive, an energy shift and (where it makes sense) a dedicated priority
slot:

| Moment                | What the soundtrack does                                               |
| --------------------- | ---------------------------------------------------------------------- |
| **Traffic jam**       | Eases into calmer, warmer selections — patient, pleasant cabin         |
| **Jam release**       | Celebrates the open road with an energy lift and one undeniable banger |
| **Border crossing**   | Welcomes you with **current local hits** from the new country's charts |
| **Golden hour**       | Lets the set swell cinematically with the light                        |
| **Temperature swing** | Brightens when it warms up, gets cozier when a cold front rolls in     |
| **Arrival**           | Closes with a beloved, familiar **anthem** as the finale               |

Moments fire at most once per cooldown window, never hard-cut the current track, and degrade
silently if a data source is missing.

## Lens selection + grounded generation

The brief **selects the right generators for this drive** from a lens catalog — focused/low-
distraction, cinematic warmth, steady momentum, a sharpened **geo-soundtrack lens** (artists and
songs with a _real_ connection to the route and destination, found via web search), a
**local-language lens** (when the country is known, a noticeable share of current songs in the
local language by homegrown artists — French near Montpellier, Italian near Garda — so the drive
feels like where you are), a **deep-cut explorer lens** (B-sides, regional scenes, fresh releases
— no superstars), a timeless anchor, a leftfield bridge — instead of always running the same
four. Chosen lenses run as parallel Gemini calls (current/regional/explorer lenses web-grounded
via Google Search for real, recent tracks).

## Momentum Radio — discovery without an echo chamber

A third candidate source orbits the _current_ moment instead of the global charts: it walks the
**Last.fm similar-artist/track graph** out from what's playing now, your wishes, and your taste,
then **inverts popularity** (favoring ranks ~5–30) so you get the great-but-not-obvious neighbors
of music you already like.

## The Variety Doctrine — no more "the same five artists"

Real variety, enforced at several layers:

- **Hard artist ban** from a cross-journey play ledger — an artist you've heard recently is
  excluded outright (and surfaced to the LLM as an avoid-list), with automatic relaxation if the
  playable pool gets too thin.
- **Genre spread** in the buffer so no two same-mood tracks sit back-to-back when the pool allows.
- **Diversity balancing** across decades, genres and artists before tracks resolve on Spotify.

## You steer it — vibe directives, wishes & skip-learning

- **Vibe toggles** in the cockpit — ⚡ Faster, 🎤 Singalong, ☀️ Stay awake — are _pinned_
  directives that shift the energy bias and mood tags until you toggle them off. One tap, one
  request.
- **Music wishes** by text or voice ("mehr Taylor Swift", "schneller", "nicht schon wieder Dua
  Lipa") parse into artist boosts, tempo shifts, mood/genre nudges or avoids, with a guaranteed
  quota so a wish actually shows up in the next queue.
- **Skip-learning** — skip a track (natively in the car via a progress heuristic, or in-app) and
  the engine learns the session's mood in real time: that artist gets penalized and its mood tags
  get a soft demotion for the rest of the drive.

## Explainable curation — "Why this song?"

Every pick can explain itself. A server-composed **why-line** appears under _Now Playing_ —
_"Jam cleared — the release banger"_, _"Local hit: trending in Italy right now"_, _"Because you
like Bonobo"_, _"Opening title — your familiar way in"_ — so the curation is legible, not a black
box.

## Live Tesla telemetry — the engine's senses

Connect your car via the **Tesla Fleet API** (read-only polling, EU/US). The app maps speed,
outside temperature, battery, autopilot state, navigation destination/ETA, live route traffic
delay, and turns raw GPS into a **coarse region** server-side. It derives **trends** from recent
snapshots (pace `accelerating`/`slowing`/`steady`, ETA `approaching`/`steady`) and the **drive
phase** (departure → cruise → golden hour → arrival → …). Those signals flow straight into the
brief, lens selection and moment detection — a phase change re-curates automatically. It never
wakes a sleeping car and never sends raw GPS, VINs, or your streaming library to the AI.

## Adaptive Drive Mode (calm / focus)

A deterministic, zero-token classifier reads recent telemetry and biases _what gets picked_ to
fit the situation. **It's a comfort feature — not a safety or driver-assistance system — and
makes no claims about attention or cognitive load.**

- **Calm** in higher-attention situations — heavy traffic, low predicted range at arrival, or
  wintry cold — leaning energy down toward familiar, instrumental-leaning tracks.
- **Focus** on long, monotonous night-highway stretches — lifting energy toward engaging,
  forward-moving picks.

A cockpit chip shows the active mode and why (`Calm · heavy traffic`), with a one-tap master
toggle. Hysteresis keeps it from flapping on a single traffic light.

## Cost-aware by design

AI runs **only when the vibe actually changes** (phase shift, journey moment, vibe directive,
wish); routine buffer top-ups reuse the already-generated pool. Flash "thinking" is disabled for
cheaper, faster, complete responses. A persistent search cache means a 10-hour drive never hits
rate limits.

---

## Engineering notes

- **Deterministic core, LLM at the edge.** The brief, story acts, moment rules, drive-mode
  classifier, ranking and diversity balancing are pure, seeded, and unit-tested. The LLM only
  _finds real tracks_ for an intent the engine already decided — so behavior is reproducible and
  debuggable.
- **No-repeat guarantee** — every song plays at most once per journey, by exact track _and_ by
  normalized song key (so "Song" and "Song – Live/Extended/Remaster" count as one).
- **Append-only playback model.** Spotify's Web API can't reorder or remove queued items, so the
  engine reconciles a 5-slot model and only appends forward, never duplicating — and survives
  native skips, external playback, and a browser that was backgrounded for 30 minutes.
- **Graceful everywhere** — every Spotify / AI / telemetry / Last.fm failure degrades quietly;
  the drive never breaks.
- **Every feature is env-gated** (defaults on) so you can A/B your own setup.

## Code map

- `packages/recommendation` — the trend-aware Musical Brief, drive-story acts, the Adaptive Drive
  Mode classifier, adaptive lens selection, momentum-radio over the Last.fm similar graph,
  role-aware and scored candidate generation, the variety doctrine (artist ledger ban, genre
  spread), seeded ranking.
- `packages/spotify` — Spotify Web API adapter (search, playback, devices, playlists) + resolver.
- `packages/telemetry` — Tesla payload normalization, phase derivation.
- `packages/{core,crypto,open-music,tidal,test-fixtures}` — shared types, encrypted credential
  store, MusicBrainz/ListenBrainz enrichment, TIDAL adapter, fixtures.
- `apps/web` — React + Vite PWA (the cockpit).
- `apps/api` — Fastify API, SQLite (`node:sqlite`), OAuth, playback orchestration, journey-moment
  detection at telemetry ingest, the Tesla Fleet poller, and a 60-second journey worker. In
  production it also serves the built SPA (one origin).
