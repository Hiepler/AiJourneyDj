import { describe, expect, it } from "vitest";

import type { ResolvedTrack, SongCandidate } from "@ai-journey-dj/core";

import {
  MockSpotifyAdapter,
  OfficialSpotifyAdapter,
  SpotifyResolver,
  bestSpotifyMatch,
  isSpotifyDeviceNotFoundError,
  isSpotifyRateLimitError,
  queueTracksForBuffer,
  type SpotifyAdapter,
  type SpotifyTrackSearchResult
} from "./index.js";

const candidate: SongCandidate = {
  artist: "M83",
  title: "Wait",
  isrc: "FR9W11200001",
  reason: "cinematic",
  source: "grok",
  confidence: 0.86
};

describe("spotify resolver", () => {
  it("prefers playable ISRC matches and maps provider metadata", async () => {
    const adapter: Pick<SpotifyAdapter, "searchTracks"> = {
      searchTracks: async () => [
        {
          id: "unplayable",
          uri: "spotify:track:unplayable",
          title: "Wait",
          artist: "M83",
          isrc: "FR9W11200001",
          isPlayable: false,
          market: "DE"
        },
        {
          id: "playable",
          uri: "spotify:track:playable",
          title: "Wait",
          artist: "M83",
          isrc: "FR9W11200001",
          isPlayable: true,
          market: "DE",
          externalUrl: "https://open.spotify.com/track/playable",
          albumArtUrl: "https://i.scdn.co/image/cover"
        }
      ]
    };

    const resolver = new SpotifyResolver(adapter as SpotifyAdapter, {
      accessToken: "token",
      market: "DE"
    });

    const [track] = await resolver.resolveCandidates([candidate]);

    expect(track).toMatchObject({
      provider: "spotify",
      providerTrackId: "playable",
      providerUri: "spotify:track:playable",
      externalUrl: "https://open.spotify.com/track/playable",
      albumArtUrl: "https://i.scdn.co/image/cover",
      isPlayable: true,
      market: "DE",
      matchReason: "isrc match"
    });
  });

  it("uses the search cache to avoid re-searching the same song", async () => {
    let searchCalls = 0;
    const adapter: Pick<SpotifyAdapter, "searchTracks"> = {
      searchTracks: async () => {
        searchCalls += 1;
        return [
          { id: "id1", uri: "spotify:track:id1", title: "Wait", artist: "M83", isPlayable: true, market: "DE" }
        ];
      }
    };
    const store = new Map<string, ResolvedTrack | null>();
    const cache = {
      get: (key: string) => (store.has(key) ? store.get(key) : undefined),
      set: (key: string, value: ResolvedTrack | null) => void store.set(key, value)
    };
    const resolver = new SpotifyResolver(adapter as SpotifyAdapter, { accessToken: "t", market: "DE", cache });

    const first = await resolver.resolveCandidates([candidate]);
    expect(first).toHaveLength(1);
    expect(searchCalls).toBe(1);

    const second = await resolver.resolveCandidates([candidate]);
    expect(second).toHaveLength(1);
    expect(second[0].providerTrackId).toBe("id1");
    expect(searchCalls).toBe(1); // cache hit — no second Spotify search
  });

  it("negative-caches a no-match so it is not searched again", async () => {
    let searchCalls = 0;
    const adapter: Pick<SpotifyAdapter, "searchTracks"> = {
      searchTracks: async () => {
        searchCalls += 1;
        return []; // no results -> no match
      }
    };
    const store = new Map<string, ResolvedTrack | null>();
    const cache = {
      get: (key: string) => (store.has(key) ? store.get(key) : undefined),
      set: (key: string, value: ResolvedTrack | null) => void store.set(key, value)
    };
    const resolver = new SpotifyResolver(adapter as SpotifyAdapter, { accessToken: "t", market: "DE", cache });

    expect(await resolver.resolveCandidates([candidate])).toHaveLength(0);
    expect(searchCalls).toBe(1);
    expect(await resolver.resolveCandidates([candidate])).toHaveLength(0);
    expect(searchCalls).toBe(1); // negative cache — no re-search
  });

  it("fills a five-track buffer from mock resolver output", async () => {
    const resolver = new SpotifyResolver(new MockSpotifyAdapter(), {
      accessToken: "token",
      market: "DE",
      searchTimeoutMs: 8_000,
      targetResolveCount: 5
    });
    const candidates: SongCandidate[] = [
      { artist: "Khruangbin", title: "A Calf Born in Winter", reason: "warm", source: "fallback", confidence: 0.72 },
      { artist: "The War on Drugs", title: "Red Eyes", reason: "momentum", source: "fallback", confidence: 0.78 },
      { artist: "M83", title: "Wait", reason: "cinematic", source: "fallback", confidence: 0.7 },
      { artist: "Tycho", title: "A Walk", reason: "steady", source: "fallback", confidence: 0.74 },
      { artist: "Roosevelt", title: "Moving On", reason: "bright", source: "fallback", confidence: 0.73 }
    ];
    const resolved = await resolver.resolveCandidates(candidates);
    const selected = queueTracksForBuffer(resolved, {
      alreadyQueuedProviderIds: new Set(),
      targetBufferSize: 5
    });
    expect(resolved).toHaveLength(5);
    expect(selected).toHaveLength(5);
  });

  it("resolves mock adapter candidates with search timeouts enabled", async () => {
    const resolver = new SpotifyResolver(new MockSpotifyAdapter(), {
      accessToken: "token",
      market: "DE",
      searchTimeoutMs: 8_000,
      targetResolveCount: 5
    });

    const resolved = await resolver.resolveCandidates([
      {
        artist: "Khruangbin",
        title: "A Calf Born in Winter",
        reason: "warm",
        source: "fallback",
        confidence: 0.72
      }
    ]);

    expect(resolved.length).toBeGreaterThan(0);
  });

  it("uses fuzzy artist and title matching when ISRC is unavailable", () => {
    const match = bestSpotifyMatch(
      {
        artist: "The War on Drugs",
        title: "Red Eyes",
        reason: "momentum",
        source: "grok",
        confidence: 0.8
      },
      [
        {
          id: "other",
          uri: "spotify:track:other",
          artist: "Different Artist",
          title: "Red Eyes",
          isPlayable: true
        },
        {
          id: "best",
          uri: "spotify:track:best",
          artist: "The War On Drugs",
          title: "Red Eyes - Radio Edit",
          isPlayable: true
        }
      ]
    );

    expect(match?.track.id).toBe("best");
    expect(match?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("keeps the future queue buffer at exactly five unique Spotify tracks", () => {
    const tracks = Array.from({ length: 8 }, (_, index) => ({
      provider: "spotify" as const,
      providerTrackId: `track-${index}`,
      providerUri: `spotify:track:${index}`,
      artist: "Artist",
      title: `Track ${index}`,
      matchConfidence: 0.9,
      matchReason: "test"
    }));

    const selected = queueTracksForBuffer(tracks, {
      activeProviderTrackId: "track-0",
      alreadyQueuedProviderIds: new Set(["track-2"]),
      targetBufferSize: 5
    });

    expect(selected.map((track) => track.providerTrackId)).toEqual([
      "track-1",
      "track-3",
      "track-4",
      "track-5",
      "track-6"
    ]);
  });

  it("creates deterministic mock Spotify playlists for adapter parity", async () => {
    const playlist = await new MockSpotifyAdapter().createPlaylist({
      accessToken: "mock",
      name: "AI Journey DJ",
      description: "Fallback parity"
    });

    expect(playlist).toMatchObject({
      id: expect.stringMatching(/^mock-spotify-playlist-/),
      name: "AI Journey DJ"
    });
    expect(playlist.url).toContain("open.spotify.com/playlist");
  });

  it("retries Spotify rate limits once using Retry-After", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "0" }
        });
      }
      return new Response(
        JSON.stringify({
          tracks: {
            items: [
              {
                id: "spotify-id",
                uri: "spotify:track:spotify-id",
                name: "Wait",
                is_playable: true,
                external_urls: { spotify: "https://open.spotify.com/track/spotify-id" },
                external_ids: { isrc: "FR9W11200001" },
                artists: [{ name: "M83" }],
                album: { images: [{ url: "https://i.scdn.co/image/cover" }] }
              }
            ]
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const adapter = new OfficialSpotifyAdapter({
      baseUrl: "https://api.spotify.test/v1",
      fetchImpl,
      wait: async () => undefined
    });

    const results: SpotifyTrackSearchResult[] = await adapter.searchTracks({
      accessToken: "token",
      query: "M83 - Wait",
      market: "DE",
      limit: 5
    });

    expect(calls).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: "spotify-id",
      uri: "spotify:track:spotify-id",
      title: "Wait",
      artist: "M83",
      isrc: "FR9W11200001",
      isPlayable: true,
      market: "DE"
    });
  });

  it("aborts a 429 rate-limit backoff instead of retrying when the request is aborted", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      // A heavily rate-limited Spotify with a long Retry-After — must NOT be waited out.
      return new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });
    };
    const adapter = new OfficialSpotifyAdapter({ baseUrl: "https://api.spotify.test/v1", fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.searchTracks({ accessToken: "t", query: "M83 - Wait", market: "DE", limit: 5, signal: controller.signal })
    ).rejects.toThrow();
    // No retry storm: the aborted signal short-circuits the backoff after the first response.
    expect(calls).toBe(1);
  });
});

describe("spotify playback helpers", () => {
  it("detects Spotify device-not-found errors", () => {
    expect(
      isSpotifyDeviceNotFoundError(
        new Error('Spotify request failed with 404: { "error" : { "status" : 404, "message" : "Device not found" } }')
      )
    ).toBe(true);
    expect(isSpotifyDeviceNotFoundError(new Error("Spotify request failed with 401"))).toBe(false);
    expect(isSpotifyRateLimitError(new Error("Spotify request failed with 429: "))).toBe(true);
  });

  it("transfers playback by sending device_ids in the request body", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      return new Response("{}", { status: 200 });
    };

    const adapter = new OfficialSpotifyAdapter({
      baseUrl: "https://api.spotify.test/v1",
      fetchImpl,
      wait: async () => undefined
    });

    await adapter.transferPlayback({ accessToken: "token", deviceId: "device-1" });
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe("https://api.spotify.test/v1/me/player");
    // Must NOT set play:true — that resumes the account's previous (external) context.
    // Activation only; startPlayback is the single source of truth for what plays.
    expect(calls[0].body).toEqual({ device_ids: ["device-1"], play: false });
  });

  it("does not crash when player commands return a 2xx with a non-JSON body", async () => {
    // Spotify player endpoints are fire-and-forget; they can answer 202 (or 200) with an
    // empty or non-JSON body. The adapter must not try to parse a body it never uses.
    const fetchImpl: typeof fetch = async () => new Response("1,", { status: 202 });
    const adapter = new OfficialSpotifyAdapter({
      baseUrl: "https://api.spotify.test/v1",
      fetchImpl,
      wait: async () => undefined
    });

    await expect(adapter.transferPlayback({ accessToken: "t", deviceId: "d" })).resolves.toBeUndefined();
    await expect(adapter.startPlayback({ accessToken: "t", deviceId: "d", uris: ["spotify:track:x"] })).resolves.toBeUndefined();
    await expect(adapter.addToQueue({ accessToken: "t", deviceId: "d", uri: "spotify:track:x" })).resolves.toBeUndefined();
  });

  it("still surfaces device-not-found errors from player commands", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{ "error": { "status": 404, "message": "Device not found" } }', { status: 404 });
    const adapter = new OfficialSpotifyAdapter({
      baseUrl: "https://api.spotify.test/v1",
      fetchImpl,
      wait: async () => undefined
    });

    await expect(adapter.startPlayback({ accessToken: "t", deviceId: "d", uris: ["spotify:track:x"] })).rejects.toThrow(
      /404/
    );
  });
});
