import type { SpotifyDevice } from "./api.js";

/** Display name for the currently-selected device id (defaults to the browser player). */
export function activeDeviceLabel(devices: SpotifyDevice[], id: string | undefined): string {
  if (!id) return "This browser";
  return devices.find((device) => device.id === id)?.name ?? "This browser";
}
