import { describe, expect, it } from "vitest";

import { handleStreamMessage } from "../src/telemetry/mqttTelemetryConsumer.js";
import { StreamLiveness } from "../src/telemetry/streamSource.js";

describe("handleStreamMessage", () => {
  it("normalizes, geocodes, marks liveness, and ingests", async () => {
    const ingested: any[] = [];
    const live = new StreamLiveness();
    await handleStreamMessage({
      raw: Buffer.from(JSON.stringify({ vin: "VIN1", VehicleSpeed: 60, Location: { latitude: 48.1, longitude: 11.5 } })),
      appSecret: "s",
      geocode: async () => "Bavaria, Germany",
      ingest: async (e) => void ingested.push(e),
      live
    });
    expect(ingested).toHaveLength(1);
    expect(ingested[0].speedKph).toBe(97);
    expect(ingested[0].coarseRegion).toBe("Bavaria, Germany");
    expect(ingested[0].coordinates).toBeUndefined(); // raw GPS stripped
    expect(live.lastIso()).toBeDefined();
  });

  it("ignores an unparseable message without throwing", async () => {
    const ingested: any[] = [];
    await handleStreamMessage({
      raw: Buffer.from("not json"),
      appSecret: "s",
      geocode: async () => undefined,
      ingest: async (e) => void ingested.push(e),
      live: new StreamLiveness()
    });
    expect(ingested).toHaveLength(0);
  });
});
