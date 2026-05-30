import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { TidalAuthService } from "../auth/tidalAuth.js";
import type { SpotifyAuthService } from "../auth/spotifyAuth.js";
import { contextFromJourney, type Store } from "../db/store.js";
import type { JourneyService } from "./journeyService.js";

const startSchema = z.object({
  destination: z.string().min(2),
  userPrompt: z.string().min(1).default("balanced road-trip energy"),
  passengerMode: z.enum(["solo", "couple", "family", "friends"]).default("solo"),
  provider: z.enum(["spotify", "tidal"]).default("spotify"),
  deviceId: z.string().min(1).optional()
});

const deviceSchema = z.object({
  deviceId: z.string().min(1),
  status: z
    .enum(["ready", "not_ready", "account_error", "authentication_error", "playback_error", "autoplay_failed"])
    .default("ready"),
  syncOnly: z.boolean().optional()
});

export async function registerJourneyRoutes(
  app: FastifyInstance,
  service: JourneyService,
  store: Store,
  tidalAuth: TidalAuthService,
  spotifyAuth: SpotifyAuthService
): Promise<void> {
  app.post("/journeys", async (request, reply) => {
    const input = startSchema.parse(request.body);

    if (input.provider === "tidal" && !tidalAuth.isConnected()) {
      return reply.code(401).send({
        error: "TIDAL is not connected.",
        hint: "Click the TIDAL button in the app to log in before starting a journey."
      });
    }

    if (input.provider === "spotify" && !spotifyAuth.isConnected()) {
      return reply.code(401).send({
        error: "Spotify is not connected.",
        hint: "Click the Spotify button in the app to log in before starting a journey."
      });
    }

    const journey = await service.startJourney(input);
    return reply.code(201).send(journey);
  });

  app.get("/journeys/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const journey = service.getJourneyOrThrow(id);
    const latestUpdate = store.latestPlaylistUpdate(id);
    const tracks = store.listResolvedTracks(id);
    const hasTracks = tracks.length > 0;
    const analysisFailed = store.latestAuditEvent(id, "analysis.failed");
    const lastUpdateFailed = latestUpdate?.status === "failed";
    const failureIsFresh = Boolean(
      analysisFailed && (!latestUpdate || analysisFailed.createdAtIso > latestUpdate.createdAtIso)
    );

    const ctx = contextFromJourney(journey, store.latestTelemetry(id));
    const taste = store.getCachedTasteProfile("local");

    return {
      journey,
      latestUpdate,
      tracks,
      playbackSession: store.getPlaybackSession(id),
      needsAnalysis:
        journey.status === "active" &&
        !hasTracks &&
        (!latestUpdate || lastUpdateFailed),
      analysisError: !hasTracks && failureIsFresh ? analysisFailed!.message : undefined,
      // Privacy-safe glanceable drive context (no raw GPS/VIN).
      context: {
        phase: ctx.phase,
        speedBucket: ctx.speedBucket,
        etaMinutes: ctx.etaMinutes,
        temperatureBucket: ctx.temperatureBucket,
        coarseRegion: ctx.coarseRegion,
        localTimeIso: ctx.localTimeIso
      },
      // Personalization readout from the 24h taste cache (only top genres exposed).
      taste: taste ? { topGenres: taste.topGenres } : undefined
    };
  });

  app.post("/journeys/:id/stop", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return service.stopJourney(id);
  });

  app.post("/journeys/:id/analyze", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return service.analyzeJourney(id, "manual");
  });

  app.post("/journeys/:id/phase", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { phase } = z
      .object({
        phase: z.enum(["departure", "cruise", "golden_hour", "focus", "arrival", "rest"])
      })
      .parse(request.body);
    return service.setPhase(id, phase);
  });

  app.post("/journeys/:id/taste", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { weight } = z.object({ weight: z.number().min(0).max(1) }).parse(request.body);
    return service.setTasteWeight(id, weight);
  });

  app.post("/journeys/:id/playback/skip", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const payload = z
      .object({
        direction: z.enum(["next", "previous"]),
        deviceId: z.string().min(1).optional()
      })
      .parse(request.body);
    return service.skipSpotifyTrack(id, payload.direction, payload.deviceId);
  });

  app.post("/journeys/:id/playback/device", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const payload = deviceSchema.parse(request.body);
    return service.registerSpotifyDevice(id, payload.deviceId, payload.status, {
      syncOnly: payload.syncOnly
    });
  });

  app.post("/journeys/:id/fallback/tidal", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return service.switchToTidalFallback(id);
  });

  app.get("/journeys/:id/events", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    let lastId = 0;
    const writeEvents = () => {
      const events = store.auditEvents(id, lastId);
      for (const event of events) {
        lastId = event.id;
        reply.raw.write(`id: ${event.id}\n`);
        reply.raw.write(`event: ${event.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    writeEvents();
    const timer = setInterval(writeEvents, 5000);
    request.raw.on("close", () => clearInterval(timer));
  });

  app.get("/history", async () => ({
    journeys: store.listJourneys()
  }));

  app.get("/history/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return {
      journey: service.getJourneyOrThrow(id),
      latestUpdate: store.latestPlaylistUpdate(id),
      tracks: store.listResolvedTracks(id),
      playbackSession: store.getPlaybackSession(id),
      events: store.auditEvents(id)
    };
  });
}
