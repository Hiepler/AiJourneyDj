import { describe, expect, it } from "vitest";

import { momentumRadioCandidates, similarRankWindow } from "./momentumRadio.js";

const lastfmStub = {
  getSimilarTracks: async () =>
    Array.from({ length: 40 }, (_, i) => ({ artist: `Sim${i}`, title: `Track${i}`, match: 1 - i / 50 })),
  getSimilarArtists: async () => Array.from({ length: 40 }, (_, i) => `Cousin${i}`),
  getArtistTopTracks: async (artist?: string) =>
    Array.from({ length: 10 }, (_, i) => ({ artist: artist ?? "X", title: `Hit${i}`, rank: i + 1 })),
};

describe("momentumRadio", () => {
  it("similarRankWindow shifts with tasteWeight and rotates with the seed", () => {
    const familiar = similarRankWindow({ tasteWeight: 1, seed: 1, min: 5, max: 30, take: 6 });
    const discovery = similarRankWindow({ tasteWeight: 0, seed: 1, min: 5, max: 30, take: 6 });
    expect(Math.min(...familiar)).toBeLessThan(Math.min(...discovery)); // vertraut = näher an Rang 5
    const rotated = similarRankWindow({ tasteWeight: 0.5, seed: 99, min: 5, max: 30, take: 6 });
    expect(rotated).not.toEqual(similarRankWindow({ tasteWeight: 0.5, seed: 1, min: 5, max: 30, take: 6 }));
  });

  it("builds candidates from all three seed classes, filters bans, attributes the seed", async () => {
    const candidates = await momentumRadioCandidates({
      lastfm: lastfmStub,
      nowPlaying: { artist: "Seed Act", title: "Seed Song" },
      wishArtists: ["Wish Act"],
      tasteArtists: ["Taste Act"],
      tasteWeight: 0.5,
      seed: 7,
      bannedArtists: new Set(["sim1"]),
      moodTags: ["pop"],
      limit: 10,
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(10);
    expect(candidates.every((c) => c.source === "lastfm-similar")).toBe(true);
    expect(candidates.some((c) => c.lens?.startsWith("lastfm-similar:"))).toBe(true);
    expect(candidates.some((c) => c.artist === "Sim1")).toBe(false); // Bann gefiltert
  });

  it("filters spoken-word neighbours out of the similar graph", async () => {
    const hoerspielStub = {
      ...lastfmStub,
      getSimilarTracks: async () => [
        { artist: "Die drei ???", title: "Folge 1", match: 0.9 },
        { artist: "Real Band", title: "Real Song", match: 0.8 },
      ],
    };
    const candidates = await momentumRadioCandidates({
      lastfm: hoerspielStub,
      nowPlaying: { artist: "Seed Act", title: "Seed Song" },
      tasteWeight: 0.5,
      seed: 1,
      bannedArtists: new Set(),
      moodTags: ["pop"],
      limit: 10,
    });
    expect(candidates.some((c) => c.artist === "Die drei ???")).toBe(false);
  });

  it("returns [] without any seeds", async () => {
    const none = await momentumRadioCandidates({
      lastfm: lastfmStub,
      tasteWeight: 0.5,
      seed: 1,
      bannedArtists: new Set(),
      moodTags: [],
      limit: 10,
    });
    expect(none).toEqual([]);
  });
});
