import { describe, expect, it } from "vitest";

import { normalizeFleetVehicleData, normalizeTeslaPayload } from "./index.js";

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
    expect((event as Record<string, unknown>).latitude).toBeUndefined();
    expect((event as Record<string, unknown>).longitude).toBeUndefined();
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
});
