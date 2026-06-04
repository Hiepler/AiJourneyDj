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

  it("rejects wishes on a stopped journey", async () => {
    const { app } = await buildApp(testConfig());
    const journey = (await app.inject({
      method: "POST",
      url: "/journeys",
      payload: { destination: "Dijon", userPrompt: "drive", passengerMode: "solo", provider: "spotify" },
    })).json<{ id: string }>();

    await app.inject({ method: "POST", url: `/journeys/${journey.id}/stop` });

    const rejected = await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/music-wishes`,
      payload: { text: "mehr Taylor Swift", source: "text" },
    });
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);

    const detail = await app.inject({ method: "GET", url: `/journeys/${journey.id}` });
    expect(detail.json().activeMusicWishes).toEqual([]);

    await app.close();
  });

  it("does not auto-apply an ambiguous pending-confirmation wish", async () => {
    const { app } = await buildApp(testConfig());
    const journey = (await app.inject({
      method: "POST",
      url: "/journeys",
      payload: { destination: "Dijon", userPrompt: "drive", passengerMode: "solo", provider: "spotify", deviceId: "mock-webplayer" },
    })).json<{ id: string }>();

    const wishResponse = await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/music-wishes`,
      payload: { text: "irgendwie anders", source: "text" },
    });
    expect(wishResponse.json()).toMatchObject({
      wish: { status: "pending_confirmation" },
    });
    expect(wishResponse.json().update).toBeUndefined();

    const detail = await app.inject({ method: "GET", url: `/journeys/${journey.id}` });
    expect(detail.json().activeMusicWishes).toEqual([]);

    await app.close();
  });

  it("activates a short bare artist wish so the frontend can show a chip", async () => {
    const { app } = await buildApp(testConfig());
    const journey = (await app.inject({
      method: "POST",
      url: "/journeys",
      payload: { destination: "Dijon", userPrompt: "drive", passengerMode: "solo", provider: "spotify", deviceId: "mock-webplayer" },
    })).json<{ id: string }>();

    const wishResponse = await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/music-wishes`,
      payload: { text: "Nina Chuba", source: "text" },
    });
    expect(wishResponse.statusCode).toBe(201);
    expect(wishResponse.json()).toMatchObject({
      wish: {
        status: "active",
        summary: "Mehr Nina Chuba",
        intents: [{ type: "artist", artist: "Nina Chuba" }],
      },
    });

    const detail = (await app.inject({ method: "GET", url: `/journeys/${journey.id}` })).json();
    expect(detail.activeMusicWishes).toEqual([
      expect.objectContaining({ summary: "Mehr Nina Chuba", status: "active" }),
    ]);
    const queuedTracks = detail.playbackSession.queuedTrackIds.map((id: string) =>
      detail.tracks.find((track: { id: string }) => track.id === id),
    );
    expect(queuedTracks.some((track: { artist: string } | undefined) => track?.artist === "Nina Chuba")).toBe(true);

    await app.close();
  });

  it("manual refresh with an active wish rebuilds the visible future queue", async () => {
    const { app } = await buildApp(testConfig());
    const journey = (await app.inject({
      method: "POST",
      url: "/journeys",
      payload: { destination: "Dijon", userPrompt: "drive", passengerMode: "solo", provider: "spotify", deviceId: "mock-webplayer" },
    })).json<{ id: string }>();

    await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/music-wishes`,
      payload: { text: "Nina Chuba", source: "text", apply: false },
    });

    const before = (await app.inject({ method: "GET", url: `/journeys/${journey.id}` })).json();
    expect(before.playbackSession.queuedTrackIds).toHaveLength(5);

    await app.inject({ method: "POST", url: `/journeys/${journey.id}/analyze` });

    const detail = (await app.inject({ method: "GET", url: `/journeys/${journey.id}` })).json();
    const queuedTracks = detail.playbackSession.queuedTrackIds.map((id: string) =>
      detail.tracks.find((track: { id: string }) => track.id === id),
    );
    expect(queuedTracks.some((track: { artist: string } | undefined) => track?.artist === "Nina Chuba")).toBe(true);

    await app.close();
  });
});

describe("music wish journey application", () => {
  it("non-immediate wishes do not interrupt the active track", async () => {
    const { app } = await buildApp(testConfig());
    const journey = (await app.inject({
      method: "POST",
      url: "/journeys",
      payload: { destination: "Dijon", userPrompt: "drive", passengerMode: "solo", provider: "spotify", deviceId: "mock-webplayer" },
    })).json<{ id: string }>();
    const before = (await app.inject({ method: "GET", url: `/journeys/${journey.id}` })).json();
    const activeBefore = before.playbackSession.activeTrack.providerTrackId;

    await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/music-wishes`,
      payload: { text: "mehr Taylor Swift", source: "text" },
    });

    const after = (await app.inject({ method: "GET", url: `/journeys/${journey.id}` })).json();
    expect(after.playbackSession.activeTrack.providerTrackId).toBe(activeBefore);
    expect(after.tracks.some((track: { artist: string }) => track.artist === "Taylor Swift")).toBe(true);

    await app.close();
  });

  it("explicit jetzt song wishes can replace the active track", async () => {
    const { app } = await buildApp(testConfig());
    const journey = (await app.inject({
      method: "POST",
      url: "/journeys",
      payload: { destination: "Dijon", userPrompt: "drive", passengerMode: "solo", provider: "spotify", deviceId: "mock-webplayer" },
    })).json<{ id: string }>();

    await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/music-wishes`,
      payload: { text: "spiel jetzt Taylor Swift - Shake It Off", source: "text" },
    });

    const after = (await app.inject({ method: "GET", url: `/journeys/${journey.id}` })).json();
    expect(after.playbackSession.activeTrack.artist).toBe("Taylor Swift");
    expect(after.playbackSession.activeTrack.title).toBe("Shake It Off");

    await app.close();
  });

  it("keeps a fresh wish active with its full track budget once the buffer is full", async () => {
    const { app } = await buildApp(testConfig());
    const journey = (await app.inject({
      method: "POST",
      url: "/journeys",
      payload: { destination: "Dijon", userPrompt: "drive", passengerMode: "solo", provider: "spotify", deviceId: "mock-webplayer" },
    })).json<{ id: string }>();

    // Let the initial curation fill the forward buffer to 5 before wishing.
    const before = (await app.inject({ method: "GET", url: `/journeys/${journey.id}` })).json();
    expect(before.playbackSession.queuedTrackIds.length).toBe(5);

    const created = (await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/music-wishes`,
      payload: { text: "mehr Taylor Swift", source: "text" },
    })).json<{ wish: { remainingTracks: number; expiresAfterTracks: number; status: string } }>();

    // The wish has not steered any played track yet, so it must start at full budget
    // and stay active — it must NOT be decayed by the size of the re-curation batch.
    expect(created.wish.status).toBe("active");
    expect(created.wish.remainingTracks).toBe(created.wish.expiresAfterTracks);

    const active = (await app.inject({ method: "GET", url: `/journeys/${journey.id}/music-wishes` })).json();
    expect(active.active).toHaveLength(1);
    expect(active.active[0].remainingTracks).toBe(5);

    await app.close();
  });
});
