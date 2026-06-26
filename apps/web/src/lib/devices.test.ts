import { describe, expect, it } from "vitest";

import { activeDeviceLabel, shouldAutoAdoptConnectDevice } from "./devices.js";

const devices = [
  { id: "d1", name: "Phone", type: "Smartphone", isActive: false, isRestricted: false },
  { id: "d2", name: "Tesla Model Y", type: "Automobile", isActive: true, isRestricted: false }
];

describe("activeDeviceLabel", () => {
  it("returns the chosen device name", () => {
    expect(activeDeviceLabel(devices, "d2")).toBe("Tesla Model Y");
  });

  it("uses neutral Connect labels when the id is unknown/empty", () => {
    expect(activeDeviceLabel(devices, undefined)).toBe("Spotify Connect");
    expect(activeDeviceLabel(devices, "missing")).toBe("Spotify Connect device");
  });
});

describe("shouldAutoAdoptConnectDevice", () => {
  it("allows auto-adopt only before a Connect device is bound", () => {
    expect(
      shouldAutoAdoptConnectDevice({
        activeJourneyId: "journey-1",
        isSpotifyJourney: true,
        spotifyMock: false,
        sessionStatus: "ready",
        boundDeviceId: undefined,
        activeDeviceId: "native-tesla-app",
        autoTakeoverDeviceId: undefined,
      }),
    ).toBe(true);

    expect(
      shouldAutoAdoptConnectDevice({
        activeJourneyId: "journey-1",
        isSpotifyJourney: true,
        spotifyMock: false,
        sessionStatus: "ready",
        boundDeviceId: "native-tesla-app",
        activeDeviceId: "this-browser",
        autoTakeoverDeviceId: undefined,
      }),
    ).toBe(false);
  });

  it("does not auto-adopt while playback is already established", () => {
    expect(
      shouldAutoAdoptConnectDevice({
        activeJourneyId: "journey-1",
        isSpotifyJourney: true,
        spotifyMock: false,
        sessionStatus: "playing",
        boundDeviceId: undefined,
        activeDeviceId: "this-browser",
        autoTakeoverDeviceId: undefined,
      }),
    ).toBe(false);
  });
});
