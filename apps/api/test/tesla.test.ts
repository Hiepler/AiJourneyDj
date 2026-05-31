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
