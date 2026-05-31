# Tesla Fleet API Integration (Polling) — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** `apps/api` (auth, config, telemetry poller, public-key route, partner register), `packages/telemetry` (vehicle_data normalization + speed-unit fix), docs/deployment. Read-only polling; no vehicle commands.

## Goal

Activate real Tesla Fleet API data for production: authorize the vehicle once via OAuth, poll
`vehicle_data` on an interval, normalize it into the existing `NormalizedTelemetryEvent`, and feed
it through the existing `ingestTelemetry` pipeline (which already drives phase changes + re-curation).
Single-user, EU region, own domain + server.

## Decisions

- **Ingestion:** Fleet **API polling** (REST `vehicle_data`), not streaming. No public streaming
  receiver, no protobuf, no virtual-key pairing, no signed commands (read-only).
- **Host:** in-process poller in the API (Approach A), analogous to the existing
  `startTelemetryConsumer` + 60s journey worker. Reuses the encrypted `provider_credentials` store.
- **Region:** EU. API base `https://fleet-api.prd.eu.vn.cloud.tesla.com`; auth via `auth.tesla.com`.
- **Privacy:** raw GPS is used only transiently for reverse-geocoding into a coarse region; it is
  never stored nor placed in prompts. The existing privacy assertions (no latitude/longitude in
  prompts) remain satisfied.
- **Battery safety:** never wake a sleeping vehicle. Poll only when a journey is active and the
  vehicle is `online`.

## Section 1 — Tesla developer onboarding (manual, documented)

Documented in the plan + deployment doc; not all automatable:

1. Create a Tesla developer app at developer.tesla.com → `TESLA_CLIENT_ID` / `TESLA_CLIENT_SECRET`,
   set the OAuth redirect URI to `https://<domain>/auth/tesla/callback`, request scopes
   `vehicle_device_data` + `vehicle_location`.
2. Generate an EC `prime256v1` key pair. The **public** PEM is served by the API at
   `https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem` (private key kept secret;
   only needed later if commands/telemetry are ever added).
3. **Register the partner account once** (per region): the API exposes an admin action that fetches
   a partner token (client-credentials grant, audience = EU API base) and calls
   `POST /api/1/partner_accounts` with the domain. Required even for read-only.

## Section 2 — Auth & token storage (`apps/api`)

- `apps/api/src/auth/teslaAuth.ts` (`TeslaAuthService`), mirroring `SpotifyAuthService`:
  - `createLoginUrl()` — Authorization-Code + PKCE to `https://auth.tesla.com/oauth2/v3/authorize`,
    scopes `openid offline_access vehicle_device_data vehicle_location`, state persisted.
  - `completeCallback({code,state})` — exchanges at `https://auth.tesla.com/oauth2/v3/token`, stores
    tokens **encrypted** in `provider_credentials` (provider `"tesla"`) via existing
    `encryptJson`/`decryptJson`.
  - `getAccessToken()` — returns a valid token, refreshing with the `offline_access` refresh token
    when within 2 min of expiry (same pattern as Spotify).
  - `getPartnerToken()` — client-credentials grant for partner registration.
  - `isConnected()` / `disconnect()`.
- Routes in `apps/api/src/app.ts`: `GET /auth/tesla/login`, `GET /auth/tesla/callback`,
  `POST /auth/tesla/disconnect`, `POST /auth/tesla/register-partner` (admin), and
  `GET /.well-known/appspecific/com.tesla.3p.public-key.pem` (serves `TESLA_PUBLIC_KEY_PEM`).

## Section 3 — Fleet poller (`apps/api/src/telemetry/teslaFleetPoller.ts`)

- `startTeslaFleetPoller(config, store, teslaAuth, journeyService)`: returns early unless
  `TESLA_FLEET_ENABLED`. Sets an interval of `TESLA_POLL_SECONDS` (default 45).
- Each tick:
  1. If no active journey → skip (don't poll/wake).
  2. `GET /api/1/vehicles` → pick the configured/first vehicle; if its state is not `online` → skip
     (back off; never force-wake). 408/asleep handling = skip.
  3. `GET /api/1/vehicles/{id}/vehicle_data?endpoints=drive_state;charge_state;climate_state`.
  4. `normalizeFleetVehicleData(payload)` → if it yields location, reverse-geocode to coarse region.
  5. `ingestTelemetry(event)` (existing path: per active journey, derive phase, re-curate on change).
- Wired in `apps/api/src/index.ts` next to `startTelemetryConsumer`; cleared on SIGTERM.
- All errors are caught and logged (`tesla.poll_error`); a tick failure never throws into the loop.

## Section 4 — Field mapping + speed-unit fix (`packages/telemetry`)

- **Bug fix:** `normalizeTeslaPayload` treats `VehicleSpeed` as m/s (`×3.6`). Per the Fleet field
  spec, `VehicleSpeed`/`drive_state.speed` is **mph**. Fix to **mph→km/h (`×1.609`)**. Add a test.
- New `normalizeFleetVehicleData(payload, appSecret)` for the `vehicle_data` JSON shape:
  - `drive_state.speed` (mph) → `speedKph` (×1.609, rounded); `null` → undefined (parked/asleep).
  - `charge_state.usable_battery_level` → `batteryPercent`.
  - `climate_state.outside_temp` (°C) → `outsideTempC`.
  - `drive_state.active_route_destination` → `destination` (when navigating).
  - `drive_state.active_route_minutes_to_arrival` → `etaMinutes`.
  - `drive_state.shift_state` (`"P"`/null → parked; otherwise driving) informs speed bucket only via
    `speedKph`; no separate field needed.
  - `drive_state.latitude`/`longitude` → returned as transient `{lat,lon}` for the poller to
    reverse-geocode; **never** placed on the event as raw coordinates.
  - `vehicle_state.timestamp`/now → `timestampIso`; `vin` → hashed `vehicleIdHash`.
  - Autopilot has no clean Fleet read field → `autopilotState` left `unknown` (the `focus` phase will
    simply not trigger from autopilot; phase still derives from ETA/time).
- Reverse geocoder `apps/api/src/telemetry/geocoder.ts`: `coarseRegionFor(lat, lon, fetchImpl?)`
  → calls `GEOCODER_URL` (default Nominatim reverse, zoom 8) with a descriptive User-Agent; returns
  e.g. `"Bavaria, Germany"`. **In-memory cache keyed by lat/lon rounded to ~0.1°** so we call it at
  most once per coarse area; on any error returns `undefined` (region just omitted).

## Section 5 — Config, deployment, errors, testing

**New env (`apps/api/src/config/env.ts`):**
`TESLA_FLEET_ENABLED` (bool, default false), `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`,
`TESLA_OAUTH_AUTH_URL` (default `https://auth.tesla.com/oauth2/v3/authorize`),
`TESLA_OAUTH_TOKEN_URL` (default `https://auth.tesla.com/oauth2/v3/token`),
`TESLA_API_BASE_URL` (default EU base), `TESLA_REDIRECT_URI`, `TESLA_PUBLIC_KEY_PEM`,
`TESLA_VEHICLE_ID` (optional; else first vehicle), `TESLA_POLL_SECONDS` (default 45),
`GEOCODER_URL` (default Nominatim reverse).

**Production switch (documented in `.env.example` + deploy doc):** `SPOTIFY_MOCK=false`,
`XAI_MOCK=false`, real `GEMINI_API_KEY`, strong `APP_SECRET`, HTTPS domain in `API_BASE_URL` /
`APP_BASE_URL` / `CORS_ORIGIN` / `SPOTIFY_REDIRECT_URI` / `TESLA_REDIRECT_URI`, persistent
`DATABASE_PATH`. Reconnect Spotify (scopes) + connect Tesla once.

**Errors / limits:** token auto-refresh; respect Tesla rate limits (45s poll is well within them);
408/asleep/offline → skip, never wake; geocoder failure → omit region; every poll tick is
best-effort and isolated from journey state.

**Testing (TDD):**
- `normalizeTeslaPayload` speed fix (mph→km/h) — regression test.
- `normalizeFleetVehicleData` — full mapping incl. navigating vs not-navigating (destination/ETA
  undefined), parked (speed null), and that raw lat/lon never appears on the event.
- `geocoder` — caches by rounded coords (one fetch for nearby points), returns undefined on error.
- `TeslaAuthService.createLoginUrl` — scopes/PKCE/redirect/state.
- Token refresh path (expired → refresh called).
- Poller gating — no active journey → no vehicle_data call; vehicle offline → no vehicle_data call.

## Out of scope

- Fleet Telemetry **streaming** (separate future spec; the public receiver + protobuf + virtual key).
- Vehicle **commands** (wake, climate, etc.) and the virtual-key pairing they require.
- Multi-vehicle / multi-user fleets.
- Automating the Tesla developer-app creation (manual portal step).
