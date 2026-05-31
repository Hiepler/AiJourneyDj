import { describe, expect, it } from "vitest";

import { coarseRegionFor, makeGeocoder } from "../src/telemetry/geocoder.js";

describe("coarse reverse-geocoder", () => {
  it("returns a coarse region string from a reverse-geocode response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ address: { state: "Bavaria", country: "Germany" } }), { status: 200 });
    const region = await coarseRegionFor(48.137, 11.575, { fetchImpl, baseUrl: "https://geo.test/reverse" });
    expect(region).toBe("Bavaria, Germany");
  });

  it("caches by rounded coordinates so nearby points do not refetch", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ address: { state: "Bavaria", country: "Germany" } }), { status: 200 });
    };
    const geocode = makeGeocoder({ fetchImpl, baseUrl: "https://geo.test/reverse" });
    await geocode(48.137, 11.575);
    await geocode(48.139, 11.571); // within ~0.1° → same cache bucket
    expect(calls).toBe(1);
  });

  it("returns undefined on error instead of throwing", async () => {
    const fetchImpl: typeof fetch = async () => new Response("nope", { status: 500 });
    const region = await coarseRegionFor(1, 2, { fetchImpl, baseUrl: "https://geo.test/reverse" });
    expect(region).toBeUndefined();
  });
});
