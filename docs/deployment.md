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
