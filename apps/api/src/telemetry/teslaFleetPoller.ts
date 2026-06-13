import type { NormalizedTelemetryEvent } from "@ai-journey-dj/core";
import { normalizeFleetVehicleData } from "@ai-journey-dj/telemetry";

import type { AppConfig } from "../config/env.js";
import type { TeslaAuthService } from "../auth/teslaAuth.js";
import type { JourneyService } from "../journeys/journeyService.js";
import type { Store } from "../db/store.js";
import { makeGeocodeResolver, type GeocodeResult } from "./geocoder.js";
import type { StreamLiveness } from "./streamSource.js";
import { shouldPollRest } from "./streamSource.js";

export interface PollDeps {
  apiBaseUrl: string;
  accessToken: string;
  /** Resolves the target vehicle id (configured or discovered+cached) — avoids a per-tick list call. */
  resolveVehicleId: () => Promise<string | undefined>;
  hasActiveJourney: () => boolean;
  /** When provided and true, streaming is live → the REST tick stands down (no API call). */
  streamingIsFresh?: () => boolean;
  ingest: (event: NormalizedTelemetryEvent) => Promise<void>;
  geocode: (
    lat: number,
    lon: number,
  ) => Promise<string | GeocodeResult | undefined>;
  appSecret: string;
  fetchImpl: typeof fetch;
}

/** Inputs for a single on-demand `vehicle_data` read — no journey/streaming gates. */
export interface LiveReadDeps {
  apiBaseUrl: string;
  accessToken: string;
  resolveVehicleId: () => Promise<string | undefined>;
  geocode: (
    lat: number,
    lon: number,
  ) => Promise<string | GeocodeResult | undefined>;
  appSecret: string;
  fetchImpl: typeof fetch;
}

/**
 * Performs one on-demand `vehicle_data` read and returns the normalized, geocoded event — or
 * `undefined` when no vehicle is resolvable or the car is asleep/offline (Tesla 408). This is the
 * pure I/O core shared by the background poll tick and the on-demand reader; it applies no journey
 * or streaming gates so it can run before a journey even exists (e.g. to pre-fill the start screen).
 *
 * Calling `vehicle_data` does NOT wake a sleeping car — Tesla returns 408 for an asleep/offline
 * vehicle, which we treat as "no reading".
 */
export async function readLiveTeslaReading(
  deps: LiveReadDeps,
): Promise<NormalizedTelemetryEvent | undefined> {
  const id = await deps.resolveVehicleId();
  if (!id) return undefined; // no vehicle configured/discoverable

  const auth = { Authorization: `Bearer ${deps.accessToken}` };
  const base = deps.apiBaseUrl.replace(/\/$/, "");
  const endpoints = encodeURIComponent(
    "drive_state;charge_state;climate_state",
  );
  const dataResponse = await deps.fetchImpl(
    `${base}/api/1/vehicles/${id}/vehicle_data?endpoints=${endpoints}`,
    {
      headers: auth,
    },
  );
  if (!dataResponse.ok) return undefined; // 408 asleep/offline (does not wake the car)

  const payload = (await dataResponse.json()) as {
    response?: Record<string, unknown>;
  };
  const { coordinates, ...event } = normalizeFleetVehicleData(
    payload.response ?? {},
    deps.appSecret,
  );
  if (coordinates) {
    const geocoded = await deps.geocode(coordinates.lat, coordinates.lon);
    if (typeof geocoded === "string") {
      event.coarseRegion = geocoded;
    } else if (geocoded) {
      event.coarseRegion = geocoded.coarseRegion;
      event.countryName = geocoded.countryName;
      event.countryCode = geocoded.countryCode;
      event.geoSource = geocoded.geoSource;
    }
  }
  return event;
}

/**
 * A single poll tick. Cost-optimized: it does NOT list vehicles every tick. Instead it resolves the
 * vehicle id once (configured or discovered+cached) and calls `vehicle_data` directly.
 *
 * Calling `vehicle_data` does NOT wake a sleeping car — Tesla returns 408 for an asleep/offline
 * vehicle, which we treat as "skip". This halves billed requests on every online (driving) tick
 * versus the previous list-then-data approach. Returns silently when it should not read data.
 */
export async function pollTeslaOnce(deps: PollDeps): Promise<void> {
  if (!deps.hasActiveJourney()) return;
  if (deps.streamingIsFresh?.()) return; // streaming is live → no REST call needed

  const event = await readLiveTeslaReading({
    apiBaseUrl: deps.apiBaseUrl,
    accessToken: deps.accessToken,
    resolveVehicleId: deps.resolveVehicleId,
    geocode: deps.geocode,
    appSecret: deps.appSecret,
    fetchImpl: deps.fetchImpl,
  });
  if (!event) return;
  await deps.ingest(event);
}

/**
 * Builds a vehicle-id resolver that returns a configured id immediately, or discovers it via a
 * single `/api/1/vehicles` call and caches it for the lifetime of the poller. After the first
 * discovery no further list calls are made — the main cost saving alongside `pollTeslaOnce`.
 */
export function makeVehicleIdResolver(opts: {
  apiBaseUrl: string;
  configuredVehicleId?: string;
  getAccessToken: () => Promise<string>;
  fetchImpl: typeof fetch;
}): () => Promise<string | undefined> {
  let cached = opts.configuredVehicleId;
  return async () => {
    if (cached) return cached;
    const base = opts.apiBaseUrl.replace(/\/$/, "");
    const token = await opts.getAccessToken();
    const res = await opts.fetchImpl(`${base}/api/1/vehicles`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return undefined;
    const list = (await res.json()) as {
      response?: Array<{ id_s?: string; id?: number }>;
    };
    const vehicle = (list.response ?? [])[0];
    cached =
      vehicle?.id_s ?? (vehicle?.id != null ? String(vehicle.id) : undefined);
    return cached;
  };
}

export function startTeslaFleetPoller(
  config: AppConfig,
  store: Store,
  teslaAuth: TeslaAuthService,
  journeyService: JourneyService,
  liveness: StreamLiveness,
  logger: { warn: (obj: Record<string, unknown>, msg?: string) => void },
): NodeJS.Timeout | undefined {
  if (!config.TESLA_FLEET_ENABLED) return undefined;
  const geocode = makeGeocodeResolver({ baseUrl: config.GEOCODER_URL });
  // Resolver persists across ticks so the vehicle id is discovered at most once.
  const resolveVehicleId = makeVehicleIdResolver({
    apiBaseUrl: config.TESLA_API_BASE_URL,
    configuredVehicleId: config.TESLA_VEHICLE_ID,
    getAccessToken: () => teslaAuth.getAccessToken(),
    fetchImpl: fetch,
  });

  const tick = async () => {
    try {
      if (store.listActiveJourneys().length === 0) return;
      const accessToken = await teslaAuth.getAccessToken();
      await pollTeslaOnce({
        apiBaseUrl: config.TESLA_API_BASE_URL,
        accessToken,
        resolveVehicleId,
        hasActiveJourney: () => store.listActiveJourneys().length > 0,
        streamingIsFresh: () =>
          !shouldPollRest(
            liveness.lastIso(),
            Date.now(),
            config.STREAM_FRESH_WINDOW_SECONDS * 1000,
          ),
        ingest: (event) => journeyService.ingestTelemetry(event),
        geocode,
        appSecret: config.APP_SECRET,
        fetchImpl: fetch,
      });
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "tesla.poll_error",
      );
    }
  };

  return setInterval(() => void tick(), config.TESLA_POLL_SECONDS * 1000);
}

/** Minimal auth surface the on-demand reader needs (kept narrow for testability). */
export interface LiveReaderAuth {
  isConnected(): boolean;
  getAccessToken(): Promise<string>;
}

/** On-demand live telemetry: a one-shot read, independent of the background poll cadence. */
export interface TeslaLiveReader {
  /** True when Fleet polling is enabled and the car is connected, so a read can be attempted. */
  available(): boolean;
  /** Fetch one fresh reading now, or `undefined` if unavailable / asleep / it times out. Never throws. */
  read(timeoutMs?: number): Promise<NormalizedTelemetryEvent | undefined>;
}

/**
 * Builds a reader that fetches the car's *current* state on demand — used to pre-fill the start
 * screen and to seed a journey's very first queue with live context, instead of waiting up to a full
 * `TESLA_POLL_SECONDS` for the background poller. The vehicle id is discovered once and cached, so
 * repeated reads cost a single `vehicle_data` call. Degrades silently: a missing vehicle, an asleep
 * car (408), a timeout, or any error resolves to `undefined` so callers can fall back gracefully.
 */
export function createTeslaLiveReader(deps: {
  config: AppConfig;
  teslaAuth: LiveReaderAuth;
  logger?: { warn: (obj: Record<string, unknown>, msg?: string) => void };
  fetchImpl?: typeof fetch;
}): TeslaLiveReader {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const geocode = makeGeocodeResolver({ baseUrl: deps.config.GEOCODER_URL });
  const resolveVehicleId = makeVehicleIdResolver({
    apiBaseUrl: deps.config.TESLA_API_BASE_URL,
    configuredVehicleId: deps.config.TESLA_VEHICLE_ID,
    getAccessToken: () => deps.teslaAuth.getAccessToken(),
    fetchImpl,
  });

  const available = () =>
    deps.config.TESLA_FLEET_ENABLED && deps.teslaAuth.isConnected();

  return {
    available,
    async read(timeoutMs = 4000) {
      if (!available()) return undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const accessToken = await deps.teslaAuth.getAccessToken();
        return await readLiveTeslaReading({
          apiBaseUrl: deps.config.TESLA_API_BASE_URL,
          accessToken,
          resolveVehicleId,
          geocode,
          appSecret: deps.config.APP_SECRET,
          fetchImpl: (input, init) =>
            fetchImpl(input, { ...init, signal: controller.signal }),
        });
      } catch (error) {
        deps.logger?.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "tesla.live_read_error",
        );
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
