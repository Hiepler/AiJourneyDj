import { describe, expect, it } from "vitest";

import { composeWhyLine } from "../src/journeys/whyLine.js";

describe("composeWhyLine", () => {
  it("prioritises moment > local hit > wish > similar > lens", () => {
    expect(
      composeWhyLine({
        lens: "moment:traffic_release",
        reason: "x",
        source: "lastfm",
      }),
    ).toContain("Stau aufgelöst");
    expect(
      composeWhyLine({
        lens: "moment:border_crossing",
        chartCountry: "Italy",
        reason: "x",
        source: "lastfm",
      }),
    ).toContain("Italy");
    expect(
      composeWhyLine({
        lens: "music-wish-artist",
        reason: "Artist boost from music wish: mehr X",
        source: "music-wish",
      }),
    ).toContain("Wunsch");
    expect(
      composeWhyLine({
        lens: "lastfm-similar:Bonobo",
        reason: "x",
        source: "lastfm-similar",
      }),
    ).toContain("Bonobo");
    expect(
      composeWhyLine({ lens: "deep_cuts", reason: "fits the interlude", source: "gemini" }),
    ).toContain("Deep Cut");
    expect(composeWhyLine(undefined)).toBeUndefined();
    expect(
      composeWhyLine({ lens: "release-radar", reason: "x", source: "spotify-fresh" }),
    ).toContain("Frisch erschienen");
    // moment still wins over a fresh track
    expect(
      composeWhyLine({ lens: "moment:traffic_release", reason: "x", source: "spotify-fresh" }),
    ).toContain("Stau aufgelöst");
  });
});
