import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testConfig(sharedDbDir?: string) {
  const dir = sharedDbDir ?? mkdtempSync(join(tmpdir(), "ai-journey-dj-variety-"));
  if (!sharedDbDir) tmpDirs.push(dir);
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

async function startJourney(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  destination: string,
) {
  const journey = (
    await app.inject({
      method: "POST",
      url: "/journeys",
      payload: {
        destination,
        userPrompt: "bright road trip",
        passengerMode: "family",
        provider: "spotify",
        deviceId: "mock-webplayer",
      },
    })
  ).json<{ id: string }>();
  const detail = (await app.inject({ method: "GET", url: `/journeys/${journey.id}` })).json();
  const queued: string[] = detail.playbackSession.queuedTrackIds.map((id: string) => {
    const t = detail.tracks.find((track: { id: string }) => track.id === id);
    return `${t.artist}::${t.title}`;
  });
  return { id: journey.id, queued };
}

describe("engine variety", () => {
  it("two journeys with the same mood produce different queues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-variety-shared-"));
    tmpDirs.push(dir);
    const { app } = await buildApp(testConfig(dir));

    const a = await startJourney(app, "Lago di Garda");
    const b = await startJourney(app, "Lago di Garda");

    const overlap = a.queued.filter((k) => b.queued.includes(k)).length;
    expect(a.queued).not.toEqual(b.queued);
    expect(overlap).toBeLessThan(a.queued.length);

    await app.close();
  });
});
