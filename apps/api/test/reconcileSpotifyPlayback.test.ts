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
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Adapter whose reported "currently playing" track is fully controllable per test. */
class ControllableAdapter implements SpotifyAdapter {
  playbackState: SpotifyPlaybackState = { isPlaying: false, queuedProviderTrackIds: [] };
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

  async transferPlayback(): Promise<void> {}
  async resolvePlaybackDeviceId(args: { preferredDeviceId: string }): Promise<string> {
    return args.preferredDeviceId;
  }
  async skipToNext(): Promise<void> {}
  async skipToPrevious(): Promise<void> {}
  async startPlayback(args: { deviceId: string; uris: string[] }): Promise<void> {
    this.startCalls.push({ deviceId: args.deviceId, uris: args.uris });
  }
  async addToQueue(args: { deviceId: string; uri: string }): Promise<void> {
    this.queueCalls.push({ deviceId: args.deviceId, uri: args.uri });
  }
  async getPlaybackState(): Promise<SpotifyPlaybackState> {
    return this.playbackState;
  }
}

function buildService(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-reconcile-"));
  tmpDirs.push(dir);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "true",
    CORS_ORIGIN: "http://localhost:5173",
    ...overrides
  });
  const db = openDatabase(config.DATABASE_PATH);
  migrate(db);
  const store = new Store(db);
  const adapter = new ControllableAdapter();
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
  return { service, store, adapter };
}

async function startSpotifyJourney(service: JourneyService) {
  const journey = await service.startJourney({
    destination: "Dijon",
    userPrompt: "cinematic golden-hour drive",
    passengerMode: "solo",
    provider: "spotify",
    deviceId: "tesla-web-device"
  });
  await service.registerSpotifyDevice(journey.id, "tesla-web-device", "ready", { syncOnly: true });
  return journey;
}

/**
 * Reconstructs the ordered playback model exactly as the service does: [active, ...queued]
 * with the active track de-duplicated out of the queue. Returns both the internal track id
 * (what the session stores in played/queued) and the providerTrackId (what Spotify reports).
 */
function modelOf(store: Store, journeyId: string): Array<{ id: string; providerTrackId: string }> {
  const session = store.getPlaybackSession(journeyId)!;
  const stored = store.listResolvedTracks(journeyId).filter((t) => t.provider === "spotify");
  const byId = new Map(stored.map((t) => [t.id, t]));
  const activeId = session.activeTrack?.id;
  const orderedIds = [
    ...(activeId ? [activeId] : []),
    ...session.queuedTrackIds.filter((id) => id !== activeId)
  ];
  return orderedIds
    .map((id) => byId.get(id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .map((t) => ({ id: t.id, providerTrackId: t.providerTrackId }));
}

describe("reconcileSpotifyPlayback", () => {
  it("no-ops when the active track is still the one playing", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const before = store.getPlaybackSession(journey.id)!;
    const model = modelOf(store, journey.id);

    adapter.playbackState = { isPlaying: true, activeProviderTrackId: model[0].providerTrackId, queuedProviderTrackIds: [] };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    const after = store.getPlaybackSession(journey.id)!;
    expect(after.playedTrackIds ?? []).toEqual(before.playedTrackIds ?? []);
    expect(after.queuedTrackIds).toEqual(before.queuedTrackIds);
  });

  it("advances played/active/queued when the user skipped natively", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const model = modelOf(store, journey.id);
    expect(model.length).toBeGreaterThanOrEqual(3);

    // Simulate two native skips: Spotify is now playing the 3rd track in our model.
    adapter.playbackState = { isPlaying: true, activeProviderTrackId: model[2].providerTrackId, queuedProviderTrackIds: [] };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    const after = store.getPlaybackSession(journey.id)!;
    expect((after.activeTrack as { providerTrackId: string }).providerTrackId).toBe(model[2].providerTrackId);
    // The two skipped-over tracks moved into history (session stores internal track ids).
    expect(after.playedTrackIds).toContain(model[0].id);
    expect(after.playedTrackIds).toContain(model[1].id);
  });

  it("pauses curation (status=external) when an off-journey track is playing", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const before = store.getPlaybackSession(journey.id)!;

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: "foreign-track-not-ours",
      queuedProviderTrackIds: []
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("external");
    const after = store.getPlaybackSession(journey.id)!;
    expect(after.status).toBe("external");
    // Off-journey must not advance our curated queue.
    expect(after.queuedTrackIds).toEqual(before.queuedTrackIds);
  });

  it("resumes curation once a journey track plays again after going external", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const model = modelOf(store, journey.id);

    adapter.playbackState = { isPlaying: true, activeProviderTrackId: "foreign", queuedProviderTrackIds: [] };
    await service.reconcileSpotifyPlayback(journey.id);
    expect(store.getPlaybackSession(journey.id)!.status).toBe("external");

    adapter.playbackState = { isPlaying: true, activeProviderTrackId: model[0].providerTrackId, queuedProviderTrackIds: [] };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    expect(store.getPlaybackSession(journey.id)!.status).toBe("playing");
  });

  it("stays idle (no throw, no change) when nothing is playing", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const before = store.getPlaybackSession(journey.id)!;

    adapter.playbackState = { isPlaying: false, queuedProviderTrackIds: [] };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("idle");
    const after = store.getPlaybackSession(journey.id)!;
    expect(after.queuedTrackIds).toEqual(before.queuedTrackIds);
  });

  it("returns idle for a non-existent / non-spotify journey without throwing", async () => {
    const { service } = buildService();
    await expect(service.reconcileSpotifyPlayback("does-not-exist")).resolves.toBe("idle");
  });
});
