import { createHash } from "node:crypto";

import type {
  JourneyPhase,
  NormalizedTelemetryEvent,
  SpeedBucket,
  TemperatureBucket
} from "@ai-journey-dj/core";

export function hashVehicleId(vehicleId: string, secret: string): string {
  return createHash("sha256").update(`${secret}:${vehicleId}`).digest("hex").slice(0, 24);
}

export function speedBucket(speedKph?: number): SpeedBucket {
  if (typeof speedKph !== "number") return "unknown";
  if (speedKph < 3) return "parked";
  if (speedKph < 55) return "city";
  if (speedKph < 95) return "country";
  return "highway";
}

export function temperatureBucket(tempC?: number): TemperatureBucket {
  if (typeof tempC !== "number") return "unknown";
  if (tempC < 5) return "cold";
  if (tempC < 13) return "cool";
  if (tempC < 22) return "mild";
  if (tempC < 30) return "warm";
  return "hot";
}

export function derivePhase(event: NormalizedTelemetryEvent, previous?: JourneyPhase): JourneyPhase {
  if (typeof event.etaMinutes === "number" && event.etaMinutes <= 15) return "arrival";
  const hour = new Date(event.timestampIso).getHours();
  if (hour >= 17 && hour <= 20) return "golden_hour";
  if (event.autopilotState === "active") return "focus";
  if (previous === "departure" && event.etaMinutes && event.etaMinutes > 30) return "cruise";
  return previous ?? "departure";
}

export function normalizeTeslaPayload(payload: Record<string, unknown>, appSecret: string): NormalizedTelemetryEvent {
  const vehicleId = String(payload.vin ?? payload.vehicle_id ?? payload.VehicleId ?? "unknown");
  const speedMps = Number(payload.VehicleSpeed ?? payload.speed ?? payload.speed_mps ?? Number.NaN);
  const speedKph = Number.isFinite(speedMps) ? Math.round(speedMps * 3.6) : undefined;
  const timestamp = String(payload.createdAt ?? payload.timestamp ?? new Date().toISOString());

  return {
    vehicleIdHash: vehicleId === "unknown" ? undefined : hashVehicleId(vehicleId, appSecret),
    timestampIso: timestamp,
    coarseRegion: typeof payload.coarseRegion === "string" ? payload.coarseRegion : undefined,
    destination: typeof payload.destination === "string" ? payload.destination : undefined,
    etaMinutes: typeof payload.etaMinutes === "number" ? payload.etaMinutes : undefined,
    speedKph,
    outsideTempC: typeof payload.OutsideTemp === "number" ? payload.OutsideTemp : undefined,
    autopilotState:
      payload.AutopilotState === "ACTIVE"
        ? "active"
        : payload.AutopilotState === "AVAILABLE"
          ? "available"
          : "unknown",
    batteryPercent: typeof payload.Soc === "number" ? payload.Soc : undefined
  };
}

export function simulatedTelemetry(step: number, destination = "Lago di Garda"): NormalizedTelemetryEvent {
  const etaMinutes = Math.max(8, 140 - step * 7);
  return {
    timestampIso: new Date(Date.now() + step * 60_000).toISOString(),
    coarseRegion: step < 8 ? "Alps" : "Northern Italy",
    destination,
    etaMinutes,
    speedKph: etaMinutes < 15 ? 48 : 112,
    outsideTempC: etaMinutes < 40 ? 24 : 18,
    autopilotState: etaMinutes < 20 ? "off" : "active",
    batteryPercent: Math.max(20, 82 - step)
  };
}
