import { describe, expect, it } from "vitest";

import { LastfmChartClient } from "./lastfm.js";

describe("LastfmChartClient", () => {
  it("parses country chart tracks and caches them", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          tracks: {
            track: [
              {
                name: "Flowers",
                artist: { name: "Miley Cyrus" },
                playcount: "12345",
                "@attr": { rank: "1" },
              },
            ],
          },
        }),
        { status: 200 },
      );
    };
    const client = new LastfmChartClient({
      apiKey: "key",
      baseUrl: "https://lastfm.test/",
      fetchImpl,
    });

    const first = await client.getGeoTopTracks("Germany", 10);
    const second = await client.getGeoTopTracks("Germany", 10);

    expect(first).toEqual([
      {
        artist: "Miley Cyrus",
        title: "Flowers",
        playcount: 12345,
        rank: 1,
        country: "Germany",
        source: "lastfm-geo",
      },
    ]);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("parses tag tracks and degrades to empty without a key or on errors", async () => {
    const noKey = new LastfmChartClient({
      apiKey: undefined,
      fetchImpl: async () => new Response("never"),
    });
    expect(await noKey.getTagTopTracks("pop")).toEqual([]);

    const failing = new LastfmChartClient({
      apiKey: "key",
      baseUrl: "https://lastfm.test/",
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    });
    expect(await failing.getTagTopTracks("pop")).toEqual([]);

    const ok = new LastfmChartClient({
      apiKey: "key",
      baseUrl: "https://lastfm.test/",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            tracks: {
              track: { name: "Happy", artist: { name: "Pharrell Williams" } },
            },
          }),
          {
            status: 200,
          },
        ),
    });
    expect(await ok.getTagTopTracks("feelgood")).toMatchObject([
      {
        artist: "Pharrell Williams",
        title: "Happy",
        tag: "feelgood",
        source: "lastfm-tag",
      },
    ]);
  });
});
