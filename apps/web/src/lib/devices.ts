import type { SpotifyDevice } from "./api.js";

/** Display name for the currently-selected Connect device. */
export function activeDeviceLabel(
  devices: SpotifyDevice[],
  id: string | undefined,
): string {
  if (!id) return "Spotify Connect";
  return (
    devices.find((device) => device.id === id)?.name ?? "Spotify Connect device"
  );
}

export function shouldAutoAdoptConnectDevice(input: {
  activeJourneyId?: string;
  isSpotifyJourney: boolean;
  spotifyMock?: boolean;
  sessionStatus?: string;
  boundDeviceId?: string;
  activeDeviceId?: string;
  autoTakeoverDeviceId?: string;
}): boolean {
  if (!input.activeJourneyId || !input.isSpotifyJourney || input.spotifyMock) {
    return false;
  }
  if (input.boundDeviceId) {
    return false;
  }
  if (input.sessionStatus === "playing" || input.sessionStatus === "paused") {
    return false;
  }
  return Boolean(
    input.activeDeviceId && input.autoTakeoverDeviceId !== input.activeDeviceId,
  );
}
