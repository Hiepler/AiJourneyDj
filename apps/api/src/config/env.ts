import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

// Anchor relative paths to the API package root (apps/api), not the process CWD, so the
// database location is deterministic regardless of where the server is launched from.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function envBoolean(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return defaultValue;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) {
        return true;
      }
      if (["false", "0", "no", "off"].includes(normalized)) {
        return false;
      }
    }
    return Boolean(value);
  }, z.boolean());
}

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().default(3000),
  API_BASE_URL: z.string().url().default("http://localhost:3000"),
  APP_BASE_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  APP_SECRET: z.string().default("local-development-secret-change-me"),
  DATABASE_PATH: z.string().default("./data/ai-journey-dj.db"),
  SIMULATOR_TOKEN: z.string().default("local-dev-simulator-token"),
  TIDAL_CLIENT_ID: z.string().optional(),
  TIDAL_CLIENT_SECRET: z.string().optional(),
  TIDAL_REDIRECT_URI: z.string().url().default("http://localhost:3000/auth/tidal/callback"),
  TIDAL_AUTHORIZATION_URL: z.string().url().default("https://login.tidal.com/authorize"),
  TIDAL_TOKEN_URL: z.string().url().default("https://auth.tidal.com/v1/oauth2/token"),
  TIDAL_API_BASE_URL: z.string().url().default("https://openapi.tidal.com/v2/"),
  TIDAL_COUNTRY_CODE: z.string().default("DE"),
  TIDAL_MOCK: envBoolean(true),
  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),
  SPOTIFY_REDIRECT_URI: z.string().url().default("http://localhost:3000/auth/spotify/callback"),
  SPOTIFY_AUTHORIZATION_URL: z.string().url().default("https://accounts.spotify.com/authorize"),
  SPOTIFY_TOKEN_URL: z.string().url().default("https://accounts.spotify.com/api/token"),
  SPOTIFY_API_BASE_URL: z.string().url().default("https://api.spotify.com/v1"),
  SPOTIFY_MARKET: z.string().default("DE"),
  SPOTIFY_MOCK: envBoolean(true),
  // External-skip reconciliation poller (native Tesla Spotify miniplayer sync).
  SPOTIFY_PLAYBACK_POLL_ENABLED: envBoolean(true),
  SPOTIFY_PLAYBACK_POLL_ACTIVE_SECONDS: z.coerce.number().int().min(2).default(5),
  SPOTIFY_PLAYBACK_POLL_IDLE_SECONDS: z.coerce.number().int().min(5).default(30),
  SPOTIFY_REFILL_THRESHOLD: z.coerce.number().int().min(0).default(3),
  SPOTIFY_REFILL_MIN_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(60),
  // Adaptive Drive Mode (comfort feature; biases selection from telemetry, not a safety system).
  ADAPTIVE_DRIVE_MODE_ENABLED: envBoolean(true),
  XAI_API_KEY: z.string().optional(),
  XAI_BASE_URL: z.string().url().default("https://api.x.ai/v1"),
  XAI_MODEL: z.string().default("grok-4.3"),
  // XAI_MOCK is the shared "mock all AI providers" switch (also gates open-music enrichment).
  XAI_MOCK: envBoolean(true),
  // Song scout provider: multilens (default) = telemetry-brief + parallel lenses + diversity
  // balancing; gemini = single grounded call; xai = Grok web_search.
  SONG_SCOUT: z.enum(["multilens", "gemini", "xai"]).default("multilens"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta"),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash"),
  // Hard cap on the LLM song-scout request so a hung provider can never block a journey.
  SONG_SCOUT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  // Multi-lens cost levers: songs requested per lens and output-token cap per lens call.
  SONG_SCOUT_PER_LENS: z.coerce.number().int().min(2).max(12).default(5),
  SONG_SCOUT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(8192).default(2048),
  MUSICBRAINZ_BASE_URL: z.string().url().default("https://musicbrainz.org/ws/2"),
  LISTENBRAINZ_BASE_URL: z.string().url().default("https://api.listenbrainz.org/1"),
  TESLA_FLEET_ENABLED: envBoolean(false),
  TESLA_CLIENT_ID: z.string().optional(),
  TESLA_CLIENT_SECRET: z.string().optional(),
  TESLA_OAUTH_AUTH_URL: z.string().url().default("https://auth.tesla.com/oauth2/v3/authorize"),
  TESLA_OAUTH_TOKEN_URL: z.string().url().default("https://auth.tesla.com/oauth2/v3/token"),
  TESLA_API_BASE_URL: z.string().url().default("https://fleet-api.prd.eu.vn.cloud.tesla.com"),
  TESLA_REDIRECT_URI: z.string().url().default("http://localhost:3000/auth/tesla/callback"),
  TESLA_PUBLIC_KEY_PEM: z.string().default(""),
  TESLA_VEHICLE_ID: z.string().optional(),
  // Telemetry poll cadence. Default 120s keeps Fleet API cost low (each tick = one billed
  // vehicle_data request); drive context (phase/traffic/ETA) changes slowly enough for this.
  TESLA_POLL_SECONDS: z.coerce.number().int().min(10).default(120),
  GEOCODER_URL: z.string().url().default("https://nominatim.openstreetmap.org/reverse"),
  TESLA_TELEMETRY_ENABLED: envBoolean(false),
  KAFKA_BROKERS: z.string().default("localhost:19092"),
  TESLA_TELEMETRY_TOPIC: z.string().default("tesla.telemetry.normalized"),
  MQTT_URL: z.string().default("mqtt://localhost:1883"),
  MQTT_TOPIC: z.string().default("tesla/telemetry"),
  STREAM_FRESH_WINDOW_SECONDS: z.coerce.number().int().min(1).default(30),
  JOURNEY_REFRESH_MINUTES: z.coerce.number().int().min(1).default(12)
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env = process.env) {
  const config = schema.parse(env);
  const databasePath = isAbsolute(config.DATABASE_PATH)
    ? config.DATABASE_PATH
    : resolve(packageRoot, config.DATABASE_PATH);
  mkdirSync(dirname(databasePath), { recursive: true });

  return {
    ...config,
    DATABASE_PATH: databasePath,
    kafkaBrokers: config.KAFKA_BROKERS.split(",").map((broker) => broker.trim()).filter(Boolean),
    journeyRefreshMs: config.JOURNEY_REFRESH_MINUTES * 60_000
  };
}
