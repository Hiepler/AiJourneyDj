import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import Fastify from "fastify";

import { NoopOpenMusicClient, OpenMusicClient } from "@ai-journey-dj/open-music";
import { createSongScout } from "@ai-journey-dj/recommendation";
import { MockSpotifyAdapter, OfficialSpotifyAdapter } from "@ai-journey-dj/spotify";
import { MockTidalAdapter, OfficialTidalAdapter } from "@ai-journey-dj/tidal";

import type { AppConfig } from "./config/env.js";
import { appBaseUrl } from "./http/appBaseUrl.js";
import { migrate, openDatabase } from "./db/database.js";
import { Store } from "./db/store.js";
import { SpotifyAuthService } from "./auth/spotifyAuth.js";
import { TidalAuthService } from "./auth/tidalAuth.js";
import { JourneyService } from "./journeys/journeyService.js";
import { registerJourneyRoutes } from "./journeys/routes.js";
import { registerTelemetryRoutes } from "./telemetry/routes.js";

export async function buildApp(config: AppConfig) {
  const db = openDatabase(config.DATABASE_PATH);
  migrate(db);
  const store = new Store(db);
  const tidalAuth = new TidalAuthService(config, store);
  const spotifyAuth = new SpotifyAuthService(config, store);
  const tidalAdapter = config.TIDAL_MOCK
    ? new MockTidalAdapter()
    : new OfficialTidalAdapter({ baseUrl: config.TIDAL_API_BASE_URL });
  const spotifyAdapter = config.SPOTIFY_MOCK
    ? new MockSpotifyAdapter()
    : new OfficialSpotifyAdapter({ baseUrl: config.SPOTIFY_API_BASE_URL });
  const { scout: songScout, info: songScoutInfo } = createSongScout({
    provider: config.SONG_SCOUT,
    mock: config.XAI_MOCK,
    gemini: {
      apiKey: config.GEMINI_API_KEY,
      baseUrl: config.GEMINI_BASE_URL,
      model: config.GEMINI_MODEL,
      mock: config.XAI_MOCK,
      requestTimeoutMs: config.SONG_SCOUT_TIMEOUT_MS
    },
    xai: {
      apiKey: config.XAI_API_KEY,
      baseUrl: config.XAI_BASE_URL,
      model: config.XAI_MODEL,
      mock: config.XAI_MOCK,
      requestTimeoutMs: config.SONG_SCOUT_TIMEOUT_MS
    }
  });
  const openMusic = config.XAI_MOCK
    ? new NoopOpenMusicClient()
    : new OpenMusicClient({
        musicBrainzBaseUrl: config.MUSICBRAINZ_BASE_URL,
        listenBrainzBaseUrl: config.LISTENBRAINZ_BASE_URL,
        userAgent: "AIJourneyDJ/0.1.0 (https://github.com/ai-journey-dj/ai-journey-dj)"
      });
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info"
    }
  });

  const journeyService = new JourneyService(
    config,
    store,
    tidalAuth,
    tidalAdapter,
    spotifyAuth,
    spotifyAdapter,
    songScout,
    openMusic,
    app.log
  );

  await app.register(cors, {
    origin: (origin, callback) => {
      const allowed = config.CORS_ORIGIN.split(",").map((item) => item.trim());
      if (
        !origin ||
        allowed.includes(origin) ||
        /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(
          origin
        )
      ) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed by CORS."), false);
    },
    credentials: true
  });
  await app.register(sensible);

  app.get("/health", async () => {
    const spotifyConnected = spotifyAuth.isConnected();
    const spotifyPremium = spotifyConnected ? await spotifyAuth.isPremium() : false;
    return {
      ok: true,
      tidalConnected: tidalAuth.isConnected(),
      tidalMock: config.TIDAL_MOCK,
      spotifyConnected,
      spotifyMock: config.SPOTIFY_MOCK,
      spotifyPremium,
      xaiMock: config.XAI_MOCK,
      songScout: songScoutInfo,
      telemetryEnabled: config.TESLA_TELEMETRY_ENABLED,
      journeyRefreshMinutes: config.JOURNEY_REFRESH_MINUTES
    };
  });

  app.get("/auth/spotify/login", async (request, reply) => {
    const returnBase = appBaseUrl(request, config);
    try {
      if (config.SPOTIFY_MOCK) {
        return reply.redirect(`${returnBase}/?spotify=mock`);
      }
      return reply.redirect(spotifyAuth.createLoginUrl());
    } catch (error) {
      const message = encodeURIComponent(error instanceof Error ? error.message : String(error));
      return reply.redirect(`${returnBase}/?spotify=error&message=${message}`);
    }
  });

  app.get("/auth/spotify/callback", async (request, reply) => {
    const returnBase = appBaseUrl(request, config);
    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (query.error) {
      const message = encodeURIComponent(query.error_description ?? query.error);
      return reply.redirect(`${returnBase}/?spotify=error&message=${message}`);
    }

    try {
      await spotifyAuth.completeCallback(query);
    } catch (error) {
      const message = encodeURIComponent(error instanceof Error ? error.message : String(error));
      return reply.redirect(`${returnBase}/?spotify=error&message=${message}`);
    }

    return reply.type("text/html").send(`<!doctype html>
      <html>
        <head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${returnBase}/?spotify=connected"></head>
        <body><a href="${returnBase}/?spotify=connected">Return to AI Journey DJ</a></body>
      </html>`);
  });

  app.get("/auth/spotify/token", async () => spotifyAuth.getTokenStatus());

  app.post("/auth/spotify/disconnect", async () => {
    spotifyAuth.disconnect();
    return { ok: true };
  });

  app.get("/auth/tidal/login", async (request, reply) => {
    const returnBase = appBaseUrl(request, config);
    try {
      if (config.TIDAL_MOCK) {
        return reply.redirect(`${returnBase}/?tidal=mock`);
      }
      return reply.redirect(tidalAuth.createLoginUrl());
    } catch (error) {
      const message = encodeURIComponent(error instanceof Error ? error.message : String(error));
      return reply.redirect(`${returnBase}/?tidal=error&message=${message}`);
    }
  });

  app.get("/auth/tidal/callback", async (request, reply) => {
    const returnBase = appBaseUrl(request, config);
    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (query.error) {
      const message = encodeURIComponent(query.error_description ?? query.error);
      return reply.redirect(`${returnBase}/?tidal=error&message=${message}`);
    }

    try {
      await tidalAuth.completeCallback(query);
    } catch (error) {
      const message = encodeURIComponent(error instanceof Error ? error.message : String(error));
      return reply.redirect(`${returnBase}/?tidal=error&message=${message}`);
    }

    return reply.type("text/html").send(`<!doctype html>
      <html>
        <head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${returnBase}/?tidal=connected"></head>
        <body><a href="${returnBase}/?tidal=connected">Return to AI Journey DJ</a></body>
      </html>`);
  });

  app.post("/auth/tidal/disconnect", async () => {
    tidalAuth.disconnect();
    return { ok: true };
  });

  await registerJourneyRoutes(app, journeyService, store, tidalAuth, spotifyAuth);
  await registerTelemetryRoutes(app, config, journeyService);

  return { app, store, journeyService };
}
