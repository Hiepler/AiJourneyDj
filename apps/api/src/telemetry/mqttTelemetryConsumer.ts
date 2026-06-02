import mqtt from "mqtt";

import type { NormalizedTelemetryEvent } from "@ai-journey-dj/core";
import { normalizeFleetStream } from "@ai-journey-dj/telemetry";

import type { AppConfig } from "../config/env.js";
import type { JourneyService } from "../journeys/journeyService.js";
import { makeGeocoder } from "./geocoder.js";
import type { StreamLiveness } from "./streamSource.js";

export interface StreamMessageDeps {
  raw: Buffer | Uint8Array;
  appSecret: string;
  geocode: (lat: number, lon: number) => Promise<string | undefined>;
  ingest: (event: NormalizedTelemetryEvent) => Promise<void>;
  live: StreamLiveness;
}

/** Pure-ish handler for one streaming message. Best-effort: never throws on bad input. */
export async function handleStreamMessage(deps: StreamMessageDeps): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(deps.raw).toString("utf8"));
  } catch {
    return; // ignore malformed messages
  }
  const { coordinates, ...event } = normalizeFleetStream(payload, deps.appSecret);
  if (coordinates) {
    event.coarseRegion = await deps.geocode(coordinates.lat, coordinates.lon);
  }
  deps.live.mark(event.timestampIso);
  await deps.ingest(event);
}

export interface MqttConsumerHandle {
  stop: () => Promise<void>;
}

/** Subscribes to the fleet-telemetry MQTT topic and feeds the shared ingest pipeline. */
export function startMqttTelemetryConsumer(
  config: AppConfig,
  journeyService: JourneyService,
  live: StreamLiveness,
  logger: { warn: (obj: Record<string, unknown>, msg?: string) => void }
): MqttConsumerHandle | undefined {
  if (!config.TESLA_TELEMETRY_ENABLED) return undefined;
  const geocode = makeGeocoder({ baseUrl: config.GEOCODER_URL });
  const client = mqtt.connect(config.MQTT_URL, { reconnectPeriod: 5000 });

  client.on("connect", () => client.subscribe(config.MQTT_TOPIC));
  client.on("error", (err) => logger.warn({ err: err.message }, "mqtt.error"));
  client.on("message", (_topic, raw) => {
    void handleStreamMessage({
      raw,
      appSecret: config.APP_SECRET,
      geocode,
      ingest: (event) => journeyService.ingestTelemetry(event),
      live
    }).catch((error) => logger.warn({ err: error instanceof Error ? error.message : String(error) }, "mqtt.ingest_error"));
  });

  return { stop: async () => void (await client.endAsync()) };
}
