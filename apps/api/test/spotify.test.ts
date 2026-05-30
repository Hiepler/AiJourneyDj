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

function testConfig(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-spotify-"));
  tmpDirs.push(dir);
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "true",
    CORS_ORIGIN: "http://localhost:5173",
    ...overrides
  });
}

describe("spotify api", () => {
  it("exposes Spotify mock auth and Web Playback token status", async () => {
    const { app } = await buildApp(testConfig());

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      spotifyConnected: true,
      spotifyMock: true,
      spotifyPremium: true,
      songScout: {
        provider: "multilens",
        model: "gemini-3.5-flash",
        webSearch: false,
        mock: true
      }
    });

    const token = await app.inject({ method: "GET", url: "/auth/spotify/token" });
    expect(token.statusCode).toBe(200);
    expect(token.json()).toMatchObject({
      accessToken: "mock-spotify-access-token",
      premium: true
    });

    await app.close();
  });

  it("creates a Spotify journey by default and tracks a five-item future queue", async () => {
    const { app } = await buildApp(testConfig());

    const start = await app.inject({
      method: "POST",
      url: "/journeys",
      payload: {
        destination: "Lago di Garda",
        userPrompt: "golden hour drive",
        passengerMode: "couple",
        deviceId: "tesla-webplayer"
      }
    });

    expect(start.statusCode).toBe(201);
    expect(start.json()).toMatchObject({
      provider: "spotify",
      spotifyDeviceId: "tesla-webplayer"
    });

    const journey = start.json<{ id: string }>();
    const detail = await app.inject({ method: "GET", url: `/journeys/${journey.id}` });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json();
    expect(detailBody).toMatchObject({
      playbackSession: {
        provider: "spotify",
        deviceId: "tesla-webplayer",
        targetBufferSize: 5
      },
      latestUpdate: {
        status: expect.stringMatching(/success|degraded/)
      }
    });
    expect(detailBody.playbackSession?.status).toMatch(/playing|degraded/);
    expect(detailBody.playbackSession?.queuedTrackIds?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(detailBody.tracks.length).toBeGreaterThanOrEqual(5);
    expect(detailBody.tracks.every((track: { provider: string }) => track.provider === "spotify")).toBe(true);

    await app.close();
  });

  it("manually steers the drive phase and re-curates the queue", async () => {
    const { app } = await buildApp(testConfig());

    const start = await app.inject({
      method: "POST",
      url: "/journeys",
      payload: {
        destination: "Dijon",
        userPrompt: "golden hour drive",
        passengerMode: "couple",
        deviceId: "tesla-webplayer"
      }
    });
    const journey = start.json<{ id: string }>();

    const before = await app.inject({ method: "GET", url: `/journeys/${journey.id}` });
    const beforeUpdateId = before.json<{ latestUpdate?: { id: string } }>().latestUpdate?.id;
    expect(beforeUpdateId).toBeDefined();

    const setPhase = await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/phase`,
      payload: { phase: "focus" }
    });
    expect(setPhase.statusCode).toBe(200);
    expect(setPhase.json()).toMatchObject({ phase: "focus" });

    const after = await app.inject({ method: "GET", url: `/journeys/${journey.id}` });
    expect(after.json()).toMatchObject({ journey: { phase: "focus" } });
    // A fresh analysis ran for the new phase.
    expect(after.json<{ latestUpdate?: { id: string } }>().latestUpdate?.id).not.toBe(beforeUpdateId);

    const phaseEvent = await app.inject({ method: "GET", url: `/history/${journey.id}` });
    expect(
      phaseEvent.json<{ events: Array<{ type: string }> }>().events.some((event) => event.type === "phase.manual_override")
    ).toBe(true);

    await app.close();
  });

  it("adjusts the familiarity↔discovery taste mix and re-curates the queue", async () => {
    const { app } = await buildApp(testConfig());

    const start = await app.inject({
      method: "POST",
      url: "/journeys",
      payload: {
        destination: "Dijon",
        userPrompt: "golden hour drive",
        passengerMode: "couple",
        deviceId: "tesla-webplayer"
      }
    });
    const journey = start.json<{ id: string }>();

    const before = await app.inject({ method: "GET", url: `/journeys/${journey.id}` });
    const beforeUpdateId = before.json<{ latestUpdate?: { id: string } }>().latestUpdate?.id;

    const setTaste = await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/taste`,
      payload: { weight: 0.75 }
    });
    expect(setTaste.statusCode).toBe(200);
    expect(setTaste.json<{ tasteWeight: number }>().tasteWeight).toBeCloseTo(0.75);

    const after = await app.inject({ method: "GET", url: `/journeys/${journey.id}` });
    expect(after.json()).toMatchObject({ journey: { tasteWeight: 0.75 } });
    // A fresh analysis ran for the new mix.
    expect(after.json<{ latestUpdate?: { id: string } }>().latestUpdate?.id).not.toBe(beforeUpdateId);

    const events = await app.inject({ method: "GET", url: `/history/${journey.id}` });
    expect(
      events.json<{ events: Array<{ type: string }> }>().events.some((event) => event.type === "taste.weight_set")
    ).toBe(true);

    await app.close();
  });

  it("rejects an out-of-range taste weight", async () => {
    const { app } = await buildApp(testConfig());
    const start = await app.inject({
      method: "POST",
      url: "/journeys",
      payload: { destination: "Dijon", userPrompt: "drive", passengerMode: "solo", deviceId: "dev" }
    });
    const journey = start.json<{ id: string }>();

    const bad = await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/taste`,
      payload: { weight: 1.5 }
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);

    await app.close();
  });

  it("rejects an unknown drive phase", async () => {
    const { app } = await buildApp(testConfig());
    const start = await app.inject({
      method: "POST",
      url: "/journeys",
      payload: { destination: "Dijon", userPrompt: "drive", passengerMode: "solo", deviceId: "dev" }
    });
    const journey = start.json<{ id: string }>();

    const bad = await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/phase`,
      payload: { phase: "party" }
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);

    await app.close();
  });

  it("switches an active Spotify journey to TIDAL fallback playlist mode", async () => {
    const { app } = await buildApp(testConfig());

    const start = await app.inject({
      method: "POST",
      url: "/journeys",
      payload: {
        destination: "Lago di Garda",
        userPrompt: "golden hour drive",
        passengerMode: "couple",
        deviceId: "tesla-webplayer"
      }
    });
    const journey = start.json<{ id: string }>();

    const fallback = await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/fallback/tidal`
    });

    expect(fallback.statusCode).toBe(200);
    expect(fallback.json()).toMatchObject({
      provider: "tidal"
    });
    expect(fallback.json<{ tidalPlaylistId: string }>().tidalPlaylistId).toMatch(/^mock-/);

    const detail = await app.inject({ method: "GET", url: `/journeys/${journey.id}` });
    expect(detail.json()).toMatchObject({
      journey: {
        provider: "tidal"
      },
      playbackSession: {
        provider: "tidal",
        status: "fallback"
      }
    });

    await app.close();
  });

  it("builds Spotify PKCE login URLs with the exact playback scopes", async () => {
    const { app } = await buildApp(
      testConfig({
        SPOTIFY_MOCK: "false",
        SPOTIFY_CLIENT_ID: "spotify-client-id",
        SPOTIFY_REDIRECT_URI: "http://localhost:3000/auth/spotify/callback"
      })
    );

    const response = await app.inject({ method: "GET", url: "/auth/spotify/login" });
    expect(response.statusCode).toBe(302);

    const location = response.headers.location;
    expect(typeof location).toBe("string");
    const url = new URL(location as string);

    expect(url.origin).toBe("https://accounts.spotify.com");
    expect(url.searchParams.get("client_id")).toBe("spotify-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/auth/spotify/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(
      "streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state user-top-read"
    );

    await app.close();
  });
});
