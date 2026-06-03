import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { NormalizedTelemetryEvent } from "@ai-journey-dj/core";
import { normalizeTeslaPayload } from "@ai-journey-dj/telemetry";

import type { AppConfig } from "../config/env.js";
import type { JourneyService } from "../journeys/journeyService.js";

const normalizedTelemetrySchema = z.object({
  timestampIso: z.string(),
  coarseRegion: z.string().optional(),
  countryName: z.string().optional(),
  countryCode: z.string().optional(),
  geoSource: z.enum(["reverse-geocode", "manual", "simulated"]).optional(),
  destination: z.string().optional(),
  etaMinutes: z.number().optional(),
  speedKph: z.number().optional(),
  outsideTempC: z.number().optional(),
  autopilotState: z.enum(["off", "available", "active", "unknown"]).optional(),
  batteryPercent: z.number().optional(),
});

export async function registerTelemetryRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service: JourneyService,
): Promise<void> {
  app.post("/internal/telemetry", async (request, reply) => {
    const token = request.headers["x-simulator-token"];
    if (config.SIMULATOR_TOKEN && token !== config.SIMULATOR_TOKEN) {
      return reply.code(401).send({ error: "Invalid simulator token." });
    }

    const event = normalizedTelemetrySchema.parse(
      request.body,
    ) as NormalizedTelemetryEvent;
    await service.ingestTelemetry(event);
    return { ok: true };
  });

  app.post("/internal/tesla/raw", async (request, reply) => {
    const token = request.headers["x-simulator-token"];
    if (config.SIMULATOR_TOKEN && token !== config.SIMULATOR_TOKEN) {
      return reply.code(401).send({ error: "Invalid simulator token." });
    }

    const event = normalizeTeslaPayload(
      request.body as Record<string, unknown>,
      config.APP_SECRET,
    );
    await service.ingestTelemetry(event);
    return { ok: true };
  });
}
