import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-wish-api-"));
  tmpDirs.push(dir);
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "true",
    CORS_ORIGIN: "http://localhost:5173",
  });
}

describe("music wish routes", () => {
  it("creates an active wish and includes it in journey detail", async () => {
    const { app } = await buildApp(testConfig());
    const journeyResponse = await app.inject({
      method: "POST",
      url: "/journeys",
      payload: {
        destination: "Lago di Garda",
        userPrompt: "bright road trip",
        passengerMode: "family",
        provider: "spotify",
        deviceId: "mock-webplayer",
      },
    });
    const journey = journeyResponse.json<{ id: string }>();

    const wishResponse = await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/music-wishes`,
      payload: { text: "mehr Taylor Swift", source: "text" },
    });

    expect(wishResponse.statusCode).toBe(201);
    expect(wishResponse.json()).toMatchObject({
      wish: {
        rawText: "mehr Taylor Swift",
        status: "active",
        summary: "Mehr Taylor Swift",
      },
    });

    const detail = await app.inject({ method: "GET", url: `/journeys/${journey.id}` });
    expect(detail.json().activeMusicWishes).toEqual([
      expect.objectContaining({ summary: "Mehr Taylor Swift", status: "active" }),
    ]);

    await app.close();
  });

  it("pins and undoes wishes", async () => {
    const { app } = await buildApp(testConfig());
    const journey = (await app.inject({
      method: "POST",
      url: "/journeys",
      payload: { destination: "Dijon", userPrompt: "drive", passengerMode: "solo", provider: "spotify" },
    })).json<{ id: string }>();
    const created = (await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/music-wishes`,
      payload: { text: "was zum Mitsingen", source: "chip" },
    })).json<{ wish: { id: string } }>();

    const patched = await app.inject({
      method: "PATCH",
      url: `/journeys/${journey.id}/music-wishes/${created.wish.id}`,
      payload: { pinned: true },
    });
    expect(patched.json()).toMatchObject({ pinned: true });

    const undone = await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/music-wishes/${created.wish.id}/undo`,
    });
    expect(undone.json()).toMatchObject({ status: "undone" });

    await app.close();
  });
});
