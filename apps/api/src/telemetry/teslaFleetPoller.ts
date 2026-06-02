import type { NormalizedTelemetryEvent } from "@ai-journey-dj/core";
import { normalizeFleetVehicleData } from "@ai-journey-dj/telemetry";

import type { AppConfig } from "../config/env.js";
import type { TeslaAuthService } from "../auth/teslaAuth.js";
import type { JourneyService } from "../journeys/journeyService.js";
import type { Store } from "../db/store.js";
import { makeGeocoder } from "./geocoder.js";
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
  geocode: (lat: number, lon: number) => Promise<string | undefined>;
  appSecret: string;
  fetchImpl: typeof fetch;
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

  const id = await deps.resolveVehicleId();
  if (!id) return; // no vehicle configured/discoverable

  const auth = { Authorization: `Bearer ${deps.accessToken}` };
  const base = deps.apiBaseUrl.replace(/\/$/, "");
  const endpoints = encodeURIComponent("drive_state;charge_state;climate_state");
  const dataResponse = await deps.fetchImpl(`${base}/api/1/vehicles/${id}/vehicle_data?endpoints=${endpoints}`, {
    headers: auth
  });
  if (!dataResponse.ok) return; // 408 asleep/offline (does not wake the car) → skip

  const payload = (await dataResponse.json()) as { response?: Record<string, unknown> };
  const { coordinates, ...event } = normalizeFleetVehicleData(payload.response ?? {}, deps.appSecret);
  if (coordinates) {
    event.coarseRegion = await deps.geocode(coordinates.lat, coordinates.lon);
  }
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
    const res = await opts.fetchImpl(`${base}/api/1/vehicles`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return undefined;
    const list = (await res.json()) as { response?: Array<{ id_s?: string; id?: number }> };
    const vehicle = (list.response ?? [])[0];
    cached = vehicle?.id_s ?? (vehicle?.id != null ? String(vehicle.id) : undefined);
    return cached;
  };
}

export function startTeslaFleetPoller(
  config: AppConfig,
  store: Store,
  teslaAuth: TeslaAuthService,
  journeyService: JourneyService,
  liveness: StreamLiveness,
  logger: { warn: (obj: Record<string, unknown>, msg?: string) => void }
): NodeJS.Timeout | undefined {
  if (!config.TESLA_FLEET_ENABLED) return undefined;
  const geocode = makeGeocoder({ baseUrl: config.GEOCODER_URL });
  // Resolver persists across ticks so the vehicle id is discovered at most once.
  const resolveVehicleId = makeVehicleIdResolver({
    apiBaseUrl: config.TESLA_API_BASE_URL,
    configuredVehicleId: config.TESLA_VEHICLE_ID,
    getAccessToken: () => teslaAuth.getAccessToken(),
    fetchImpl: fetch
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
          !shouldPollRest(liveness.lastIso(), Date.now(), config.STREAM_FRESH_WINDOW_SECONDS * 1000),
        ingest: (event) => journeyService.ingestTelemetry(event),
        geocode,
        appSecret: config.APP_SECRET,
        fetchImpl: fetch
      });
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, "tesla.poll_error");
    }
  };

  return setInterval(() => void tick(), config.TESLA_POLL_SECONDS * 1000);
}
