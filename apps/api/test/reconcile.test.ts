import { describe, expect, it } from "vitest";

import { nextPollIntervalSeconds, playbackOwnership, reconcilePlaybackModel, shouldRegenerate } from "../src/playback/reconcile.js";

describe("playbackOwnership", () => {
  const dev = "tesla-web-device";

  it("hands over when a podcast/episode is playing", () => {
    expect(
      playbackOwnership({ isPlaying: true, currentlyPlayingType: "episode", activeDeviceId: dev, journeyDeviceId: dev }),
    ).toBe("handed-over");
  });

  it("stays owned for a journey track on a different device (we follow Connect, not hand over)", () => {
    // The user moved our journey to another Connect device (e.g. the native Tesla app). That is
    // not a takeover — the backend follows the active device and keeps curating there.
    expect(
      playbackOwnership({ isPlaying: true, currentlyPlayingType: "track", activeDeviceId: "phone-xyz", journeyDeviceId: dev }),
    ).toBe("owned");
  });

  it("still hands over to a podcast even on a different device", () => {
    expect(
      playbackOwnership({ isPlaying: true, currentlyPlayingType: "episode", activeDeviceId: "phone-xyz", journeyDeviceId: dev }),
    ).toBe("handed-over");
  });

  it("hands over on an off-journey (external) track", () => {
    expect(
      playbackOwnership({ isPlaying: true, currentlyPlayingType: "track", activeDeviceId: dev, journeyDeviceId: dev, reconcileKind: "external" }),
    ).toBe("handed-over");
  });

  it("stays owned for a journey track on the journey device", () => {
    expect(
      playbackOwnership({ isPlaying: true, currentlyPlayingType: "track", activeDeviceId: dev, journeyDeviceId: dev, reconcileKind: "same" }),
    ).toBe("owned");
  });

  it("stays owned when nothing is playing (idle, not a takeover)", () => {
    expect(playbackOwnership({ isPlaying: false, currentlyPlayingType: "episode", activeDeviceId: "phone" })).toBe("owned");
  });

  it("stays owned on ads (neutral, don't hand over)", () => {
    expect(
      playbackOwnership({ isPlaying: true, currentlyPlayingType: "ad", activeDeviceId: dev, journeyDeviceId: dev }),
    ).toBe("owned");
  });

  it("does not hand over on device mismatch when the journey device is unknown", () => {
    expect(
      playbackOwnership({ isPlaying: true, currentlyPlayingType: "track", activeDeviceId: "phone" }),
    ).toBe("owned");
  });
});

describe("reconcilePlaybackModel", () => {
  const model = ["t-active", "t-q1", "t-q2", "t-q3"];

  it("returns empty when there is no model", () => {
    expect(reconcilePlaybackModel([], "anything")).toEqual({ kind: "empty", index: -1 });
  });

  it("treats nothing-playing as no drift", () => {
    expect(reconcilePlaybackModel(model, undefined)).toEqual({ kind: "same", index: 0 });
  });

  it("detects the active track still playing (no skip)", () => {
    expect(reconcilePlaybackModel(model, "t-active")).toEqual({ kind: "same", index: 0 });
  });

  it("detects a single skip into the queue", () => {
    expect(reconcilePlaybackModel(model, "t-q1")).toEqual({ kind: "skipped", index: 1 });
  });

  it("detects skipping several tracks ahead", () => {
    expect(reconcilePlaybackModel(model, "t-q3")).toEqual({ kind: "skipped", index: 3 });
  });

  it("flags an off-journey track not in the model as external", () => {
    expect(reconcilePlaybackModel(model, "some-foreign-track")).toEqual({ kind: "external", index: -1 });
  });

  it("re-anchors (drifted) when the track is ours but outside the model", () => {
    // Spotify's queue is append-only: stale adds and wish rebuilds can put one of OUR
    // journey tracks on air at a position the 6-slot model no longer shows. That must
    // re-anchor the model, not pause curation as "external".
    expect(
      reconcilePlaybackModel(model, "t-ours-old", new Set(["t-ours-old", "t-active"])),
    ).toEqual({ kind: "drifted", index: -1 });
  });

  it("still flags foreign tracks as external even with a known set", () => {
    expect(
      reconcilePlaybackModel(model, "some-foreign-track", new Set(["t-ours-old"])),
    ).toEqual({ kind: "external", index: -1 });
  });

  it("prefers the model position over the known set", () => {
    expect(reconcilePlaybackModel(model, "t-q1", new Set(["t-q1"]))).toEqual({
      kind: "skipped",
      index: 1,
    });
  });
});

describe("nextPollIntervalSeconds", () => {
  const cfg = { activeSeconds: 5, idleSeconds: 30 };

  it("polls fast while actively playing a curated track", () => {
    expect(nextPollIntervalSeconds("playing", cfg)).toBe(5);
  });

  it("backs off when idle", () => {
    expect(nextPollIntervalSeconds("idle", cfg)).toBe(30);
  });

  it("backs off when off-journey (external)", () => {
    expect(nextPollIntervalSeconds("external", cfg)).toBe(30);
  });
});

describe("shouldRegenerate", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");
  const minInterval = 60_000;

  it("allows regeneration when nothing was ever generated", () => {
    expect(shouldRegenerate(undefined, now, minInterval)).toBe(true);
  });

  it("allows regeneration for an unparseable timestamp", () => {
    expect(shouldRegenerate("nonsense", now, minInterval)).toBe(true);
  });

  it("blocks regeneration within the throttle window", () => {
    expect(shouldRegenerate("2026-06-01T11:59:30.000Z", now, minInterval)).toBe(false); // 30s ago
  });

  it("allows regeneration once the throttle window elapsed", () => {
    expect(shouldRegenerate("2026-06-01T11:58:00.000Z", now, minInterval)).toBe(true); // 2 min ago
  });

  it("allows regeneration exactly at the boundary", () => {
    expect(shouldRegenerate("2026-06-01T11:59:00.000Z", now, minInterval)).toBe(true); // 60s ago
  });
});
