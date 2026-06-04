import type { Track } from "./api.js";

export function queueTracksInPlaybackOrder(
  tracks: Track[],
  queuedTrackIds: string[],
): Track[] {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  return queuedTrackIds
    .map((id) => byId.get(id))
    .filter((track): track is Track => Boolean(track));
}
