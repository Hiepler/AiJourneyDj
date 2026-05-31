# Tesla Fleet API (Polling) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authorize a Tesla once via OAuth and poll the Fleet API `vehicle_data` on an interval, normalizing it into the existing telemetry ingest pipeline (read-only, EU region).

**Architecture:** New `TeslaAuthService` (OAuth + encrypted token storage, mirrors `SpotifyAuthService`), a `normalizeFleetVehicleData` mapper + speed-unit fix in `packages/telemetry`, a reverse-geocoder for coarse region, and an env-gated in-process `startTeslaFleetPoller` (mirrors the existing Kafka consumer) that feeds `journeyService.ingestTelemetry`.

**Tech Stack:** TypeScript monorepo, Fastify, zod, node:sqlite, Vitest, Tesla Fleet API (REST), Nominatim reverse-geocoding.

---

## File Structure

- **Modify** `packages/telemetry/src/index.ts` — fix `VehicleSpeed` unit; add `normalizeFleetVehicleData`.
- **Modify** `packages/telemetry/src/index.test.ts` — tests (create if absent).
- **Create** `apps/api/src/telemetry/geocoder.ts` — `coarseRegionFor(lat, lon, fetchImpl?)` + cache.
- **Create** `apps/api/test/geocoder.test.ts`.
- **Create** `apps/api/src/auth/teslaAuth.ts` — `TeslaAuthService`.
- **Create** `apps/api/test/tesla.test.ts` — auth + route tests.
- **Modify** `apps/api/src/config/env.ts` — Tesla env vars.
- **Modify** `apps/api/src/app.ts` — Tesla routes + public-key route + wiring; return `teslaAuth`.
- **Create** `apps/api/src/telemetry/teslaFleetPoller.ts` — the poll loop.
- **Modify** `apps/api/src/index.ts` — start the poller.
- **Create** `.env.example` + `docs/deployment.md` — production switch + Tesla onboarding.

All commands run from repo root `/Users/benedikthiepler/projects/priv/tidal`.

---

## Task 1: Telemetry mapping — speed fix + `normalizeFleetVehicleData`

**Files:**
- Modify: `packages/telemetry/src/index.ts`
- Test: `packages/telemetry/src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

If `packages/telemetry/src/index.test.ts` does not exist, create it with this content; otherwise append the `describe` block.

```ts
import { describe, expect, it } from "vitest";

import { normalizeFleetVehicleData, normalizeTeslaPayload } from "./index.js";

describe("tesla telemetry mapping", () => {
  it("treats streaming VehicleSpeed as mph (not m/s)", () => {
    // 60 mph ≈ 97 km/h. The old code multiplied by 3.6 (m/s) → 216, which was wrong.
    const event = normalizeTeslaPayload({ VehicleSpeed: 60 }, "secret");
    expect(event.speedKph).toBe(97);
  });

  it("maps vehicle_data drive/charge/climate state into a normalized event", () => {
    const event = normalizeFleetVehicleData(
      {
        vin: "5YJ3E1EA7KF000000",
        drive_state: {
          timestamp: 1717000000000,
          speed: 60, // mph
          shift_state: "D",
          latitude: 48.137,
          longitude: 11.575,
          active_route_destination: "Lago di Garda",
          active_route_minutes_to_arrival: 73.4
        },
        charge_state: { usable_battery_level: 64 },
        climate_state: { outside_temp: 21.5 }
      },
      "secret"
    );

    expect(event.speedKph).toBe(97); // 60 mph → km/h
    expect(event.destination).toBe("Lago di Garda");
    expect(event.etaMinutes).toBe(73);
    expect(event.outsideTempC).toBe(21.5);
    expect(event.batteryPercent).toBe(64);
    expect(event.vehicleIdHash).toBeDefined();
    // Raw GPS must never appear on the normalized event.
    expect((event as Record<string, unknown>).latitude).toBeUndefined();
    expect((event as Record<string, unknown>).longitude).toBeUndefined();
  });

  it("omits navigation + speed fields when parked / not navigating", () => {
    const event = normalizeFleetVehicleData(
      { drive_state: { speed: null, shift_state: "P" }, charge_state: {}, climate_state: {} },
      "secret"
    );
    expect(event.speedKph).toBeUndefined();
    expect(event.destination).toBeUndefined();
    expect(event.etaMinutes).toBeUndefined();
  });

  it("exposes transient coordinates separately for geocoding", () => {
    const { coordinates } = normalizeFleetVehicleData(
      { drive_state: { latitude: 48.1, longitude: 11.5 }, charge_state: {}, climate_state: {} },
      "secret"
    );
    expect(coordinates).toEqual({ lat: 48.1, lon: 11.5 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run packages/telemetry/src/index.test.ts`
Expected: FAIL — `normalizeFleetVehicleData` undefined; speed assertion fails (216 ≠ 97).

- [ ] **Step 3: Fix the speed unit in `normalizeTeslaPayload`**

In `packages/telemetry/src/index.ts`, find:

```ts
  const speedMps = Number(payload.VehicleSpeed ?? payload.speed ?? payload.speed_mps ?? Number.NaN);
  const speedKph = Number.isFinite(speedMps) ? Math.round(speedMps * 3.6) : undefined;
```

Replace with:

```ts
  // Tesla reports VehicleSpeed/drive_state.speed in MPH (per the Fleet field spec), not m/s.
  const speedMph = Number(payload.VehicleSpeed ?? payload.speed ?? Number.NaN);
  const speedKph = Number.isFinite(speedMph) ? Math.round(speedMph * 1.609) : undefined;
```

- [ ] **Step 4: Add `normalizeFleetVehicleData`**

Append to `packages/telemetry/src/index.ts`:

```ts
export interface FleetTelemetryResult extends NormalizedTelemetryEvent {
  /** Transient raw coordinates for server-side reverse-geocoding ONLY. Never stored or prompted. */
  coordinates?: { lat: number; lon: number };
}

/** Maps a Fleet API `vehicle_data` payload (drive/charge/climate state) into a normalized event. */
export function normalizeFleetVehicleData(payload: Record<string, any>, appSecret: string): FleetTelemetryResult {
  const drive = (payload?.drive_state ?? {}) as Record<string, any>;
  const charge = (payload?.charge_state ?? {}) as Record<string, any>;
  const climate = (payload?.climate_state ?? {}) as Record<string, any>;

  const speedMph = typeof drive.speed === "number" ? drive.speed : undefined;
  const speedKph = typeof speedMph === "number" ? Math.round(speedMph * 1.609) : undefined;

  const vin = typeof payload?.vin === "string" ? payload.vin : undefined;
  const ts = typeof drive.timestamp === "number" ? new Date(drive.timestamp).toISOString() : new Date().toISOString();

  const lat = typeof drive.latitude === "number" ? drive.latitude : undefined;
  const lon = typeof drive.longitude === "number" ? drive.longitude : undefined;

  return {
    vehicleIdHash: vin ? hashVehicleId(vin, appSecret) : undefined,
    timestampIso: ts,
    coarseRegion: undefined, // filled in by the poller via reverse-geocoding
    destination: typeof drive.active_route_destination === "string" ? drive.active_route_destination : undefined,
    etaMinutes:
      typeof drive.active_route_minutes_to_arrival === "number"
        ? Math.round(drive.active_route_minutes_to_arrival)
        : undefined,
    speedKph,
    outsideTempC: typeof climate.outside_temp === "number" ? climate.outside_temp : undefined,
    autopilotState: "unknown",
    batteryPercent: typeof charge.usable_battery_level === "number" ? charge.usable_battery_level : undefined,
    coordinates: typeof lat === "number" && typeof lon === "number" ? { lat, lon } : undefined
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run packages/telemetry/src/index.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/telemetry/src/index.ts packages/telemetry/src/index.test.ts
git commit -m "feat(telemetry): fix mph speed unit + add normalizeFleetVehicleData"
```

---

## Task 2: Coarse reverse-geocoder

**Files:**
- Create: `apps/api/src/telemetry/geocoder.ts`
- Test: `apps/api/test/geocoder.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/geocoder.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { coarseRegionFor, makeGeocoder } from "../src/telemetry/geocoder.js";

describe("coarse reverse-geocoder", () => {
  it("returns a coarse region string from a reverse-geocode response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ address: { state: "Bavaria", country: "Germany" } }), { status: 200 });
    const region = await coarseRegionFor(48.137, 11.575, { fetchImpl, baseUrl: "https://geo.test/reverse" });
    expect(region).toBe("Bavaria, Germany");
  });

  it("caches by rounded coordinates so nearby points do not refetch", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ address: { state: "Bavaria", country: "Germany" } }), { status: 200 });
    };
    const geocode = makeGeocoder({ fetchImpl, baseUrl: "https://geo.test/reverse" });
    await geocode(48.137, 11.575);
    await geocode(48.139, 11.571); // within ~0.1° → same cache bucket
    expect(calls).toBe(1);
  });

  it("returns undefined on error instead of throwing", async () => {
    const fetchImpl: typeof fetch = async () => new Response("nope", { status: 500 });
    const region = await coarseRegionFor(1, 2, { fetchImpl, baseUrl: "https://geo.test/reverse" });
    expect(region).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/api/test/geocoder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the geocoder**

Create `apps/api/src/telemetry/geocoder.ts`:

```ts
export interface GeocoderOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";

/** Rounds to ~0.1° (~11 km) so a coarse area maps to one cache bucket. */
function bucket(lat: number, lon: number): string {
  return `${lat.toFixed(1)},${lon.toFixed(1)}`;
}

function regionFromAddress(address: Record<string, unknown> | undefined): string | undefined {
  if (!address) return undefined;
  const area =
    (address.state as string) ||
    (address.region as string) ||
    (address.county as string) ||
    (address.city as string) ||
    (address.town as string);
  const country = address.country as string | undefined;
  if (area && country) return `${area}, ${country}`;
  return area || country || undefined;
}

/** One-shot reverse geocode → coarse region (e.g. "Bavaria, Germany"); undefined on any error. */
export async function coarseRegionFor(lat: number, lon: number, options: GeocoderOptions = {}): Promise<string | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? NOMINATIM_REVERSE;
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("zoom", "8");
    const response = await fetchImpl(url, {
      headers: { "User-Agent": "AIJourneyDJ/1.0 (single-user journey soundtrack)" },
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { address?: Record<string, unknown> };
    return regionFromAddress(payload.address);
  } catch {
    return undefined;
  }
}

/** Builds a cached geocoder: nearby coordinates (same ~0.1° bucket) reuse the first result. */
export function makeGeocoder(options: GeocoderOptions = {}): (lat: number, lon: number) => Promise<string | undefined> {
  const cache = new Map<string, string | undefined>();
  return async (lat: number, lon: number) => {
    const key = bucket(lat, lon);
    if (cache.has(key)) return cache.get(key);
    const region = await coarseRegionFor(lat, lon, options);
    cache.set(key, region);
    return region;
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run apps/api/test/geocoder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/telemetry/geocoder.ts apps/api/test/geocoder.test.ts
git commit -m "feat(api): coarse reverse-geocoder with rounded-coordinate cache"
```

---

## Task 3: Tesla env config

**Files:**
- Modify: `apps/api/src/config/env.ts`

- [ ] **Step 1: Add the Tesla env vars to the schema**

In `apps/api/src/config/env.ts`, add inside the `z.object({ ... })` schema (after the `LISTENBRAINZ_BASE_URL` line, before `TESLA_TELEMETRY_ENABLED`):

```ts
  TESLA_FLEET_ENABLED: envBoolean(false),
  TESLA_CLIENT_ID: z.string().optional(),
  TESLA_CLIENT_SECRET: z.string().optional(),
  TESLA_OAUTH_AUTH_URL: z.string().url().default("https://auth.tesla.com/oauth2/v3/authorize"),
  TESLA_OAUTH_TOKEN_URL: z.string().url().default("https://auth.tesla.com/oauth2/v3/token"),
  TESLA_API_BASE_URL: z.string().url().default("https://fleet-api.prd.eu.vn.cloud.tesla.com"),
  TESLA_REDIRECT_URI: z.string().url().default("http://localhost:3000/auth/tesla/callback"),
  TESLA_PUBLIC_KEY_PEM: z.string().default(""),
  TESLA_VEHICLE_ID: z.string().optional(),
  TESLA_POLL_SECONDS: z.coerce.number().int().min(10).default(45),
  GEOCODER_URL: z.string().url().default("https://nominatim.openstreetmap.org/reverse"),
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck -w @ai-journey-dj/api`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/config/env.ts
git commit -m "feat(api): Tesla Fleet API env configuration"
```

---

## Task 4: `TeslaAuthService` (OAuth + encrypted tokens)

**Files:**
- Create: `apps/api/src/auth/teslaAuth.ts`
- Test: `apps/api/test/tesla.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/tesla.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/env.js";
import { migrate, openDatabase } from "../src/db/database.js";
import { Store } from "../src/db/store.js";
import { TeslaAuthService } from "../src/auth/teslaAuth.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function build(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-tesla-"));
  tmpDirs.push(dir);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TESLA_CLIENT_ID: "tesla-client",
    TESLA_REDIRECT_URI: "https://dj.example.com/auth/tesla/callback",
    ...overrides
  });
  const db = openDatabase(config.DATABASE_PATH);
  migrate(db);
  return { config, store: new Store(db) };
}

describe("TeslaAuthService", () => {
  it("builds an OAuth login URL with the required scopes + PKCE", () => {
    const { config, store } = build();
    const service = new TeslaAuthService(config, store);
    const url = new URL(service.createLoginUrl());

    expect(url.origin + url.pathname).toBe("https://auth.tesla.com/oauth2/v3/authorize");
    expect(url.searchParams.get("client_id")).toBe("tesla-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://dj.example.com/auth/tesla/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid offline_access vehicle_device_data vehicle_location");
  });

  it("refreshes an expired access token using the stored refresh token", async () => {
    const { config, store } = build();
    const service = new TeslaAuthService(config, store);
    // Seed an expired credential.
    service.persistForTest({ accessToken: "old", refreshToken: "r1", expiresAtIso: new Date(Date.now() - 1000).toISOString() });

    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ access_token: "fresh", refresh_token: "r2", expires_in: 28800 }), { status: 200 });
    service.setFetchForTest(fetchImpl);

    expect(await service.getAccessToken()).toBe("fresh");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/api/test/tesla.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `TeslaAuthService`**

Create `apps/api/src/auth/teslaAuth.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

import { decryptJson, encryptJson } from "@ai-journey-dj/crypto";

import type { AppConfig } from "../config/env.js";
import type { StoredCredentials, Store } from "../db/store.js";

export const TESLA_SCOPES = ["openid", "offline_access", "vehicle_device_data", "vehicle_location"] as const;

export class TeslaAuthService {
  private fetchImpl: typeof fetch = fetch;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store
  ) {}

  /** Test seam. */
  setFetchForTest(fetchImpl: typeof fetch): void {
    this.fetchImpl = fetchImpl;
  }

  /** Test seam: seed credentials directly. */
  persistForTest(credentials: StoredCredentials): void {
    this.store.saveCredentials("tesla", encryptJson(credentials, this.config.APP_SECRET));
  }

  createLoginUrl(): string {
    if (!this.config.TESLA_CLIENT_ID) {
      throw new Error("TESLA_CLIENT_ID is required for Tesla auth.");
    }
    const state = randomBytes(18).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
    this.store.saveOauthState(`tesla:${state}`, codeVerifier);

    const url = new URL(this.config.TESLA_OAUTH_AUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.TESLA_CLIENT_ID);
    url.searchParams.set("redirect_uri", this.config.TESLA_REDIRECT_URI);
    url.searchParams.set("scope", TESLA_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async completeCallback(query: { code?: string; state?: string }): Promise<void> {
    if (!query.code || !query.state) {
      throw new Error("Tesla callback is missing code or state.");
    }
    const codeVerifier = this.store.consumeOauthState(`tesla:${query.state}`);
    if (!codeVerifier) {
      throw new Error("Invalid or expired Tesla OAuth state.");
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.TESLA_CLIENT_ID ?? "",
      code: query.code,
      redirect_uri: this.config.TESLA_REDIRECT_URI,
      code_verifier: codeVerifier
    });
    if (this.config.TESLA_CLIENT_SECRET) {
      form.set("client_secret", this.config.TESLA_CLIENT_SECRET);
    }
    const token = await this.exchange(form);
    this.save(token);
  }

  isConnected(): boolean {
    return Boolean(this.getCredentials());
  }

  disconnect(): void {
    this.store.deleteCredentials("tesla");
  }

  async getAccessToken(): Promise<string> {
    const credentials = this.getCredentials();
    if (!credentials) {
      throw new Error("Tesla is not connected.");
    }
    const expiresSoon =
      credentials.expiresAtIso && new Date(credentials.expiresAtIso).getTime() - Date.now() < 120_000;
    if (expiresSoon) {
      if (!credentials.refreshToken) {
        throw new Error("Tesla token expired and no refresh token is available.");
      }
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.config.TESLA_CLIENT_ID ?? "",
        refresh_token: credentials.refreshToken
      });
      if (this.config.TESLA_CLIENT_SECRET) {
        form.set("client_secret", this.config.TESLA_CLIENT_SECRET);
      }
      const token = await this.exchange(form);
      return this.save(token, credentials.refreshToken).accessToken;
    }
    return credentials.accessToken;
  }

  /** Partner (client-credentials) token for one-time partner-account registration. */
  async getPartnerToken(): Promise<string> {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.TESLA_CLIENT_ID ?? "",
      client_secret: this.config.TESLA_CLIENT_SECRET ?? "",
      scope: "openid vehicle_device_data vehicle_location",
      audience: this.config.TESLA_API_BASE_URL
    });
    const token = await this.exchange(form);
    return token.access_token;
  }

  private getCredentials(): StoredCredentials | undefined {
    const encrypted = this.store.getEncryptedCredentials("tesla");
    return encrypted ? decryptJson<StoredCredentials>(encrypted, this.config.APP_SECRET) : undefined;
  }

  private save(
    token: { access_token: string; refresh_token?: string; expires_in?: number },
    fallbackRefresh?: string
  ): StoredCredentials {
    const credentials: StoredCredentials = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? fallbackRefresh,
      expiresAtIso: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined
    };
    this.store.saveCredentials("tesla", encryptJson(credentials, this.config.APP_SECRET));
    return credentials;
  }

  private async exchange(form: URLSearchParams): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const response = await this.fetchImpl(this.config.TESLA_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Tesla token request failed with ${response.status}: ${details}`);
    }
    return (await response.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run apps/api/test/tesla.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/teslaAuth.ts apps/api/test/tesla.test.ts
git commit -m "feat(api): TeslaAuthService OAuth + encrypted token storage"
```

---

## Task 5: App routes + public key + partner registration

**Files:**
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/tesla.test.ts`

- [ ] **Step 1: Write the failing route tests**

Append to `apps/api/test/tesla.test.ts`:

```ts
import { buildApp } from "../src/app.js";

describe("tesla routes", () => {
  it("redirects /auth/tesla/login to Tesla with the right scopes", async () => {
    const { app } = await buildApp(
      build({ TESLA_CLIENT_ID: "tesla-client", TESLA_REDIRECT_URI: "https://dj.example.com/auth/tesla/callback" }).config
    );
    const res = await app.inject({ method: "GET", url: "/auth/tesla/login" });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin).toBe("https://auth.tesla.com");
    expect(url.searchParams.get("scope")).toBe("openid offline_access vehicle_device_data vehicle_location");
    await app.close();
  });

  it("serves the Tesla public key at the well-known path", async () => {
    const { app } = await buildApp(build({ TESLA_PUBLIC_KEY_PEM: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----" }).config);
    const res = await app.inject({ method: "GET", url: "/.well-known/appspecific/com.tesla.3p.public-key.pem" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("BEGIN PUBLIC KEY");
    await app.close();
  });
});
```

(Note: `build` is the helper already defined at the top of this file; it returns `{ config, store }`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/api/test/tesla.test.ts -t "tesla routes"`
Expected: FAIL — routes 404.

- [ ] **Step 3: Construct `TeslaAuthService` and register routes in `buildApp`**

In `apps/api/src/app.ts`, add the import near the other auth imports:

```ts
import { TeslaAuthService } from "./auth/teslaAuth.js";
```

After the line `const spotifyAuth = new SpotifyAuthService(config, store);`, add:

```ts
  const teslaAuth = new TeslaAuthService(config, store);
```

Add these routes just after the existing `app.post("/auth/tesla/disconnect", ...)` is — there is none yet, so add the whole Tesla block right after the Spotify auth routes block (after `app.post("/auth/spotify/disconnect", ...)`):

```ts
  app.get("/.well-known/appspecific/com.tesla.3p.public-key.pem", async (_request, reply) => {
    if (!config.TESLA_PUBLIC_KEY_PEM) {
      return reply.code(404).send("Tesla public key not configured.");
    }
    return reply.type("application/x-pem-file").send(config.TESLA_PUBLIC_KEY_PEM);
  });

  app.get("/auth/tesla/login", async (request, reply) => {
    const returnBase = appBaseUrl(request, config);
    try {
      return reply.redirect(teslaAuth.createLoginUrl());
    } catch (error) {
      const message = encodeURIComponent(error instanceof Error ? error.message : String(error));
      return reply.redirect(`${returnBase}/?tesla=error&message=${message}`);
    }
  });

  app.get("/auth/tesla/callback", async (request, reply) => {
    const returnBase = appBaseUrl(request, config);
    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (query.error) {
      const message = encodeURIComponent(query.error_description ?? query.error);
      return reply.redirect(`${returnBase}/?tesla=error&message=${message}`);
    }
    try {
      await teslaAuth.completeCallback(query);
    } catch (error) {
      const message = encodeURIComponent(error instanceof Error ? error.message : String(error));
      return reply.redirect(`${returnBase}/?tesla=error&message=${message}`);
    }
    return reply.type("text/html").send(`<!doctype html>
      <html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${returnBase}/?tesla=connected"></head>
      <body><a href="${returnBase}/?tesla=connected">Return to AI Journey DJ</a></body></html>`);
  });

  app.post("/auth/tesla/disconnect", async () => {
    teslaAuth.disconnect();
    return { ok: true };
  });

  app.post("/auth/tesla/register-partner", async (_request, reply) => {
    try {
      const token = await teslaAuth.getPartnerToken();
      const domain = new URL(config.API_BASE_URL).host;
      const response = await fetch(`${config.TESLA_API_BASE_URL.replace(/\/$/, "")}/api/1/partner_accounts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ domain })
      });
      const body = await response.text();
      return reply.code(response.ok ? 200 : 502).send({ ok: response.ok, status: response.status, body });
    } catch (error) {
      return reply.code(500).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
```

Change the `buildApp` return to expose `teslaAuth`. Find:

```ts
  return { app, store, journeyService };
```

Replace with:

```ts
  return { app, store, journeyService, teslaAuth };
```

- [ ] **Step 4: Run the route tests to verify they pass**

Run: `./node_modules/.bin/vitest run apps/api/test/tesla.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/test/tesla.test.ts
git commit -m "feat(api): Tesla OAuth routes, public-key endpoint, partner registration"
```

---

## Task 6: Fleet poller + bootstrap

**Files:**
- Create: `apps/api/src/telemetry/teslaFleetPoller.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/test/tesla.test.ts`

- [ ] **Step 1: Write the failing poller test**

Append to `apps/api/test/tesla.test.ts`:

```ts
import { pollTeslaOnce } from "../src/telemetry/teslaFleetPoller.js";

describe("tesla fleet poller (single tick)", () => {
  function fakeDeps(vehicleState: string, hasActiveJourney: boolean) {
    const ingested: unknown[] = [];
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/vehicles/") && url.includes("vehicle_data")) {
        return new Response(
          JSON.stringify({ response: { vin: "VIN1", drive_state: { speed: 60 }, charge_state: { usable_battery_level: 50 }, climate_state: { outside_temp: 20 } } }),
          { status: 200 }
        );
      }
      if (url.includes("/vehicles")) {
        return new Response(JSON.stringify({ response: [{ id: 1, id_s: "1", state: vehicleState }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    return { ingested, calls, fetchImpl };
  }

  it("does not call vehicle_data when there is no active journey", async () => {
    const { ingested, calls, fetchImpl } = fakeDeps("online", false);
    await pollTeslaOnce({
      apiBaseUrl: "https://fleet.test",
      accessToken: "t",
      vehicleId: undefined,
      hasActiveJourney: () => false,
      ingest: async (event) => { ingested.push(event); },
      geocode: async () => undefined,
      appSecret: "s",
      fetchImpl
    });
    expect(calls.some((u) => u.includes("vehicle_data"))).toBe(false);
    expect(ingested).toHaveLength(0);
  });

  it("does not call vehicle_data when the vehicle is asleep", async () => {
    const { ingested, calls, fetchImpl } = fakeDeps("asleep", true);
    await pollTeslaOnce({
      apiBaseUrl: "https://fleet.test",
      accessToken: "t",
      vehicleId: undefined,
      hasActiveJourney: () => true,
      ingest: async (event) => { ingested.push(event); },
      geocode: async () => undefined,
      appSecret: "s",
      fetchImpl
    });
    expect(calls.some((u) => u.includes("vehicle_data"))).toBe(false);
    expect(ingested).toHaveLength(0);
  });

  it("ingests normalized telemetry when online with an active journey", async () => {
    const { ingested, fetchImpl } = fakeDeps("online", true);
    await pollTeslaOnce({
      apiBaseUrl: "https://fleet.test",
      accessToken: "t",
      vehicleId: undefined,
      hasActiveJourney: () => true,
      ingest: async (event) => { ingested.push(event); },
      geocode: async () => "Bavaria, Germany",
      appSecret: "s",
      fetchImpl
    });
    expect(ingested).toHaveLength(1);
    expect((ingested[0] as { speedKph?: number }).speedKph).toBe(97);
    expect((ingested[0] as { coarseRegion?: string }).coarseRegion).toBe("Bavaria, Germany");
    // Raw coordinates must not leak into the ingested event.
    expect((ingested[0] as Record<string, unknown>).coordinates).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/api/test/tesla.test.ts -t "fleet poller"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the poller**

Create `apps/api/src/telemetry/teslaFleetPoller.ts`:

```ts
import type { NormalizedTelemetryEvent } from "@ai-journey-dj/core";
import { normalizeFleetVehicleData } from "@ai-journey-dj/telemetry";

import type { AppConfig } from "../config/env.js";
import type { SpotifyAuthService } from "../auth/spotifyAuth.js";
import type { TeslaAuthService } from "../auth/teslaAuth.js";
import type { JourneyService } from "../journeys/journeyService.js";
import type { Store } from "../db/store.js";
import { makeGeocoder } from "./geocoder.js";

export interface PollDeps {
  apiBaseUrl: string;
  accessToken: string;
  vehicleId?: string;
  hasActiveJourney: () => boolean;
  ingest: (event: NormalizedTelemetryEvent) => Promise<void>;
  geocode: (lat: number, lon: number) => Promise<string | undefined>;
  appSecret: string;
  fetchImpl: typeof fetch;
}

/** A single poll tick. Returns silently when it should not (or cannot) read vehicle data. */
export async function pollTeslaOnce(deps: PollDeps): Promise<void> {
  if (!deps.hasActiveJourney()) return;

  const auth = { Authorization: `Bearer ${deps.accessToken}` };
  const base = deps.apiBaseUrl.replace(/\/$/, "");

  // Resolve the vehicle id + online state without waking the car.
  const listResponse = await deps.fetchImpl(`${base}/api/1/vehicles`, { headers: auth });
  if (!listResponse.ok) return;
  const list = (await listResponse.json()) as { response?: Array<{ id_s?: string; id?: number; state?: string }> };
  const vehicles = list.response ?? [];
  const vehicle = deps.vehicleId ? vehicles.find((v) => v.id_s === deps.vehicleId) : vehicles[0];
  if (!vehicle || vehicle.state !== "online") return; // asleep/offline → never force-wake

  const id = vehicle.id_s ?? String(vehicle.id);
  const dataResponse = await deps.fetchImpl(
    `${base}/api/1/vehicles/${id}/vehicle_data?endpoints=${encodeURIComponent("drive_state;charge_state;climate_state")}`,
    { headers: auth }
  );
  if (!dataResponse.ok) return; // 408 asleep etc.

  const payload = (await dataResponse.json()) as { response?: Record<string, unknown> };
  const { coordinates, ...event } = normalizeFleetVehicleData(payload.response ?? {}, deps.appSecret);
  if (coordinates) {
    event.coarseRegion = await deps.geocode(coordinates.lat, coordinates.lon);
  }
  await deps.ingest(event);
}

export function startTeslaFleetPoller(
  config: AppConfig,
  store: Store,
  teslaAuth: TeslaAuthService,
  journeyService: JourneyService,
  logger: { warn: (obj: Record<string, unknown>, msg?: string) => void }
): NodeJS.Timeout | undefined {
  if (!config.TESLA_FLEET_ENABLED) return undefined;
  const geocode = makeGeocoder({ baseUrl: config.GEOCODER_URL });

  const tick = async () => {
    try {
      if (store.listActiveJourneys().length === 0) return;
      const accessToken = await teslaAuth.getAccessToken();
      await pollTeslaOnce({
        apiBaseUrl: config.TESLA_API_BASE_URL,
        accessToken,
        vehicleId: config.TESLA_VEHICLE_ID,
        hasActiveJourney: () => store.listActiveJourneys().length > 0,
        ingest: (event) => journeyService.ingestTelemetry(event),
        geocode,
        appSecret: config.APP_SECRET,
        fetchImpl: fetch
      });
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, "tesla.poll_error");
    }
  };

  return setInterval(() => void tick(), config.TESLA_POLL_SECONDS * 1000);
}

// (SpotifyAuthService import kept type-only elsewhere; not used here.)
export type { SpotifyAuthService };
```

(Drop the trailing `SpotifyAuthService` re-export + import if your linter flags it; it is only there to avoid an unused-import error if a future edit references it. If lint complains, remove both the import and the `export type` line.)

- [ ] **Step 4: Run the poller tests to verify they pass**

Run: `./node_modules/.bin/vitest run apps/api/test/tesla.test.ts`
Expected: PASS (all Tesla tests).

- [ ] **Step 5: Wire the poller into the server bootstrap**

In `apps/api/src/index.ts`, add the import:

```ts
import { startTeslaFleetPoller } from "./telemetry/teslaFleetPoller.js";
```

Change the destructure of `buildApp` to capture `teslaAuth` + `store`:

```ts
const { app, store, journeyService, teslaAuth } = await buildApp(config);
```

After the existing `startTelemetryConsumer(...)` call, add:

```ts
const teslaPoller = startTeslaFleetPoller(config, store, teslaAuth, journeyService, app.log);
```

In the `SIGTERM` handler, clear it alongside the worker:

```ts
process.on("SIGTERM", async () => {
  clearInterval(worker);
  if (teslaPoller) clearInterval(teslaPoller);
  await app.close();
});
```

- [ ] **Step 6: Verify typecheck + full file tests**

Run: `npm run typecheck -w @ai-journey-dj/api && ./node_modules/.bin/vitest run apps/api/test/tesla.test.ts`
Expected: exit 0; all Tesla tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/telemetry/teslaFleetPoller.ts apps/api/src/index.ts apps/api/test/tesla.test.ts
git commit -m "feat(api): env-gated Tesla Fleet poller wired into server bootstrap"
```

---

## Task 7: `.env.example` + deployment / onboarding doc

**Files:**
- Create: `.env.example`
- Create: `docs/deployment.md`

- [ ] **Step 1: Write `.env.example`**

Create `.env.example`:

```bash
# --- Core ---
NODE_ENV=production
API_BASE_URL=https://dj.example.com
APP_BASE_URL=https://dj.example.com
CORS_ORIGIN=https://dj.example.com
APP_SECRET=change-me-to-a-long-random-string
DATABASE_PATH=/data/ai-journey-dj.db

# --- Spotify (Premium; reconnect after scope changes) ---
SPOTIFY_MOCK=false
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REDIRECT_URI=https://dj.example.com/auth/spotify/callback

# --- AI song scout (Gemini) ---
XAI_MOCK=false
SONG_SCOUT=multilens
GEMINI_API_KEY=

# --- Tesla Fleet API (EU region, read-only polling) ---
TESLA_FLEET_ENABLED=true
TESLA_CLIENT_ID=
TESLA_CLIENT_SECRET=
TESLA_API_BASE_URL=https://fleet-api.prd.eu.vn.cloud.tesla.com
TESLA_REDIRECT_URI=https://dj.example.com/auth/tesla/callback
TESLA_PUBLIC_KEY_PEM=
TESLA_POLL_SECONDS=45
# Optional: pin a specific vehicle (else first vehicle is used)
# TESLA_VEHICLE_ID=
GEOCODER_URL=https://nominatim.openstreetmap.org/reverse
```

- [ ] **Step 2: Write `docs/deployment.md`**

Create `docs/deployment.md`:

```markdown
# Production Deployment + Tesla Fleet Onboarding

## 1. Host
- Deploy API + web behind your domain with TLS (the Tesla in-car browser + Spotify Web Playback + OAuth all require HTTPS).
- Mount a persistent volume for `DATABASE_PATH`.
- Copy `.env.example` → `.env` and fill every value.

## 2. Spotify
- Register `https://<domain>/auth/spotify/callback` in the Spotify dashboard.
- Set `SPOTIFY_MOCK=false` + client id/secret. Premium account required.
- Open the app, click Connect Spotify, and re-authorize (the app added the `user-top-read` and `playlist-modify-private` scopes).

## 3. Gemini
- Set `XAI_MOCK=false` and a real `GEMINI_API_KEY`.

## 4. Tesla developer app (EU)
1. Create an app at developer.tesla.com → set `TESLA_CLIENT_ID` / `TESLA_CLIENT_SECRET`.
2. OAuth redirect URI: `https://<domain>/auth/tesla/callback`. Scopes: `vehicle_device_data`, `vehicle_location`.
3. Generate an EC key pair: `openssl ecparam -name prime256v1 -genkey -noout -out tesla-private.pem && openssl ec -in tesla-private.pem -pubout -out tesla-public.pem`. Put the **public** PEM contents into `TESLA_PUBLIC_KEY_PEM` (keep the private key secret).
4. Verify it serves: `GET https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`.
5. Register the partner account once: `curl -XPOST https://<domain>/auth/tesla/register-partner` (the app fetches a partner token and registers your domain with the EU Fleet API).
6. Connect the car: open `https://<domain>/auth/tesla/login`, sign in with your Tesla account, approve.

## 5. Turn on polling
- `TESLA_FLEET_ENABLED=true`, `TESLA_POLL_SECONDS=45`.
- The poller only reads `vehicle_data` while a journey is active **and** the car is `online` — it never wakes a sleeping car.
- Privacy: raw GPS is only used transiently to derive a coarse region (e.g. "Bavaria, Germany"); it is never stored or sent to the AI.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example docs/deployment.md
git commit -m "docs: production .env example + Tesla Fleet onboarding guide"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck all workspaces**

Run: `npm run typecheck --workspaces`
Expected: exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `./node_modules/.bin/vitest run`
Expected: all files pass (existing 87 + 4 telemetry + 3 geocoder + ~8 tesla = ~102), 0 failures.

- [ ] **Step 3: Lint changed files**

Run:
```bash
npx eslint packages/telemetry/src/index.ts apps/api/src/auth/teslaAuth.ts apps/api/src/telemetry/geocoder.ts apps/api/src/telemetry/teslaFleetPoller.ts apps/api/src/app.ts apps/api/src/index.ts apps/api/src/config/env.ts
```
Expected: `No issues found`.

- [ ] **Step 4: Commit any lint fixes (only if Step 3 required changes)**

```bash
git add -A
git commit -m "chore: lint cleanup for Tesla Fleet integration"
```

---

## Self-Review Notes

- **Spec coverage:** §1 onboarding (Task 5 partner-register + public-key route + Task 7 doc), §2 auth (Task 4 + routes Task 5), §3 poller (Task 6), §4 mapping + speed fix + geocoder (Tasks 1-2), §5 config/deploy/tests (Tasks 3, 7, 8). All covered.
- **Type consistency:** `normalizeFleetVehicleData` (Task 1) returns `FleetTelemetryResult` with `coordinates`, consumed by the poller (Task 6) which strips it before ingest. `TeslaAuthService` methods (`createLoginUrl`, `getAccessToken`, `getPartnerToken`, `completeCallback`, `disconnect`) defined in Task 4 and used in Tasks 5-6. `makeGeocoder`/`coarseRegionFor` (Task 2) used in Task 6. `buildApp` return gains `teslaAuth` (Task 5) consumed in Task 6.
- **Privacy:** raw lat/lon only travels as the transient `coordinates` field, stripped in the poller before `ingest`; tests assert it never lands on the event.
- **Battery safety:** `pollTeslaOnce` returns before `vehicle_data` unless active journey + `state === "online"`; tested.
- **No placeholders.** (The poller file's trailing `SpotifyAuthService` re-export is explicitly flagged as removable if lint objects; remove it during Task 6 if so — it carries no behavior.)
```
