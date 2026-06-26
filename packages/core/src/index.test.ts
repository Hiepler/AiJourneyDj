import { describe, expect, it } from "vitest";

import { normalizeBaseTitle, songKey } from "./index.js";

describe("songKey", () => {
  it("collapses version variants of the same song", () => {
    const studio = songKey("Sam Fender", "Rein Me In");
    const live = songKey(
      "Sam Fender",
      "Rein Me In (with Olivia Dean) - Live At London Stadium / Extended Intro Version",
    );
    expect(live).toBe(studio);
  });

  it("strips bracketed segments and trailing version qualifiers", () => {
    expect(normalizeBaseTitle("September (Remastered 2014)")).toBe("september");
    expect(normalizeBaseTitle("Wouldn't It Be Nice - Stereo Mix")).toBe(
      "wouldn t it be nice",
    );
    expect(normalizeBaseTitle("Beautiful Day - Acoustic")).toBe(
      "beautiful day",
    );
  });

  it("keeps genuinely different songs and remixes distinct", () => {
    expect(songKey("A", "Song One")).not.toBe(songKey("A", "Song Two"));
    // A remix is a distinct track — must NOT collapse into the original.
    expect(normalizeBaseTitle("Around the World - Acid Remix")).not.toBe(
      normalizeBaseTitle("Around the World"),
    );
    // Numbered parts are distinct.
    expect(normalizeBaseTitle("Song - Part 2")).not.toBe(
      normalizeBaseTitle("Song"),
    );
  });
});
