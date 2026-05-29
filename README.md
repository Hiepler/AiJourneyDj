# AI Journey DJ

AI Journey DJ is a self-hostable, open-source road-trip DJ for Tesla journeys.
Version 1.1 is Spotify-first and Grok-first: the app uses trip context to
suggest song candidates, resolves those candidates in Spotify, and maintains a
rolling 5-track Spotify Web Playback queue in the Tesla browser. TIDAL remains a
full playlist and deep-link fallback.

## What v1 Includes

- React/Vite PWA optimized for Tesla browser and mobile.
- Fastify API with SQLite persistence and a background journey worker.
- Spotify OAuth, Web Playback SDK device playback, track resolving, and 5-track
  queue updates.
- TIDAL OAuth, playlist creation, track resolving, 5-track updates, and share
  links as fallback.
- xAI/Grok song scouting with optional web search parameters.
- MusicBrainz and ListenBrainz lookups for open music enrichment.
- Tesla Fleet Telemetry local stack with Redpanda plus a simulator.
- Privacy guardrails: no TIDAL content, raw GPS traces, VINs, or user library data
  are sent to the AI provider.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

If you see `EADDRINUSE` on port 3000 or 5173, an old dev server is still running.
Stop it with Ctrl+C in the other terminal, or run:

```bash
npm run dev:clean
```

Open `http://localhost:5173`. The web dev server proxies API routes, so Spotify/TIDAL login
buttons work on the same host. If you open the app via a network URL (for example on a phone),
OAuth redirects return to that same origin automatically.

The default `.env.example` runs with `SPOTIFY_MOCK=true`, `TIDAL_MOCK=true`, and
`XAI_MOCK=true`, so you can start journeys and test queue or playlist updates
without provider credentials.

## Real Spotify Setup

1. Create a Spotify developer application.
2. Add `http://localhost:3000/auth/spotify/callback` as a redirect URI.
3. Set `SPOTIFY_CLIENT_ID`, optional `SPOTIFY_CLIENT_SECRET`, and
   `SPOTIFY_REDIRECT_URI`.
4. Set `SPOTIFY_MOCK=false`.
5. Open `/auth/spotify/login` from the web app or directly at
   `http://localhost:3000/auth/spotify/login`.

Spotify playback requires a Premium account and a browser with DRM/Encrypted
Media Extensions support. The Tesla web app creates a Spotify Web Playback SDK
player, reports its Spotify Connect device ID to the backend, starts playback on
that device, and keeps five future tracks queued. If the browser pauses,
autoplay is blocked, Premium is missing, or the SDK/device becomes unavailable,
use the TIDAL fallback action in the journey view.

This project is designed for self-hosted, non-commercial use. It does not
redistribute Spotify audio or expose Spotify streaming as a service.

## Real TIDAL Setup

1. Create a TIDAL developer application.
2. Set `TIDAL_CLIENT_ID`, `TIDAL_CLIENT_SECRET`, and `TIDAL_REDIRECT_URI`.
3. Set `TIDAL_MOCK=false`.
4. Open `/auth/tidal/login` from the web app or directly at
   `http://localhost:3000/auth/tidal/login`.

The API uses Authorization Code with PKCE and stores encrypted credentials in
SQLite. Use a strong `APP_SECRET`; changing it invalidates stored credentials.

## xAI / Grok Setup

Set:

```bash
XAI_API_KEY=...
XAI_MOCK=false
XAI_MODEL=grok-4.3
```

Grok receives only sanitized journey context. It does not receive TIDAL search
results, TIDAL playlists, user library data, VINs, or raw GPS points.

## Tesla Fleet Telemetry

For local development:

```bash
docker compose up redpanda
npm run telemetry:sim -w @ai-journey-dj/api
```

To test background queue or playlist refreshes without waiting 12 minutes, set
in `.env`:

```bash
JOURNEY_REFRESH_MINUTES=1
```

The API worker checks active journeys every 60 seconds and re-analyzes when the
last provider update is older than this interval or when the tracked buffer drops
below five future tracks. Verify the value with `curl http://localhost:3000/health`.

For a real vehicle, configure the official Tesla Fleet Telemetry reference
server and point it at the Redpanda broker/topic in `docker-compose.yml`. The
backend consumes normalized events and persists only coarse journey context.

## Scripts

```bash
npm run dev
npm run typecheck
npm run test
npm run lint
npm run build
```

## Privacy Model

AI Journey DJ is designed around data minimization:

- Stores coarse journey history, not raw GPS streams.
- Sends abstracted trip context to the AI provider.
- Uses Spotify and TIDAL only to resolve candidate songs and update playback or
  playlists.
- Avoids feeding streaming-service content into AI prompts, logs, or embeddings.

## Known Limitations

- Spotify queue items cannot be reliably removed or reordered through the Web
  API, so AI Journey DJ only appends forward and prevents duplicate queued
  tracks.
- Spotify Web Playback SDK requires Premium and browser DRM/EME support.
- TIDAL playlist updates remain the fallback for browsers where Spotify playback
  is blocked or unreliable.
- Tesla Fleet Telemetry production setup requires your own Tesla developer
  configuration, vehicle keys, and reachable telemetry endpoint.
- TIDAL OAuth endpoints are configurable because provider deployment details can
  change; keep `.env` aligned with the TIDAL developer dashboard.
