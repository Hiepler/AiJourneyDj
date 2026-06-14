import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../config/env.js";
import type { TidalAuthService } from "../auth/tidalAuth.js";
import type { SpotifyAuthService } from "../auth/spotifyAuth.js";
import { contextFromJourney, type Store } from "../db/store.js";
import {
  shouldPollRest,
  type StreamLiveness,
} from "../telemetry/streamSource.js";
import type { JourneyService } from "./journeyService.js";
import { composeWhyLine } from "./whyLine.js";
import { getLyrics } from "../lyrics/lrclib.js";

/** How long after firing a journey moment is still surfaced for the cockpit family-event banner. */
const MOMENT_BANNER_WINDOW_MS = 45_000;

const startSchema = z.object({
  destination: z.string().min(2),
  userPrompt: z.string().min(1).default("balanced road-trip energy"),
  passengerMode: z
    .enum(["solo", "couple", "family", "friends"])
    .default("solo"),
  provider: z.enum(["spotify", "tidal"]).default("spotify"),
  deviceId: z.string().min(1).optional(),
});

const deviceSchema = z.object({
  deviceId: z.string().min(1),
  status: z
    .enum([
      "ready",
      "not_ready",
      "account_error",
      "authentication_error",
      "playback_error",
      "autoplay_failed",
    ])
    .default("ready"),
  syncOnly: z.boolean().optional(),
  transfer: z.boolean().optional(),
});

const musicWishSchema = z.object({
  text: z.string().min(1).max(240),
  source: z.enum(["text", "voice", "chip"]).default("text"),
  apply: z.boolean().optional(),
  pinned: z.boolean().optional(),
});

const musicWishPatchSchema = z.object({
  pinned: z.boolean().optional(),
  status: z.enum(["expired", "undone"]).optional(),
});

export async function registerJourneyRoutes(
  app: FastifyInstance,
  service: JourneyService,
  store: Store,
  tidalAuth: TidalAuthService,
  spotifyAuth: SpotifyAuthService,
  config: AppConfig,
  streamLiveness: StreamLiveness,
): Promise<void> {
  app.post("/journeys", async (request, reply) => {
    const input = startSchema.parse(request.body);

    if (input.provider === "tidal" && !tidalAuth.isConnected()) {
      return reply.code(401).send({
        error: "TIDAL is not connected.",
        hint: "Click the TIDAL button in the app to log in before starting a journey.",
      });
    }

    if (input.provider === "spotify" && !spotifyAuth.isConnected()) {
      return reply.code(401).send({
        error: "Spotify is not connected.",
        hint: "Click the Spotify button in the app to log in before starting a journey.",
      });
    }

    const journey = await service.startJourney(input);
    return reply.code(201).send(journey);
  });

  app.get("/journeys/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const journey = service.getJourneyOrThrow(id);
    const latestUpdate = store.latestPlaylistUpdate(id);
    const tracks = store.listResolvedTracksDetailed(id).map((track) => ({
      ...track,
      whyLine: config.WHY_LINE_ENABLED
        ? composeWhyLine({
            lens: track.candidateLens,
            reason: track.candidateReason,
            source: track.candidateSource,
            chartCountry: track.candidateChartCountry ?? track.chartCountry,
          })
        : undefined,
    }));
    const hasTracks = tracks.length > 0;
    const analysisFailed = store.latestAuditEvent(id, "analysis.failed");
    const lastUpdateFailed = latestUpdate?.status === "failed";
    const failureIsFresh = Boolean(
      analysisFailed &&
      (!latestUpdate ||
        analysisFailed.createdAtIso > latestUpdate.createdAtIso),
    );

    const telemetrySource = shouldPollRest(
      streamLiveness.lastIso(),
      Date.now(),
      config.STREAM_FRESH_WINDOW_SECONDS * 1000,
    )
      ? "polling"
      : "streaming";
    const ctx = contextFromJourney(
      journey,
      store.latestTelemetry(id),
      store.recentTelemetry(id),
      telemetrySource,
    );
    const taste = store.getCachedTasteProfile("local");

    return {
      journey,
      latestUpdate,
      tracks,
      activeMusicWishes: store.listActiveMusicWishes(id),
      analysisPending: service.isAnalysisPending(id),
      recentMusicWishes: store.listRecentMusicWishes(id),
      playbackSession: store.getPlaybackSession(id),
      needsAnalysis:
        journey.status === "active" &&
        !hasTracks &&
        (!latestUpdate || lastUpdateFailed),
      analysisError:
        !hasTracks && failureIsFresh ? analysisFailed!.message : undefined,
      // Privacy-safe glanceable drive context (no raw GPS/VIN).
      context: {
        phase: ctx.phase,
        speedBucket: ctx.speedBucket,
        paceTrend: ctx.paceTrend,
        etaMinutes: ctx.etaMinutes,
        etaTrend: ctx.etaTrend,
        temperatureBucket: ctx.temperatureBucket,
        autopilotState: ctx.autopilotState,
        batteryPercent: ctx.batteryPercent,
        coarseRegion: ctx.coarseRegion,
        countryName: ctx.countryName,
        countryCode: ctx.countryCode,
        geoSource: ctx.geoSource,
        localTimeIso: ctx.localTimeIso,
        // Server-side ingest time of the latest telemetry → powers the "Live · vor Xs" badge.
        lastTelemetryAt: store.latestTelemetryReceivedAt(id),
        // Adaptive Drive Mode readout for the cockpit chip (comfort feature, not a safety system).
        driveMode: ctx.driveState?.mode ?? journey.driveMode ?? "neutral",
        driveModeReason: ctx.driveState?.reason,
        driveModeSignals: ctx.driveState?.signals,
        adaptiveModeEnabled: journey.adaptiveModeEnabled !== false,
        telemetrySource: ctx.telemetrySource,
        // Freshly-fired journey moment for the cockpit family-event banner. Only surfaced briefly
        // (the client shows + auto-dismisses); stale moments are dropped server-side.
        moment: (() => {
          const m = store.latestMomentEvent(id);
          if (!m) return undefined;
          const ageMs = Date.now() - new Date(m.createdAtIso).getTime();
          if (!(ageMs >= 0) || ageMs > MOMENT_BANNER_WINDOW_MS) return undefined;
          return { type: m.type, country: m.country, atIso: m.createdAtIso };
        })(),
      },
      // Personalization readout from the 24h taste cache (only top genres exposed).
      taste: taste ? { topGenres: taste.topGenres } : undefined,
    };
  });

  app.post("/journeys/:id/adaptive-mode", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    return service.setAdaptiveMode(id, enabled);
  });

  app.post("/journeys/:id/kids-mode", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    return service.setKidsMode(id, enabled);
  });

  // Browser-geolocation fallback: the web client posts device coordinates so the engine knows the
  // country/region even without live Tesla GPS. Server reverse-geocodes; best-effort (always 202).
  app.post("/journeys/:id/geo", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { lat, lon } = z
      .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
      .parse(request.body);
    service.getJourneyOrThrow(id);
    await service.setBrowserGeo(id, lat, lon);
    return reply.code(202).send({ ok: true });
  });

  // Manual location override (driver types a place, or blank to revert to auto). Re-curates.
  app.post("/journeys/:id/geo/manual", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { place } = z.object({ place: z.string() }).parse(request.body);
    return service.setManualGeo(id, place);
  });

  // Device-independent playback position for synced karaoke (works on car/phone Connect, not just
  // the browser SDK). The client interpolates between polls with a local clock for smooth highlighting.
  app.get("/journeys/:id/playback-progress", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    service.getJourneyOrThrow(id);
    return service.getPlaybackProgress(id);
  });

  // Synced lyrics for the karaoke/singalong view. Degrades to nulls when disabled or not found.
  app.get("/journeys/:id/tracks/:trackId/lyrics", async (request, reply) => {
    const { id, trackId } = z
      .object({ id: z.string(), trackId: z.string() })
      .parse(request.params);
    const { durationSec } = z
      .object({ durationSec: z.coerce.number().positive().optional() })
      .parse(request.query);
    if (!config.LYRICS_ENABLED) {
      return { synced: null, plain: null, reason: "disabled" };
    }
    service.getJourneyOrThrow(id);
    const track = store
      .listResolvedTracksDetailed(id)
      .find((item) => item.id === trackId);
    if (!track) {
      return reply.code(404).send({ error: "Track not found." });
    }
    const result = await getLyrics({
      artist: track.artist,
      title: track.title,
      durationSec,
      baseUrl: config.LRCLIB_BASE_URL,
    });
    if (result.reason !== "ok") {
      // Surfaced so a "no lyrics" report is diagnosable (unreachable LRCLIB vs. genuine no-match).
      request.log.info(
        { artist: track.artist, title: track.title, reason: result.reason },
        "lyrics.lookup",
      );
    }
    return {
      synced: result.lyrics?.synced ?? null,
      plain: result.lyrics?.plain ?? null,
      reason: result.reason,
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
        phase: z.enum([
          "departure",
          "cruise",
          "golden_hour",
          "focus",
          "arrival",
          "rest",
        ]),
      })
      .parse(request.body);
    return service.setPhase(id, phase);
  });

  app.post("/journeys/:id/taste", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { weight } = z
      .object({ weight: z.number().min(0).max(1) })
      .parse(request.body);
    return service.setTasteWeight(id, weight);
  });

  app.post("/journeys/:id/music-wishes", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const payload = musicWishSchema.parse(request.body);
    const result = await service.createMusicWish(id, payload);
    return reply.code(201).send(result);
  });

  app.get("/journeys/:id/music-wishes", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    service.getJourneyOrThrow(id);
    return {
      active: store.listActiveMusicWishes(id),
      recent: store.listRecentMusicWishes(id),
    };
  });

  app.patch("/journeys/:id/music-wishes/:wishId", async (request) => {
    const { id, wishId } = z.object({ id: z.string(), wishId: z.string() }).parse(request.params);
    const payload = musicWishPatchSchema.parse(request.body);
    return service.updateMusicWish(id, wishId, payload);
  });

  app.post("/journeys/:id/music-wishes/:wishId/undo", async (request) => {
    const { id, wishId } = z.object({ id: z.string(), wishId: z.string() }).parse(request.params);
    return service.undoMusicWish(id, wishId);
  });

  app.post("/journeys/:id/playback/skip", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const payload = z
      .object({
        direction: z.enum(["next", "previous"]),
        deviceId: z.string().min(1).optional(),
      })
      .parse(request.body);
    return service.skipSpotifyTrack(id, payload.direction, payload.deviceId);
  });

  app.post("/journeys/:id/playback/device", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const payload = deviceSchema.parse(request.body);
    return service.registerSpotifyDevice(id, payload.deviceId, payload.status, {
      syncOnly: payload.syncOnly,
      transfer: payload.transfer,
    });
  });

  app.get("/spotify/devices", async () => {
    const devices = await service.listSpotifyDevices();
    return { devices };
  });

  app.post("/journeys/:id/playback/transport", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const payload = z
      .object({
        action: z.enum(["pause", "resume"]),
        deviceId: z.string().min(1).optional(),
      })
      .parse(request.body);
    return service.setSpotifyTransport(id, payload.action, payload.deviceId);
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
      Connection: "keep-alive",
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
    journeys: store.listJourneys(),
  }));

  app.get("/history/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return {
      journey: service.getJourneyOrThrow(id),
      latestUpdate: store.latestPlaylistUpdate(id),
      tracks: store.listResolvedTracks(id),
      playbackSession: store.getPlaybackSession(id),
      events: store.auditEvents(id),
    };
  });
}
