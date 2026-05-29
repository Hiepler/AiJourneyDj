import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-"));
  tmpDirs.push(dir);
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    XAI_MOCK: "true",
    CORS_ORIGIN: "http://localhost:5173"
  });
}

describe("api", () => {
  it("starts a journey and creates a five-track buffer", async () => {
    const { app } = await buildApp(testConfig());

    const start = await app.inject({
      method: "POST",
      url: "/journeys",
      payload: {
        destination: "Lago di Garda",
        userPrompt: "golden hour drive",
        passengerMode: "couple",
        provider: "tidal"
      }
    });

    expect(start.statusCode).toBe(201);
    const journey = start.json<{ id: string; tidalPlaylistId: string; tidalPlaylistUrl?: string }>();
    expect(journey.tidalPlaylistId).toMatch(/^mock-/);
    expect(journey.tidalPlaylistUrl).toBeUndefined();

    const detail = await app.inject({ method: "GET", url: `/journeys/${journey.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ latestUpdate: { batchSize: number }; tracks: unknown[] }>().latestUpdate.batchSize).toBe(5);
    expect(detail.json<{ tracks: unknown[] }>().tracks.length).toBeGreaterThanOrEqual(5);

    await app.close();
  });
});
