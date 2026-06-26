import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JourneyRecord, SongCandidate } from "@ai-journey-dj/core";
import { NoopOpenMusicClient } from "@ai-journey-dj/open-music";
import {
  LastfmChartClient,
  type SongScout,
} from "@ai-journey-dj/recommendation";
import { MockSpotifyAdapter } from "@ai-journey-dj/spotify";
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

class NoopScout implements SongScout {
  async generateCandidates(): Promise<SongCandidate[]> {
    return [];
  }
}

function makeJourney(): JourneyRecord {
  return {
    id: "journey-freshness",
    provider: "spotify",
    destination: "Lago di Garda",
    userPrompt: "family good mood pop",
    passengerMode: "family",
    phase: "departure",
    status: "active",
    tasteWeight: 0.4,
    createdAtIso: new Date().toISOString(),
  };
}

function buildService(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-freshness-"));
  tmpDirs.push(dir);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "false",
    LASTFM_API_KEY: "test-lastfm-key",
    CORS_ORIGIN: "http://localhost:5173",
    LASTFM_ENABLED: "true",
    SPOTIFY_FRESH_ENABLED: "true",
    FRESH_QUOTA_MIN: "2",
    FRESH_WINDOW_DAYS: "365",
    ...overrides,
  });
  const db = openDatabase(config.DATABASE_PATH);
  migrate(db);
  const store = new Store(db);
  const lastfmCharts = new LastfmChartClient({
    apiKey: "test-lastfm-key",
    baseUrl: "https://lastfm.test/2.0/",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      const method = url.searchParams.get("method");
      if (method === "artist.getTopTracks") {
        const artist = url.searchParams.get("artist") ?? "Artist";
        return new Response(
          JSON.stringify({
            toptracks: {
              track: [
                {
                  name: `${artist} Signature`,
                  "@attr": { rank: "1" },
                  artist: { name: artist },
                },
                {
                  name: `${artist} Second`,
                  "@attr": { rank: "2" },
                  artist: { name: artist },
                },
                {
                  name: `${artist} Third`,
                  "@attr": { rank: "3" },
                  artist: { name: artist },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (method === "geo.getTopTracks") {
        return new Response(
          JSON.stringify({
            tracks: {
              track: [
                {
                  name: "Flowers",
                  playcount: "2500000",
                  "@attr": { rank: "1" },
                  artist: { name: "Miley Cyrus" },
                },
                {
                  name: "As It Was",
                  playcount: "2400000",
                  "@attr": { rank: "2" },
                  artist: { name: "Harry Styles" },
                },
                {
                  name: "Levitating",
                  playcount: "2200000",
                  "@attr": { rank: "3" },
                  artist: { name: "Dua Lipa" },
                },
                {
                  name: "Happy",
                  playcount: "1900000",
                  "@attr": { rank: "4" },
                  artist: { name: "Pharrell Williams" },
                },
                {
                  name: "Can't Stop the Feeling!",
                  playcount: "1800000",
                  "@attr": { rank: "5" },
                  artist: { name: "Justin Timberlake" },
                },
                {
                  name: "Uptown Funk",
                  playcount: "1700000",
                  "@attr": { rank: "6" },
                  artist: { name: "Mark Ronson" },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ tracks: { track: [] } }), {
        status: 200,
      });
    },
  });
  const service = new JourneyService(
    config,
    store,
    new TidalAuthService(config, store),
    new MockTidalAdapter(),
    new SpotifyAuthService(config, store),
    new MockSpotifyAdapter(),
    new NoopScout(),
    new NoopOpenMusicClient(),
    lastfmCharts,
  );
  return { service, store };
}

const telemetry = {
  timestampIso: "2026-06-03T18:00:00.000Z",
  coarseRegion: "Bavaria, Germany",
  countryName: "Germany",
  countryCode: "DE",
  geoSource: "reverse-geocode" as const,
  destination: "Lago di Garda",
  etaMinutes: 180,
  speedKph: 92,
  outsideTempC: 24,
};

describe("freshness quota", () => {
  it(
    "guarantees >= FRESH_QUOTA_MIN release-radar tracks in the queue",
    { timeout: 30_000 },
    async () => {
      const { service, store } = buildService({
        FRESH_QUOTA_MIN: "2",
        FRESH_WINDOW_DAYS: "365",
      });
      const journey = makeJourney();
      store.createJourney(journey);
      store.saveTelemetry(journey.id, telemetry, "departure");

      await service.analyzeJourney(journey.id, "manual");

      const detailed = store.listResolvedTracksDetailed(journey.id);
      const session = store.getPlaybackSession(journey.id);
      const queuedIds = new Set([
        session?.activeTrack?.id,
        ...(session?.queuedTrackIds ?? []),
      ]);
      const freshInQueue = detailed.filter(
        (t) => queuedIds.has(t.id) && t.candidateLens === "release-radar",
      );
      expect(freshInQueue.length).toBeGreaterThanOrEqual(2);
    },
  );

  it(
    "does not starve the queue when no fresh tracks exist (Musik vor Doktrin)",
    { timeout: 30_000 },
    async () => {
      const { service, store } = buildService({
        FRESH_QUOTA_MIN: "2",
        FRESH_WINDOW_DAYS: "1",
      });
      const journey = {
        ...makeJourney(),
        id: "journey-freshness-empty",
      };
      store.createJourney(journey);
      store.saveTelemetry(journey.id, telemetry, "departure");

      await service.analyzeJourney(journey.id, "manual");

      const session = store.getPlaybackSession(journey.id);
      expect(session?.queuedTrackIds.length).toBe(5);
    },
  );
});
