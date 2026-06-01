import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { makeVehicleIdResolver, pollTeslaOnce } from "../src/telemetry/teslaFleetPoller.js";
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
    const { app } = await buildApp(
      build({ TESLA_PUBLIC_KEY_PEM: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----" }).config
    );
    const res = await app.inject({ method: "GET", url: "/.well-known/appspecific/com.tesla.3p.public-key.pem" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("BEGIN PUBLIC KEY");
    await app.close();
  });
});

describe("tesla fleet poller (single tick)", () => {
  // online=200 vehicle_data; asleep=408 (vehicle_data does not wake the car).
  function fakeDeps(vehicleState: "online" | "asleep") {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/vehicles/") && url.includes("vehicle_data")) {
        if (vehicleState === "asleep") return new Response("{}", { status: 408 });
        return new Response(
          JSON.stringify({
            response: {
              vin: "VIN1",
              drive_state: { speed: 60, latitude: 48.137, longitude: 11.575 },
              charge_state: { usable_battery_level: 50 },
              climate_state: { outside_temp: 20 }
            }
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    };
    return { calls, fetchImpl };
  }

  it("does not call vehicle_data when there is no active journey", async () => {
    const ingested: unknown[] = [];
    const { calls, fetchImpl } = fakeDeps("online");
    await pollTeslaOnce({
      apiBaseUrl: "https://fleet.test",
      accessToken: "t",
      resolveVehicleId: async () => "1",
      hasActiveJourney: () => false,
      ingest: async (event) => void ingested.push(event),
      geocode: async () => undefined,
      appSecret: "s",
      fetchImpl
    });
    expect(calls).toHaveLength(0);
    expect(ingested).toHaveLength(0);
  });

  it("does not ingest when the vehicle is asleep (408), without waking it", async () => {
    const ingested: unknown[] = [];
    const { fetchImpl } = fakeDeps("asleep");
    await pollTeslaOnce({
      apiBaseUrl: "https://fleet.test",
      accessToken: "t",
      resolveVehicleId: async () => "1",
      hasActiveJourney: () => true,
      ingest: async (event) => void ingested.push(event),
      geocode: async () => undefined,
      appSecret: "s",
      fetchImpl
    });
    expect(ingested).toHaveLength(0);
  });

  it("ingests telemetry online with exactly ONE request (no per-tick vehicle-list call)", async () => {
    const ingested: unknown[] = [];
    const { calls, fetchImpl } = fakeDeps("online");
    await pollTeslaOnce({
      apiBaseUrl: "https://fleet.test",
      accessToken: "t",
      resolveVehicleId: async () => "1",
      hasActiveJourney: () => true,
      ingest: async (event) => void ingested.push(event),
      geocode: async () => "Bavaria, Germany",
      appSecret: "s",
      fetchImpl
    });
    expect(ingested).toHaveLength(1);
    expect((ingested[0] as { speedKph?: number }).speedKph).toBe(97);
    expect((ingested[0] as { coarseRegion?: string }).coarseRegion).toBe("Bavaria, Germany");
    // Cost guard: a tick must hit only vehicle_data — never the billed /api/1/vehicles list.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("vehicle_data");
    expect(calls.some((u) => u.endsWith("/api/1/vehicles"))).toBe(false);
  });
});

describe("makeVehicleIdResolver (cost: discover once, then cache)", () => {
  it("returns a configured id without any API call", async () => {
    const calls: string[] = [];
    const resolve = makeVehicleIdResolver({
      apiBaseUrl: "https://fleet.test",
      configuredVehicleId: "VID",
      getAccessToken: async () => "t",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response("{}", { status: 200 });
      }
    });
    expect(await resolve()).toBe("VID");
    expect(calls).toHaveLength(0);
  });

  it("discovers the id once via the list, then caches it (no second list call)", async () => {
    const calls: string[] = [];
    const resolve = makeVehicleIdResolver({
      apiBaseUrl: "https://fleet.test",
      configuredVehicleId: undefined,
      getAccessToken: async () => "t",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ response: [{ id: 7, id_s: "7" }] }), { status: 200 });
      }
    });
    expect(await resolve()).toBe("7");
    expect(await resolve()).toBe("7");
    expect(calls).toHaveLength(1); // discovered once, cached thereafter
  });
});
