import { Kafka } from "kafkajs";

import type { NormalizedTelemetryEvent } from "@ai-journey-dj/core";
import { normalizeTeslaPayload } from "@ai-journey-dj/telemetry";

import type { AppConfig } from "../config/env.js";
import type { JourneyService } from "../journeys/journeyService.js";

export async function startTelemetryConsumer(config: AppConfig, service: JourneyService): Promise<void> {
  if (!config.TESLA_TELEMETRY_ENABLED) {
    return;
  }

  const kafka = new Kafka({
    clientId: "ai-journey-dj-api",
    brokers: config.kafkaBrokers
  });
  const consumer = kafka.consumer({ groupId: "ai-journey-dj" });
  await consumer.connect();
  await consumer.subscribe({ topic: config.TESLA_TELEMETRY_TOPIC, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const payload = JSON.parse(message.value.toString()) as Record<string, unknown>;
      const event: NormalizedTelemetryEvent =
        "timestampIso" in payload
          ? (payload as unknown as NormalizedTelemetryEvent)
          : normalizeTeslaPayload(payload, config.APP_SECRET);
      await service.ingestTelemetry(event);
    }
  });
}
