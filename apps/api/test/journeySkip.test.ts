import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NoopOpenMusicClient } from "@ai-journey-dj/open-music";
import { XaiSongScout } from "@ai-journey-dj/recommendation";
import type { SpotifyAdapter, SpotifyPlaybackState, SpotifyTrackSearchResult } from "@ai-journey-dj/spotify";
import { MockTidalAdapter } from "@ai-journey-dj/tidal";
import { afterEach, describe, expect, it } from "vitest";

import { SpotifyAuthService } from "../src/auth/spotifyAuth.js";
import { TidalAuthService } from "../src/auth/tidalAuth.js";
import { loadConfig } from "../src/config/env.js";
import { migrate, openDatabase } from "../src/db/database.js";
import { Store } from "../src/db/store.js";
import { JourneyService } from "../src/journeys/journeyService.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

class SkipSpotifyAdapter implements SpotifyAdapter {
  skipNextCalls = 0;
  skipPrevCalls = 0;

  async searchTracks(args: { query: string; market: string }): Promise<SpotifyTrackSearchResult[]> {
    const [artist, ...rest] = args.query.split(" - ");
    const title = rest.join(" - ") || artist;
    const id = `${artist}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return [
      {
        id,
        uri: `spotify:track:${id}`,
        title,
        artist,
        isPlayable: true,
        market: args.market
      }
    ];
  }

  async transferPlayback(): Promise<void> {}
  async resolvePlaybackDeviceId(args: { preferredDeviceId: string }): Promise<string> {
    return args.preferredDeviceId;
  }
  async skipToNext(): Promise<void> {
    this.skipNextCalls += 1;
  }
  async skipToPrevious(): Promise<void> {
    this.skipPrevCalls += 1;
  }
  async startPlayback(): Promise<void> {}
  async addToQueue(): Promise<void> {}
  async getPlaybackState(): Promise<SpotifyPlaybackState> {
    return { isPlaying: true, queuedProviderTrackIds: [] };
  }
}

function buildService(adapter: SpotifyAdapter) {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-skip-"));
  tmpDirs.push(dir);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "true",
    CORS_ORIGIN: "http://localhost:5173"
  });
  const db = openDatabase(config.DATABASE_PATH);
  migrate(db);
  const store = new Store(db);
  return {
    service: new JourneyService(
      config,
      store,
      new TidalAuthService(config, store),
      new MockTidalAdapter(),
      new SpotifyAuthService(config, store),
      adapter,
      new XaiSongScout({ apiKey: config.XAI_API_KEY, baseUrl: config.XAI_BASE_URL, model: config.XAI_MODEL, mock: true }),
      new NoopOpenMusicClient()
    ),
    store
  };
}

describe("spotify track skip", () => {
  it("advances the journey queue and records play history on next", async () => {
    const adapter = new SkipSpotifyAdapter();
    const { service, store } = buildService(adapter);

    const journey = await service.startJourney({
      destination: "Dijon",
      userPrompt: "road trip",
      passengerMode: "solo",
      provider: "spotify",
      deviceId: "web-device"
    });

    const before = store.getPlaybackSession(journey.id);
    const activeId = before?.activeTrack?.id;
    const nextId = before?.queuedTrackIds[0];
    expect(activeId).toBeTruthy();
    expect(nextId).toBeTruthy();

    const after = await service.skipSpotifyTrack(journey.id, "next", "web-device");
    expect(adapter.skipNextCalls).toBe(1);
    expect(after.activeTrack?.id).toBe(nextId);
    expect(after.playedTrackIds).toContain(activeId);
    expect(after.queuedTrackIds[0]).not.toBe(nextId);
  });

  it("restores the previous track from journey history", async () => {
    const adapter = new SkipSpotifyAdapter();
    const { service, store } = buildService(adapter);

    const journey = await service.startJourney({
      destination: "Dijon",
      userPrompt: "road trip",
      passengerMode: "solo",
      provider: "spotify",
      deviceId: "web-device"
    });

    const first = store.getPlaybackSession(journey.id);
    const firstActiveId = first?.activeTrack?.id;
    await service.skipSpotifyTrack(journey.id, "next", "web-device");
    const restored = await service.skipSpotifyTrack(journey.id, "previous", "web-device");

    expect(adapter.skipPrevCalls).toBe(1);
    expect(restored.activeTrack?.id).toBe(firstActiveId);
    expect(restored.playedTrackIds ?? []).not.toContain(firstActiveId);
  });
});
