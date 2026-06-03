import { describe, expect, it } from "vitest";

import { FleetMqttState, handleStreamMessage } from "../src/telemetry/mqttTelemetryConsumer.js";
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

  it("aggregates Tesla fleet-telemetry MQTT field topics into a complete vehicle snapshot", async () => {
    const ingested: any[] = [];
    const live = new StreamLiveness();
    const state = new FleetMqttState();
    const common = {
      topicBase: "tesla/telemetry",
      state,
      appSecret: "s",
      geocode: async () => "Bavaria, Germany",
      ingest: async (e: any) => void ingested.push(e),
      live
    };

    await handleStreamMessage({ ...common, topic: "tesla/telemetry/VIN1/v/VehicleSpeed", raw: Buffer.from("60") });
    await handleStreamMessage({ ...common, topic: "tesla/telemetry/VIN1/v/Soc", raw: Buffer.from("64") });
    await handleStreamMessage({
      ...common,
      topic: "tesla/telemetry/VIN1/v/Location",
      raw: Buffer.from(JSON.stringify({ latitude: 48.1, longitude: 11.5 }))
    });

    expect(ingested).toHaveLength(3);
    expect(ingested[2]).toMatchObject({
      speedKph: 97,
      batteryPercent: 64,
      coarseRegion: "Bavaria, Germany"
    });
    expect(ingested[2].coordinates).toBeUndefined();
    expect(live.lastIso()).toBeDefined();
  });

  it("ignores non-metric fleet-telemetry MQTT topics", async () => {
    const ingested: any[] = [];
    await handleStreamMessage({
      topic: "tesla/telemetry/VIN1/connectivity",
      topicBase: "tesla/telemetry",
      raw: Buffer.from(JSON.stringify({ Status: "connected" })),
      appSecret: "s",
      geocode: async () => undefined,
      ingest: async (e) => void ingested.push(e),
      live: new StreamLiveness()
    });
    expect(ingested).toHaveLength(0);
  });
});
