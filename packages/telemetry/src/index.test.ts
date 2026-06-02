import { describe, expect, it } from "vitest";

import { normalizeFleetStream, normalizeFleetVehicleData, normalizeTeslaPayload } from "./index.js";

describe("tesla telemetry mapping", () => {
  it("treats streaming VehicleSpeed as mph (not m/s)", () => {
    // 60 mph ≈ 97 km/h. The old code multiplied by 3.6 (m/s) → 216, which was wrong.
    const event = normalizeTeslaPayload({ VehicleSpeed: 60 }, "secret");
    expect(event.speedKph).toBe(97);
  });

  it("maps vehicle_data drive/charge/climate state into a normalized event", () => {
    const event = normalizeFleetVehicleData(
      {
        vin: "5YJ3E1EA7KF000000",
        drive_state: {
          timestamp: 1717000000000,
          speed: 60, // mph
          shift_state: "D",
          latitude: 48.137,
          longitude: 11.575,
          active_route_destination: "Lago di Garda",
          active_route_minutes_to_arrival: 73.4
        },
        charge_state: { usable_battery_level: 64 },
        climate_state: { outside_temp: 21.5 }
      },
      "secret"
    );

    expect(event.speedKph).toBe(97); // 60 mph → km/h
    expect(event.destination).toBe("Lago di Garda");
    expect(event.etaMinutes).toBe(73);
    expect(event.outsideTempC).toBe(21.5);
    expect(event.batteryPercent).toBe(64);
    expect(event.vehicleIdHash).toBeDefined();
    // Raw GPS must never appear on the normalized event.
    expect((event as unknown as Record<string, unknown>).latitude).toBeUndefined();
    expect((event as unknown as Record<string, unknown>).longitude).toBeUndefined();
  });

  it("omits navigation + speed fields when parked / not navigating", () => {
    const event = normalizeFleetVehicleData(
      { drive_state: { speed: null, shift_state: "P" }, charge_state: {}, climate_state: {} },
      "secret"
    );
    expect(event.speedKph).toBeUndefined();
    expect(event.destination).toBeUndefined();
    expect(event.etaMinutes).toBeUndefined();
  });

  it("exposes transient coordinates separately for geocoding", () => {
    const { coordinates } = normalizeFleetVehicleData(
      { drive_state: { latitude: 48.1, longitude: 11.5 }, charge_state: {}, climate_state: {} },
      "secret"
    );
    expect(coordinates).toEqual({ lat: 48.1, lon: 11.5 });
  });

  it("maps adaptive-drive signals (traffic delay, energy-at-arrival, audio volume)", () => {
    const event = normalizeFleetVehicleData(
      {
        drive_state: { active_route_traffic_minutes_delay: 13.6, active_route_energy_at_arrival: 8 },
        charge_state: {},
        climate_state: {},
        media_info: { audio_volume: 5.5 }
      },
      "secret"
    );
    expect(event.trafficDelayMinutes).toBe(14); // rounded
    expect(event.energyPercentAtArrival).toBe(8);
    expect(event.audioVolume).toBe(5.5);
  });

  it("leaves adaptive-drive signals undefined when not navigating / no media", () => {
    const event = normalizeFleetVehicleData(
      { drive_state: { speed: 30 }, charge_state: {}, climate_state: {} },
      "secret"
    );
    expect(event.trafficDelayMinutes).toBeUndefined();
    expect(event.energyPercentAtArrival).toBeUndefined();
    expect(event.audioVolume).toBeUndefined();
  });

  it("normalizeFleetStream maps streaming fields incl. real-time driving signals", () => {
    const { coordinates, ...event } = normalizeFleetStream(
      {
        vin: "VIN1",
        VehicleSpeed: 60, // mph
        Location: { latitude: 48.1, longitude: 11.5 },
        Soc: 64,
        OutsideTemp: 21,
        MinutesToArrival: 73.4,
        RouteTrafficMinutesDelay: 12,
        LongitudinalAcceleration: -2.5,
        BrakePedal: true,
        LightsHazardsActive: false
      },
      "secret"
    );
    expect(event.speedKph).toBe(97); // 60 mph
    expect(event.batteryPercent).toBe(64);
    expect(event.etaMinutes).toBe(73);
    expect(event.trafficDelayMinutes).toBe(12);
    expect(event.longitudinalAccelMps2).toBe(-2.5);
    expect(event.brakePedal).toBe(true);
    expect(event.hazardsActive).toBe(false);
    expect(coordinates).toEqual({ lat: 48.1, lon: 11.5 });
    // Raw GPS must never appear on the normalized event.
    expect((event as Record<string, unknown>).Location).toBeUndefined();
  });

  it("normalizeFleetStream leaves unknown/missing fields undefined", () => {
    const { coordinates, ...event } = normalizeFleetStream({ vin: "VIN1", VehicleSpeed: 30 }, "secret");
    expect(event.speedKph).toBe(48);
    expect(event.brakePedal).toBeUndefined();
    expect(event.hazardsActive).toBeUndefined();
    expect(event.longitudinalAccelMps2).toBeUndefined();
    expect(coordinates).toBeUndefined();
  });
});
