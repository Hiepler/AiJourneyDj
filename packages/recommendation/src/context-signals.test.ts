import { describe, expect, it } from "vitest";

import {
  alertnessFloor,
  archetypeStrategy,
  dayContextFrom,
  effectiveTripMinutes,
  timeOfDayBand,
  tripArc,
  tripArchetype,
  weatherFeel,
} from "./context-signals";

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

describe("effectiveTripMinutes", () => {
  it("uses the longer of planned vs elapsed+remaining", () => {
    expect(effectiveTripMinutes(50, 60, 40)).toBe(90); // 50+40 > 60
    expect(effectiveTripMinutes(10, 120, 30)).toBe(120); // planned wins
    expect(effectiveTripMinutes(30, undefined, 30)).toBe(60);
  });
});

describe("dayContextFrom", () => {
  it("classifies weekend vs weekday and builds a daypart key", () => {
    // 2026-06-14 is a Sunday, 2026-06-15 a Monday.
    expect(dayContextFrom("2026-06-14T10:00:00", "morning")).toEqual({
      dayKind: "weekend",
      daypartKey: "sunday_morning",
    });
    expect(dayContextFrom("2026-06-15T08:00:00", "morning")).toEqual({
      dayKind: "weekday",
      daypartKey: "monday_morning",
    });
  });
});

describe("tripArchetype", () => {
  it("classifies by effective length, daypart and weekday", () => {
    expect(tripArchetype(20, "afternoon", "weekend")).toBe("errand");
    expect(tripArchetype(45, "morning", "weekday")).toBe("commute");
    expect(tripArchetype(120, "midday", "weekend")).toBe("day_trip");
    expect(tripArchetype(300, "morning", "weekday")).toBe("long_haul");
  });

  it("treats a weekday-midday 45-min hop as a day_trip (not a commute band)", () => {
    expect(tripArchetype(45, "midday", "weekday")).toBe("day_trip");
  });

  it("treats a 45-min weekend morning drive as a day_trip, not a commute", () => {
    expect(tripArchetype(45, "morning", "weekend")).toBe("day_trip");
  });

  it("uses the boundaries: <25 errand, >180 long_haul", () => {
    expect(tripArchetype(24, "midday", "weekend")).toBe("errand");
    expect(tripArchetype(25, "midday", "weekend")).toBe("day_trip");
    expect(tripArchetype(180, "midday", "weekend")).toBe("day_trip");
    expect(tripArchetype(181, "midday", "weekend")).toBe("long_haul");
  });
});

describe("archetypeStrategy", () => {
  it("leans familiar + compresses the opening for errands", () => {
    const s = archetypeStrategy("errand");
    expect(s.compressOpening).toBe(true);
    expect(s.tasteWeightBias).toBeGreaterThan(0);
  });

  it("opens up exploration for long hauls without compressing", () => {
    const s = archetypeStrategy("long_haul");
    expect(s.compressOpening).toBe(false);
    expect(s.explorationBias).toBeGreaterThan(0);
  });
});

describe("weatherFeel", () => {
  it("returns undefined when temperature is unknown", () => {
    expect(weatherFeel(undefined, "midday")).toBeUndefined();
    expect(weatherFeel(Number.NaN, "midday")).toBeUndefined();
  });

  it("derives evocative phrasing from temp and band", () => {
    expect(weatherFeel(2, "morning")).toBe("crisp, frosty morning");
    expect(weatherFeel(25, "golden")).toBe("warm and golden");
    expect(weatherFeel(33, "midday")).toBe("bright midday heat");
    expect(weatherFeel(2, "night")).toBe("cold, clear night");
  });

  it("adds a soft seasonal adjective when a month is provided", () => {
    // January (month 0), cold → wintry prefix.
    expect(weatherFeel(2, "morning", 0)).toBe("wintry crisp, frosty morning");
    // July (month 6), hot → high-summer prefix.
    expect(weatherFeel(33, "midday", 6)).toBe("high-summer bright midday heat");
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
