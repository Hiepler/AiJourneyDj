import { describe, expect, it } from "vitest";

import { fetchLyrics, parseLrc } from "../src/lyrics/lrclib.js";

describe("parseLrc", () => {
  it("parses timestamps into time-sorted millisecond lines", () => {
    const lines = parseLrc("[00:12.50]Hello\n[00:15.00]World\n[00:09.00]Intro");
    expect(lines).toEqual([
      { timeMs: 9_000, text: "Intro" },
      { timeMs: 12_500, text: "Hello" },
      { timeMs: 15_000, text: "World" },
    ]);
  });

  it("skips metadata/blank lines without a timestamp", () => {
    const lines = parseLrc("[ar:Artist]\n[00:01.00]One\n\nnot a line");
    expect(lines).toEqual([{ timeMs: 1_000, text: "One" }]);
  });
});

describe("fetchLyrics", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it("returns parsed synced lyrics from the first synced match", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse([
        { plainLyrics: "plain only" },
        { syncedLyrics: "[00:02.00]Drive\n[00:04.00]On", plainLyrics: "Drive\nOn" },
      ]);
    const lyrics = await fetchLyrics({ artist: "A", title: "B", fetchImpl });
    expect(lyrics?.synced).toEqual([
      { timeMs: 2_000, text: "Drive" },
      { timeMs: 4_000, text: "On" },
    ]);
    expect(lyrics?.plain).toBe("Drive\nOn");
  });

  it("falls back to plain lyrics when no synced version exists", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse([{ plainLyrics: "just text" }]);
    const lyrics = await fetchLyrics({ artist: "A", title: "B", fetchImpl });
    expect(lyrics).toEqual({ plain: "just text" });
  });

  it("degrades to undefined on a 404 / empty result", async () => {
    expect(
      await fetchLyrics({ artist: "A", title: "B", fetchImpl: async () => new Response("", { status: 404 }) }),
    ).toBeUndefined();
    expect(
      await fetchLyrics({ artist: "A", title: "B", fetchImpl: async () => jsonResponse([]) }),
    ).toBeUndefined();
  });

  it("degrades to undefined (never throws) when the request fails", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("network down");
    };
    expect(await fetchLyrics({ artist: "A", title: "B", fetchImpl })).toBeUndefined();
  });

  it("requires both artist and title", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return jsonResponse([]);
    };
    expect(await fetchLyrics({ artist: "", title: "B", fetchImpl })).toBeUndefined();
    expect(called).toBe(false);
  });
});
