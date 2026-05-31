import { describe, expect, it } from "vitest";

import type { ResolvedTrack, SongCandidate } from "@ai-journey-dj/core";
import { songKey } from "@ai-journey-dj/core";

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

  it("fetches top artists with genres from /me/top/artists", async () => {
    let captured: { url: string; auth: string | null } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = { url: String(input), auth: new Headers(init?.headers).get("Authorization") };
      return new Response(
        JSON.stringify({
          items: [
            { id: "a1", name: "Bonobo", genres: ["electronica", "downtempo"] },
            { id: "a2", name: "Tame Impala", genres: ["psychedelic rock"] },
            { id: "a3", name: "No Genre Artist" }
          ]
        }),
        { status: 200 }
      );
    };
    const adapter = new OfficialSpotifyAdapter({ baseUrl: "https://api.spotify.test/v1", fetchImpl });

    const artists = await adapter.getTopArtists!({ accessToken: "tok", timeRange: "medium_term", limit: 20 });

    expect(captured?.url).toContain("/me/top/artists");
    expect(captured?.url).toContain("time_range=medium_term");
    expect(captured?.url).toContain("limit=20");
    expect(captured?.auth).toBe("Bearer tok");
    expect(artists).toEqual([
      { id: "a1", name: "Bonobo", genres: ["electronica", "downtempo"] },
      { id: "a2", name: "Tame Impala", genres: ["psychedelic rock"] },
      { id: "a3", name: "No Genre Artist", genres: [] }
    ]);
  });

  it("MockSpotifyAdapter returns deterministic top artists with genres", async () => {
    const mock = new MockSpotifyAdapter();
    const artists = await mock.getTopArtists!({ accessToken: "t" });
    expect(artists.length).toBeGreaterThan(0);
    expect(artists.every((artist) => typeof artist.name === "string" && Array.isArray(artist.genres))).toBe(true);
    expect(artists.some((artist) => artist.genres.length > 0)).toBe(true);
  });

  it("excludes consumed provider ids and song keys, and de-dupes by song key within the buffer", () => {
    const tracks: ResolvedTrack[] = [
      { provider: "spotify", providerTrackId: "played", providerUri: "spotify:track:played", artist: "A", title: "Played Song", matchConfidence: 0.9, matchReason: "x" },
      { provider: "spotify", providerTrackId: "live", providerUri: "spotify:track:live", artist: "A", title: "Played Song - Live", matchConfidence: 0.9, matchReason: "x" },
      { provider: "spotify", providerTrackId: "fresh1", providerUri: "spotify:track:fresh1", artist: "B", title: "Fresh One", matchConfidence: 0.9, matchReason: "x" },
      { provider: "spotify", providerTrackId: "fresh1-dup", providerUri: "spotify:track:fresh1dup", artist: "B", title: "Fresh One (Radio Edit)", matchConfidence: 0.9, matchReason: "x" },
      { provider: "spotify", providerTrackId: "fresh2", providerUri: "spotify:track:fresh2", artist: "C", title: "Fresh Two", matchConfidence: 0.9, matchReason: "x" }
    ];

    const selected = queueTracksForBuffer(tracks, {
      alreadyQueuedProviderIds: new Set<string>(),
      excludeProviderTrackIds: new Set(["played"]),
      excludeSongKeys: new Set([songKey("A", "Played Song")]),
      targetBufferSize: 5
    });

    const ids = selected.map((track) => track.providerTrackId);
    expect(ids).not.toContain("played"); // excluded by provider id
    expect(ids).not.toContain("live"); // excluded by song key (version of a consumed song)
    expect(ids).toContain("fresh1");
    expect(ids).not.toContain("fresh1-dup"); // same song key as fresh1 already picked
    expect(ids).toContain("fresh2");
  });

  it("adds tracks to a playlist via POST /playlists/{id}/tracks", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      return new Response(JSON.stringify({ snapshot_id: "snap" }), { status: 201 });
    };
    const adapter = new OfficialSpotifyAdapter({ baseUrl: "https://api.spotify.test/v1", fetchImpl, wait: async () => undefined });

    await adapter.addTracksToPlaylist!({ accessToken: "tok", playlistId: "pl1", uris: ["spotify:track:a", "spotify:track:b"] });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.spotify.test/v1/playlists/pl1/tracks");
    expect(calls[0].body).toEqual({ uris: ["spotify:track:a", "spotify:track:b"] });
  });

  it("does not call the API when there are no uris to add", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    const adapter = new OfficialSpotifyAdapter({ baseUrl: "https://api.spotify.test/v1", fetchImpl, wait: async () => undefined });
    await adapter.addTracksToPlaylist!({ accessToken: "t", playlistId: "pl1", uris: [] });
    expect(called).toBe(false);
  });

  it("lists devices and drops entries without an id", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          devices: [
            { id: "d1", name: "Phone", type: "Smartphone", is_active: true, is_restricted: false, volume_percent: 70 },
            { id: "d2", name: "Tesla Model Y", type: "Automobile", is_active: false, is_restricted: false },
            { name: "Ghost", type: "Unknown" }
          ]
        }),
        { status: 200 }
      );
    const adapter = new OfficialSpotifyAdapter({ baseUrl: "https://api.spotify.test/v1", fetchImpl });
    const devices = await adapter.listDevices!({ accessToken: "t" });
    expect(devices).toEqual([
      { id: "d1", name: "Phone", type: "Smartphone", isActive: true, isRestricted: false, volumePercent: 70 },
      { id: "d2", name: "Tesla Model Y", type: "Automobile", isActive: false, isRestricted: false, volumePercent: undefined }
    ]);
  });

  it("pauses and resumes a specific device via the Web API", async () => {
    const calls: { method: string; url: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ method: init?.method ?? "GET", url: String(input) });
      return new Response(null, { status: 204 });
    };
    const adapter = new OfficialSpotifyAdapter({ baseUrl: "https://api.spotify.test/v1", fetchImpl, wait: async () => undefined });

    await adapter.pausePlayback!({ accessToken: "t", deviceId: "d2" });
    await adapter.resumePlayback!({ accessToken: "t", deviceId: "d2" });

    expect(calls[0]).toEqual({ method: "PUT", url: "https://api.spotify.test/v1/me/player/pause?device_id=d2" });
    expect(calls[1]).toEqual({ method: "PUT", url: "https://api.spotify.test/v1/me/player/play?device_id=d2" });
  });

  it("MockSpotifyAdapter lists deterministic devices", async () => {
    const devices = await new MockSpotifyAdapter().listDevices!({ accessToken: "t" });
    expect(devices.length).toBeGreaterThanOrEqual(2);
    expect(devices.every((device) => typeof device.id === "string" && typeof device.name === "string")).toBe(true);
  });
});
