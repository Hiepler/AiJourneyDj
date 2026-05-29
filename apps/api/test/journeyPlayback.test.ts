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

/**
 * Reproduces the real-device timing: the Web Playback device is not yet reachable on the
 * first analyze (Spotify answers 404 "Device not found"), then becomes reachable.
 */
class RaceSpotifyAdapter implements SpotifyAdapter {
  transferCalls = 0;
  startCalls: { deviceId: string; uris: string[] }[] = [];
  queueCalls: { deviceId: string; uri: string }[] = [];

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
        market: args.market,
        externalUrl: `https://open.spotify.com/track/${id}`,
        albumArtUrl: `https://img/${id}`
      }
    ];
  }

  async transferPlayback(): Promise<void> {
    this.transferCalls += 1;
    if (this.transferCalls === 1) {
      // Device just connected; Spotify hasn't registered it yet.
      throw new Error('Spotify request failed with 404: { "error": { "status": 404, "message": "Device not found" } }');
    }
  }

  async resolvePlaybackDeviceId(args: { preferredDeviceId: string }): Promise<string> {
    return args.preferredDeviceId;
  }

  async startPlayback(args: { deviceId: string; uris: string[] }): Promise<void> {
    this.startCalls.push({ deviceId: args.deviceId, uris: args.uris });
  }

  async addToQueue(args: { deviceId: string; uri: string }): Promise<void> {
    this.queueCalls.push({ deviceId: args.deviceId, uri: args.uri });
  }

  async getPlaybackState(): Promise<SpotifyPlaybackState> {
    return { isPlaying: false, queuedProviderTrackIds: [] };
  }
}

function buildService(adapter: SpotifyAdapter) {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-playback-"));
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
  const service = new JourneyService(
    config,
    store,
    new TidalAuthService(config, store),
    new MockTidalAdapter(),
    new SpotifyAuthService(config, store),
    adapter,
    new XaiSongScout({ apiKey: config.XAI_API_KEY, baseUrl: config.XAI_BASE_URL, model: config.XAI_MODEL, mock: true }),
    new NoopOpenMusicClient()
  );
  return { service, store };
}

describe("spotify playback initiation", () => {
  it("starts the head track once the device becomes reachable (not just queues it)", async () => {
    const adapter = new RaceSpotifyAdapter();
    const { service, store } = buildService(adapter);

    // Initial analyze: transfer may fail before the Webplayer is visible to Spotify.
    const journey = await service.startJourney({
      destination: "Dijon",
      userPrompt: "cinematic golden-hour drive",
      passengerMode: "solo",
      provider: "spotify",
      deviceId: "tesla-web-device"
    });
    const sessionAfterStart = store.getPlaybackSession(journey.id);
    expect(sessionAfterStart?.deviceId).toBe("tesla-web-device");
    expect(["playing", "degraded"]).toContain(sessionAfterStart?.status);

    // Device becomes ready -> sync playback without re-running the full analysis.
    await service.registerSpotifyDevice(journey.id, "tesla-web-device", "ready", { syncOnly: true });

    expect(adapter.transferCalls).toBeGreaterThanOrEqual(2);
    expect(adapter.startCalls.length).toBeGreaterThan(0);
    const startedUri = adapter.startCalls[0].uris[0];
    expect(startedUri).toMatch(/^spotify:track:/);
  });
});
