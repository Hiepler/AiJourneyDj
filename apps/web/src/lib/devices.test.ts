import { describe, expect, it } from "vitest";

import { activeDeviceLabel } from "./devices.js";

const devices = [
  { id: "d1", name: "Phone", type: "Smartphone", isActive: false, isRestricted: false },
  { id: "d2", name: "Tesla Model Y", type: "Automobile", isActive: true, isRestricted: false }
];

describe("activeDeviceLabel", () => {
  it("returns the chosen device name", () => {
    expect(activeDeviceLabel(devices, "d2")).toBe("Tesla Model Y");
  });

  it("falls back to 'This browser' when the id is unknown/empty", () => {
    expect(activeDeviceLabel(devices, undefined)).toBe("This browser");
    expect(activeDeviceLabel(devices, "missing")).toBe("This browser");
  });
});
