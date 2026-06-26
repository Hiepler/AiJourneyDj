import { describe, expect, it } from "vitest";
import { isWithinFreshWindow, releaseRadarCandidates } from "./releaseRadar.js";

const NOW = new Date("2026-06-26T00:00:00Z");

describe("isWithinFreshWindow", () => {
  it("keeps releases inside the window and drops older ones", () => {
    expect(isWithinFreshWindow("2026-06-01", 75, NOW)).toBe(true);
    expect(isWithinFreshWindow("2019-01-01", 75, NOW)).toBe(false);
    expect(isWithinFreshWindow(undefined, 75, NOW)).toBe(false);
  });
});

describe("releaseRadarCandidates", () => {
  const albums = {
    async getArtistAlbums(artistId: string) {
      return [
        {
          id: `${artistId}-fresh`,
          name: "Fresh Drop",
          artist: artistId,
          releaseDate: "2026-06-15",
        },
        {
          id: `${artistId}-old`,
          name: "Old Record",
          artist: artistId,
          releaseDate: "2019-03-01",
        },
      ];
    },
    async getNewReleases() {
      return [
        {
          id: "nr1",
          name: "Chart Newcomer",
          artist: "Fresh Act",
          releaseDate: "2026-06-10",
        },
      ];
    },
  };

  it("returns only in-window albums, tagged spotify-fresh, with real dates", async () => {
    const out = await releaseRadarCandidates({
      albums,
      tasteArtists: [{ id: "bonobo", name: "Bonobo" }],
      bannedArtists: new Set(),
      moodTags: ["mellow"],
      windowDays: 75,
      limit: 10,
      now: NOW,
    });
    expect(out.every((c) => c.source === "spotify-fresh")).toBe(true);
    expect(out.every((c) => c.lens === "release-radar")).toBe(true);
    expect(out.some((c) => c.title === "Fresh Drop")).toBe(true);
    expect(out.some((c) => c.title === "Old Record")).toBe(false);
    // the curated new release is appended
    expect(out.some((c) => c.title === "Chart Newcomer")).toBe(true);
  });

  it("filters banned artists and caps per artist", async () => {
    const manyAlbums = {
      async getArtistAlbums(artistId: string) {
        return [0, 1, 2].map((i) => ({
          id: `${artistId}-${i}`,
          name: `Drop ${i}`,
          artist: artistId,
          releaseDate: "2026-06-15",
        }));
      },
    };
    const out = await releaseRadarCandidates({
      albums: manyAlbums,
      tasteArtists: [
        { id: "bonobo", name: "Bonobo" },
        { id: "banned", name: "Banned Act" },
      ],
      bannedArtists: new Set(["banned act"]),
      moodTags: [],
      windowDays: 75,
      perArtist: 2,
      limit: 10,
      now: NOW,
    });
    expect(out.some((c) => c.artist === "Banned Act")).toBe(false);
    expect(out.filter((c) => c.artist === "Bonobo")).toHaveLength(2);
  });
});
