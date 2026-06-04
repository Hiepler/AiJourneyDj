import { describe, expect, it } from "vitest";

import type { Track } from "./api.js";
import { queueTracksInPlaybackOrder } from "./queue.js";

function track(id: string, artist: string, title = id): Track {
  return {
    id,
    provider: "spotify",
    providerTrackId: id,
    artist,
    title,
    matchConfidence: 0.9,
    matchReason: "test",
    addedToPlaylist: true,
  };
}

describe("queueTracksInPlaybackOrder", () => {
  it("orders visible queue rows by playback queuedTrackIds", () => {
    const tracks = [
      track("old-chart", "The Killers"),
      track("nina", "Nina Chuba", "Fata Morgana"),
      track("malcolm", "Malcolm Todd"),
    ];

    expect(
      queueTracksInPlaybackOrder(tracks, ["nina", "malcolm", "old-chart"]).map(
        (item) => item.artist,
      ),
    ).toEqual(["Nina Chuba", "Malcolm Todd", "The Killers"]);
  });

  it("drops stale queued ids that are missing from track detail", () => {
    expect(queueTracksInPlaybackOrder([track("nina", "Nina Chuba")], ["missing", "nina"])).toEqual([
      track("nina", "Nina Chuba"),
    ]);
  });
});
