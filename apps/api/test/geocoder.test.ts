import { describe, expect, it } from "vitest";

import {
  coarseRegionFor,
  forwardGeocodeFor,
  geocodeFor,
  makeForwardGeocodeResolver,
  makeGeocoder,
} from "../src/telemetry/geocoder.js";

describe("coarse reverse-geocoder", () => {
  it("returns a coarse region string from a reverse-geocode response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          address: { state: "Bavaria", country: "Germany", country_code: "de" },
        }),
        {
          status: 200,
        },
      );
    const region = await coarseRegionFor(48.137, 11.575, {
      fetchImpl,
      baseUrl: "https://geo.test/reverse",
    });
    expect(region).toBe("Bavaria, Germany");
    await expect(
      geocodeFor(48.137, 11.575, {
        fetchImpl,
        baseUrl: "https://geo.test/reverse",
      }),
    ).resolves.toEqual({
      coarseRegion: "Bavaria, Germany",
      countryName: "Germany",
      countryCode: "DE",
      geoSource: "reverse-geocode",
    });
  });

  it("caches by rounded coordinates so nearby points do not refetch", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ address: { state: "Bavaria", country: "Germany" } }),
        { status: 200 },
      );
    };
    const geocode = makeGeocoder({
      fetchImpl,
      baseUrl: "https://geo.test/reverse",
    });
    await geocode(48.137, 11.575);
    await geocode(48.139, 11.571); // within ~0.1° → same cache bucket
    expect(calls).toBe(1);
  });

  it("returns undefined on error instead of throwing", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 500 });
    const region = await coarseRegionFor(1, 2, {
      fetchImpl,
      baseUrl: "https://geo.test/reverse",
    });
    expect(region).toBeUndefined();
  });
});

describe("forward geocoder (destination → region/country)", () => {
  it("parses the first search result's address", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify([
          {
            address: { city: "Montpellier", country: "France", country_code: "fr" },
          },
        ]),
        { status: 200 },
      );
    await expect(
      forwardGeocodeFor("Montpellier", { fetchImpl, baseUrl: "https://geo.test/search" }),
    ).resolves.toEqual({
      coarseRegion: "Montpellier, France",
      countryName: "France",
      countryCode: "FR",
      geoSource: "reverse-geocode",
    });
  });

  it("returns undefined for an empty result, blank query, or error", async () => {
    const empty: typeof fetch = async () => new Response("[]", { status: 200 });
    expect(
      await forwardGeocodeFor("Nowhere", { fetchImpl: empty, baseUrl: "https://geo.test/search" }),
    ).toBeUndefined();
    expect(
      await forwardGeocodeFor("   ", { fetchImpl: empty, baseUrl: "https://geo.test/search" }),
    ).toBeUndefined();
    const boom: typeof fetch = async () => {
      throw new Error("network");
    };
    expect(
      await forwardGeocodeFor("X", { fetchImpl: boom, baseUrl: "https://geo.test/search" }),
    ).toBeUndefined();
  });

  it("caches identical destination strings", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify([{ address: { country: "Italy", country_code: "it" } }]),
        { status: 200 },
      );
    };
    const resolve = makeForwardGeocodeResolver({
      fetchImpl,
      baseUrl: "https://geo.test/search",
    });
    await resolve("Lago di Garda");
    await resolve("lago di garda "); // normalized → same bucket
    expect(calls).toBe(1);
  });
});
