import type { NormalizedTelemetryEvent } from "@ai-journey-dj/core";
import { normalizeFleetVehicleData } from "@ai-journey-dj/telemetry";

import type { AppConfig } from "../config/env.js";
import type { TeslaAuthService } from "../auth/teslaAuth.js";
import type { JourneyService } from "../journeys/journeyService.js";
import type { Store } from "../db/store.js";
import { makeGeocoder } from "./geocoder.js";

export interface PollDeps {
  apiBaseUrl: string;
  accessToken: string;
  vehicleId?: string;
  hasActiveJourney: () => boolean;
  ingest: (event: NormalizedTelemetryEvent) => Promise<void>;
  geocode: (lat: number, lon: number) => Promise<string | undefined>;
  appSecret: string;
  fetchImpl: typeof fetch;
}

/** A single poll tick. Returns silently when it should not (or cannot) read vehicle data. */
export async function pollTeslaOnce(deps: PollDeps): Promise<void> {
  if (!deps.hasActiveJourney()) return;

  const auth = { Authorization: `Bearer ${deps.accessToken}` };
  const base = deps.apiBaseUrl.replace(/\/$/, "");

  // Resolve the vehicle id + online state without waking the car.
  const listResponse = await deps.fetchImpl(`${base}/api/1/vehicles`, { headers: auth });
  if (!listResponse.ok) return;
  const list = (await listResponse.json()) as { response?: Array<{ id_s?: string; id?: number; state?: string }> };
  const vehicles = list.response ?? [];
  const vehicle = deps.vehicleId ? vehicles.find((v) => v.id_s === deps.vehicleId) : vehicles[0];
  if (!vehicle || vehicle.state !== "online") return; // asleep/offline → never force-wake

  const id = vehicle.id_s ?? String(vehicle.id);
  const endpoints = encodeURIComponent("drive_state;charge_state;climate_state");
  const dataResponse = await deps.fetchImpl(`${base}/api/1/vehicles/${id}/vehicle_data?endpoints=${endpoints}`, {
    headers: auth
  });
  if (!dataResponse.ok) return; // 408 asleep etc.

  const payload = (await dataResponse.json()) as { response?: Record<string, unknown> };
  const { coordinates, ...event } = normalizeFleetVehicleData(payload.response ?? {}, deps.appSecret);
  if (coordinates) {
    event.coarseRegion = await deps.geocode(coordinates.lat, coordinates.lon);
  }
  await deps.ingest(event);
}

export function startTeslaFleetPoller(
  config: AppConfig,
  store: Store,
  teslaAuth: TeslaAuthService,
  journeyService: JourneyService,
  logger: { warn: (obj: Record<string, unknown>, msg?: string) => void }
): NodeJS.Timeout | undefined {
  if (!config.TESLA_FLEET_ENABLED) return undefined;
  const geocode = makeGeocoder({ baseUrl: config.GEOCODER_URL });

  const tick = async () => {
    try {
      if (store.listActiveJourneys().length === 0) return;
      const accessToken = await teslaAuth.getAccessToken();
      await pollTeslaOnce({
        apiBaseUrl: config.TESLA_API_BASE_URL,
        accessToken,
        vehicleId: config.TESLA_VEHICLE_ID,
        hasActiveJourney: () => store.listActiveJourneys().length > 0,
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
