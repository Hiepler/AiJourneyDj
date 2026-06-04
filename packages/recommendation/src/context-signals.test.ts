import { describe, expect, it } from "vitest";

import { alertnessFloor, timeOfDayBand, tripArc } from "./context-signals";

describe("timeOfDayBand", () => {
  it("maps hours to bands at the boundaries", () => {
    expect(timeOfDayBand(0)).toBe("deep_night");
    expect(timeOfDayBand(3)).toBe("deep_night");
    expect(timeOfDayBand(4)).toBe("dawn");
    expect(timeOfDayBand(6)).toBe("dawn");
    expect(timeOfDayBand(7)).toBe("morning");
    expect(timeOfDayBand(10)).toBe("morning");
    expect(timeOfDayBand(11)).toBe("midday");
    expect(timeOfDayBand(14)).toBe("midday");
    expect(timeOfDayBand(15)).toBe("afternoon");
    expect(timeOfDayBand(17)).toBe("afternoon");
    expect(timeOfDayBand(18)).toBe("golden");
    expect(timeOfDayBand(20)).toBe("golden");
    expect(timeOfDayBand(21)).toBe("night");
    expect(timeOfDayBand(23)).toBe("night");
  });

  it("falls back to midday for non-finite input", () => {
    expect(timeOfDayBand(Number.NaN)).toBe("midday");
  });
});

describe("tripArc", () => {
  it("computes progress and segment from elapsed vs planned", () => {
    expect(tripArc(0, 120, 120)).toMatchObject({ progress: 0, segment: "opening" });
    expect(tripArc(30, 120, 90)).toMatchObject({ segment: "body" });
    expect(tripArc(90, 120, 30)).toMatchObject({ segment: "deep" });
    expect(tripArc(110, 120, 10)).toMatchObject({ segment: "closing" });
  });

  it("treats remaining ETA <= 15 as closing regardless of progress", () => {
    expect(tripArc(20, 600, 12).segment).toBe("closing");
  });

  it("extends total when ETA grows beyond the original plan", () => {
    // planned 60, but elapsed 50 + remaining 40 = 90 effective total
    const arc = tripArc(50, 60, 40);
    expect(arc.progress).toBeCloseTo(50 / 90, 5);
    expect(arc.progress).toBeLessThanOrEqual(1);
  });

  it("falls back to elapsed+remaining when planned is missing", () => {
    expect(tripArc(30, undefined, 30).progress).toBeCloseTo(0.5, 5);
  });

  it("returns opening with progress 0 when no duration is known", () => {
    expect(tripArc(0, undefined, undefined)).toMatchObject({
      progress: 0,
      segment: "opening",
    });
  });

  it("flags long-haul trips", () => {
    expect(tripArc(10, 240, 230).longHaul).toBe(true);
    expect(tripArc(10, 120, 110).longHaul).toBe(false);
  });
});

describe("alertnessFloor", () => {
  it("raises an energy floor on a long deep-night drive", () => {
    const floor = alertnessFloor("deep_night", 200, "steady", "highway");
    expect(floor).toBeGreaterThan(0.42);
    expect(floor).toBeLessThanOrEqual(0.54);
  });

  it("returns 0 for a short daytime drive", () => {
    expect(alertnessFloor("midday", 20, "steady", "city")).toBe(0);
  });

  it("returns 0 for a short late-evening hop below the risk threshold", () => {
    // night alone = 0.3 risk, below the 0.4 activation threshold
    expect(alertnessFloor("night", 15, "steady", "city")).toBe(0);
  });

  it("activates the floor for deep_night even on a short drive", () => {
    // deep_night alone = 0.5 risk, above threshold
    expect(alertnessFloor("deep_night", 10, "steady", "city")).toBeGreaterThan(0);
  });

  it("adds risk for slowing pace (monotony/drowsiness)", () => {
    const steady = alertnessFloor("night", 150, "steady", "highway");
    const slowing = alertnessFloor("night", 150, "slowing", "highway");
    expect(slowing).toBeGreaterThan(steady);
  });
});
