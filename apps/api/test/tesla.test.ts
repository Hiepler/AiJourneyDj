import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { pollTeslaOnce } from "../src/telemetry/teslaFleetPoller.js";
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
  function fakeDeps(vehicleState: string) {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/vehicles/") && url.includes("vehicle_data")) {
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
      if (url.includes("/vehicles")) {
        return new Response(JSON.stringify({ response: [{ id: 1, id_s: "1", state: vehicleState }] }), { status: 200 });
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
      vehicleId: undefined,
      hasActiveJourney: () => false,
      ingest: async (event) => void ingested.push(event),
      geocode: async () => undefined,
      appSecret: "s",
      fetchImpl
    });
    expect(calls.some((u) => u.includes("vehicle_data"))).toBe(false);
    expect(ingested).toHaveLength(0);
  });

  it("does not call vehicle_data when the vehicle is asleep", async () => {
    const ingested: unknown[] = [];
    const { calls, fetchImpl } = fakeDeps("asleep");
    await pollTeslaOnce({
      apiBaseUrl: "https://fleet.test",
      accessToken: "t",
      vehicleId: undefined,
      hasActiveJourney: () => true,
      ingest: async (event) => void ingested.push(event),
      geocode: async () => undefined,
      appSecret: "s",
      fetchImpl
    });
    expect(calls.some((u) => u.includes("vehicle_data"))).toBe(false);
    expect(ingested).toHaveLength(0);
  });

  it("ingests normalized telemetry when online with an active journey", async () => {
    const ingested: unknown[] = [];
    const { fetchImpl } = fakeDeps("online");
    await pollTeslaOnce({
      apiBaseUrl: "https://fleet.test",
      accessToken: "t",
      vehicleId: undefined,
      hasActiveJourney: () => true,
      ingest: async (event) => void ingested.push(event),
      geocode: async () => "Bavaria, Germany",
      appSecret: "s",
      fetchImpl
    });
    expect(ingested).toHaveLength(1);
    expect((ingested[0] as { speedKph?: number }).speedKph).toBe(97);
    expect((ingested[0] as { coarseRegion?: string }).coarseRegion).toBe("Bavaria, Germany");
    expect((ingested[0] as Record<string, unknown>).coordinates).toBeUndefined();
  });
});
