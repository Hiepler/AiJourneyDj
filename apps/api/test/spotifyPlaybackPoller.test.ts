import { describe, expect, it, vi } from "vitest";

import { runSpotifyPollTick } from "../src/playback/spotifyPlaybackPoller.js";

const cadence = { activeSeconds: 5, idleSeconds: 30 };

describe("runSpotifyPollTick", () => {
  it("idles (no reconcile) when there is no active Spotify journey", async () => {
    const reconcile = vi.fn();
    const next = await runSpotifyPollTick({
      listActiveSpotifyJourneyIds: () => [],
      reconcile,
      ...cadence
    });
    expect(next).toBe(30);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("polls fast (active cadence) when a journey is actively playing", async () => {
    const next = await runSpotifyPollTick({
      listActiveSpotifyJourneyIds: () => ["j1"],
      reconcile: async () => "playing",
      ...cadence
    });
    expect(next).toBe(5);
  });

  it("backs off when the journey is idle", async () => {
    const next = await runSpotifyPollTick({
      listActiveSpotifyJourneyIds: () => ["j1"],
      reconcile: async () => "idle",
      ...cadence
    });
    expect(next).toBe(30);
  });

  it("backs off when off-journey (external)", async () => {
    const next = await runSpotifyPollTick({
      listActiveSpotifyJourneyIds: () => ["j1"],
      reconcile: async () => "external",
      ...cadence
    });
    expect(next).toBe(30);
  });

  it("uses the fast cadence if ANY journey is playing", async () => {
    const next = await runSpotifyPollTick({
      listActiveSpotifyJourneyIds: () => ["j1", "j2"],
      reconcile: async (id) => (id === "j2" ? "playing" : "idle"),
      ...cadence
    });
    expect(next).toBe(5);
  });
});
