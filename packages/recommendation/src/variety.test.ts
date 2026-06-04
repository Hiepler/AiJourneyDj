import { describe, expect, it } from "vitest";

import {
  EXPLORATION_ANGLES,
  hashString,
  makeVarietyContext,
  mulberry32,
  rotateWindow,
  seededExplorationAngle,
  seededJitter,
} from "./variety.js";

describe("variety core", () => {
  it("hashString is deterministic and stays a uint32", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
    expect(hashString("x")).toBeGreaterThanOrEqual(0);
    expect(hashString("x")).toBeLessThanOrEqual(0xffffffff);
  });

  it("mulberry32 is deterministic and yields values in [0,1)", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const first = a();
    expect(first).toBe(b());
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
  });

  it("makeVarietyContext is stable for the same inputs and differs per journey", () => {
    const base = {
      journeyId: "journey-1",
      elapsedMinutes: 0,
      bucketMinutes: 20,
      phase: "cruise",
      speedBucket: "highway",
    };
    expect(makeVarietyContext(base)).toEqual(makeVarietyContext(base));
    expect(makeVarietyContext(base).seed).not.toBe(
      makeVarietyContext({ ...base, journeyId: "journey-2" }).seed,
    );
  });

  it("the rotation bucket advances with elapsed time and telemetry changes", () => {
    const base = {
      journeyId: "journey-1",
      bucketMinutes: 20,
      phase: "cruise",
      speedBucket: "highway",
    };
    const t0 = makeVarietyContext({ ...base, elapsedMinutes: 0 });
    const t40 = makeVarietyContext({ ...base, elapsedMinutes: 40 });
    const phaseChange = makeVarietyContext({ ...base, elapsedMinutes: 0, phase: "golden_hour" });
    expect(t40.bucket).not.toBe(t0.bucket);
    expect(t40.seed).not.toBe(t0.seed);
    expect(phaseChange.bucket).not.toBe(t0.bucket);
  });

  it("seededJitter is deterministic per (seed,key) and bounded", () => {
    expect(seededJitter(42, "a - b")).toBe(seededJitter(42, "a - b"));
    expect(seededJitter(42, "a - b")).not.toBe(seededJitter(42, "c - d"));
    const v = seededJitter(7, "x - y");
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it("rotateWindow wraps around and keeps the requested count", () => {
    const items = [1, 2, 3, 4, 5];
    expect(rotateWindow(items, 3, 3)).toEqual([4, 5, 1]);
    expect(rotateWindow(items, 0, 2)).toEqual([1, 2]);
    expect(rotateWindow([], 3, 3)).toEqual([]);
    expect(rotateWindow(items, 1, 10)).toHaveLength(5);
  });

  it("seededExplorationAngle returns a stable angle from the list", () => {
    expect(seededExplorationAngle(2)).toBe(EXPLORATION_ANGLES[2 % EXPLORATION_ANGLES.length]);
    expect(seededExplorationAngle(2)).toBe(seededExplorationAngle(2));
  });
});
