import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

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
  XAI_API_KEY: z.string().optional(),
  XAI_BASE_URL: z.string().url().default("https://api.x.ai/v1"),
  XAI_MODEL: z.string().default("grok-4.3"),
  XAI_MOCK: envBoolean(true),
  MUSICBRAINZ_BASE_URL: z.string().url().default("https://musicbrainz.org/ws/2"),
  LISTENBRAINZ_BASE_URL: z.string().url().default("https://api.listenbrainz.org/1"),
  TESLA_TELEMETRY_ENABLED: envBoolean(false),
  KAFKA_BROKERS: z.string().default("localhost:19092"),
  TESLA_TELEMETRY_TOPIC: z.string().default("tesla.telemetry.normalized"),
  JOURNEY_REFRESH_MINUTES: z.coerce.number().int().min(1).default(12)
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env = process.env) {
  const config = schema.parse(env);
  const databasePath = resolve(config.DATABASE_PATH);
  mkdirSync(dirname(databasePath), { recursive: true });

  return {
    ...config,
    DATABASE_PATH: databasePath,
    kafkaBrokers: config.KAFKA_BROKERS.split(",").map((broker) => broker.trim()).filter(Boolean),
    journeyRefreshMs: config.JOURNEY_REFRESH_MINUTES * 60_000
  };
}
