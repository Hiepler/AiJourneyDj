# Production Deployment + Tesla Fleet Onboarding

## 0. Deploy on Coolify (single container)

The repo ships a single-container `Dockerfile`: it builds the web SPA and the Fastify API serves it on
one origin (port 3000). One image, one domain — ideal for the Tesla browser and the Tesla public key.

1. In Coolify: New → **Application** → connect this Git repo + branch.
2. **Build Pack: Dockerfile** (the repo root `Dockerfile`).
3. **Port:** `3000`. **Domain:** `aijourneydj.ruhrco.de` → Coolify provisions Let's Encrypt TLS.
4. **Persistent Storage:** add a volume mounted at `/data` (SQLite lives here).
5. **Environment variables** (production values; see `.env.example`):
   - `APP_SECRET` (long random), `DATABASE_PATH=/data/ai-journey-dj.db`
   - `API_BASE_URL=https://aijourneydj.ruhrco.de`, `APP_BASE_URL=https://aijourneydj.ruhrco.de`, `CORS_ORIGIN=https://aijourneydj.ruhrco.de`
   - `SPOTIFY_MOCK=false`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI=https://aijourneydj.ruhrco.de/auth/spotify/callback`
   - `XAI_MOCK=false`, `GEMINI_API_KEY`
   - Tesla: `TESLA_FLEET_ENABLED=true`, `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TESLA_REDIRECT_URI=https://aijourneydj.ruhrco.de/auth/tesla/callback`, `TESLA_PUBLIC_KEY_PEM`
6. **Healthcheck path:** `/health`.
7. Deploy, then verify `https://aijourneydj.ruhrco.de/health` returns `{ "ok": true }` and the app UI loads at `/`.
8. Continue with the Tesla onboarding (sections 4-5): verify the public-key URL, `POST /auth/tesla/register-partner`, `/auth/tesla/login`.

## 1. Host
- Deploy API + web behind your domain with TLS (the Tesla in-car browser, Spotify Web Playback, and
  all OAuth flows require HTTPS).
- Mount a persistent volume for `DATABASE_PATH`.
- Copy `.env.example` → `.env` and fill every value; set `NODE_ENV=production` and your real domain in
  `API_BASE_URL` / `APP_BASE_URL` / `CORS_ORIGIN`.

## 2. Spotify
- Register `https://<domain>/auth/spotify/callback` in the Spotify developer dashboard.
- Set `SPOTIFY_MOCK=false` + client id/secret. A Spotify **Premium** account is required for playback.
- Open the app, click Connect Spotify, and re-authorize — the app added the `user-top-read` and
  `playlist-modify-private` scopes since the last connect.

## 3. Gemini (AI song scout)
- Set `XAI_MOCK=false` and a real `GEMINI_API_KEY`. `SONG_SCOUT=multilens` is the default engine.

## 4. Tesla developer app (EU region)
1. Create an app at developer.tesla.com → set `TESLA_CLIENT_ID` / `TESLA_CLIENT_SECRET`.
2. OAuth redirect URI: `https://<domain>/auth/tesla/callback`. Request scopes `vehicle_device_data`
   and `vehicle_location`.
3. Generate an EC key pair:
   ```bash
   openssl ecparam -name prime256v1 -genkey -noout -out tesla-private.pem
   openssl ec -in tesla-private.pem -pubout -out tesla-public.pem
   ```
   Put the **public** PEM contents into `TESLA_PUBLIC_KEY_PEM` (keep the private key secret — it is
   only needed if you later add vehicle commands or streaming).
4. Verify the key is served:
   `GET https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`.
5. Register the partner account once (per region):
   `curl -XPOST https://<domain>/auth/tesla/register-partner`
   (the app fetches a partner token and registers your domain with the EU Fleet API).
6. Connect the car: open `https://<domain>/auth/tesla/login`, sign in with your Tesla account, approve.

## 5. Turn on polling
- Set `TESLA_FLEET_ENABLED=true` and (optionally) `TESLA_POLL_SECONDS=45`.
- The poller only reads `vehicle_data` while a journey is active **and** the car reports `online` — it
  never wakes a sleeping car (protects the 12V/HV battery).
- Privacy: raw GPS is used only transiently to derive a coarse region (e.g. "Bavaria, Germany"); it is
  never stored nor sent to the AI. Speed/ETA/temperature/battery and the navigation destination flow
  into the journey context and drive phase changes + re-curation automatically.

## 6. Quick health check
- `GET https://<domain>/health` shows connection + scout status.
- Start a journey, begin driving (car `online`); within ~`TESLA_POLL_SECONDS` the cockpit's live
  context (Pace/ETA/Region) should reflect real data and the soundtrack should re-curate as the phase
  changes.

## 7. (Optional) Fleet Telemetry streaming — real-time, lower cost

Streaming replaces REST polling as the **primary** source (REST stays as automatic fallback). The car
pushes data over mTLS to a self-hosted `fleet-telemetry` server → MQTT (Mosquitto) → the API's MQTT
consumer → the same ingest pipeline. On-change + `minimum_delta` keep a 10 h drive in the cents.
Requires vehicle firmware **2024.26+** (some Intel-MCU Model S/X need 2025.20+).

This is **infrastructure work done by hand** — it is not covered by automated tests. Follow in order.

### 7.1 Generate a CA (validates the car's client cert)
```bash
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -days 3650 -subj "/CN=Ai Journey DJ Telemetry CA" -out ca.crt
```
Keep `ca.key` secret. `ca.crt` goes into the telemetry config (step 7.4) and into `TESLA_TELEMETRY_CA_PEM`.

### 7.2 Two new Coolify services (same internal network as the API)
- **`mosquitto`** (image `eclipse-mosquitto`): internal only (no public port), anonymous listener on
  `1883` within the Coolify network. The API connects via `MQTT_URL=mqtt://mosquitto:1883`.
- **`fleet-telemetry`** (image `teslamotors/fleet-telemetry:latest`): a `config.json` with
  - `tls.server_cert` / `tls.server_key`: a publicly trusted cert for `telemetry.<domain>` (so the car
    trusts the server) — e.g. issued by Let's Encrypt and mounted into the container,
  - the MQTT dispatcher: `{ "mqtt": { "broker": "tcp://mosquitto:1883", "topic_base": "tesla/telemetry" } }`,
  - `records` listing the fields + intervals from the spec.
  Expose it on a dedicated port (e.g. `4443`).

### 7.3 Traefik TCP passthrough (critical)
mTLS must terminate **at the fleet-telemetry container**, not at Traefik — otherwise the car's client
cert is stripped. Configure Coolify/Traefik to **TCP-passthrough (SNI route)** `telemetry.<domain>:4443`
straight to the fleet-telemetry service. Do **not** put it behind the app's HTTP router / Basic Auth.
Add a DNS A record `telemetry.<domain> → <server IP>`.

### 7.4 Register the telemetry config with Tesla
Set in the API env and redeploy:
```
TESLA_TELEMETRY_ENABLED=true
MQTT_URL=mqtt://mosquitto:1883
MQTT_TOPIC=tesla/telemetry
STREAM_FRESH_WINDOW_SECONDS=90
TESLA_TELEMETRY_HOST=telemetry.<domain>
TESLA_TELEMETRY_PORT=4443
TESLA_TELEMETRY_CA_PEM=<contents of ca.crt>
```
Then register once (config write — no command, does not wake the car):
```bash
curl -XPOST -u USER:PASS https://<domain>/auth/tesla/register-telemetry
# expect {"ok":true,"status":200,...}
```
Note: max **3 telemetry configs per vehicle** — if you iterate, delete the old one first
(`DELETE` via `teslaAuth.deleteTelemetryConfig()` / re-register overwrites).

### 7.5 Verification checklist
- `fleet-telemetry` logs show the vehicle's mTLS connection while driving.
- Mosquitto receives messages on `tesla/telemetry`.
- API logs: no `mqtt.error`; `GET /journeys/:id` → `context.telemetrySource: "streaming"`; the cockpit
  live badge reads **"Live (Streaming)"**.
- Park the car → stream stops → within `STREAM_FRESH_WINDOW_SECONDS` the REST poller resumes (fallback).
- Tesla usage dashboard: streaming signals accrue at fractions of a cent on a calm cruise.

**If anything fails, streaming is optional:** leave `TESLA_TELEMETRY_ENABLED=false` and the app runs on
the (cost-optimized) REST poller exactly as before.
