import { describe, expect, it } from "vitest";

import { nextPollIntervalSeconds, reconcilePlaybackModel, shouldRegenerate } from "../src/playback/reconcile.js";

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
