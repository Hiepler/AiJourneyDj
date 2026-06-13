import { describe, expect, it } from "vitest";

import { driveStoryAct } from "./driveStory.js";

describe("driveStory", () => {
  const base = { plannedDurationMinutes: 100, etaMinutes: 60, isFirstPass: false };

  it("maps progress onto acts", () => {
    expect(driveStoryAct({ ...base, elapsedMinutes: 10 }).act).toBe("act_one");
    expect(driveStoryAct({ ...base, elapsedMinutes: 45 }).act).toBe("interlude");
    expect(driveStoryAct({ ...base, elapsedMinutes: 70 }).act).toBe("climax");
    expect(
      driveStoryAct({ ...base, elapsedMinutes: 90, etaMinutes: 12 }).act,
    ).toBe("finale");
  });

  it("first pass is the opening regardless of progress", () => {
    const opening = driveStoryAct({ ...base, elapsedMinutes: 0, isFirstPass: true });
    expect(opening.act).toBe("opening");
    expect(opening.directive.length).toBeGreaterThan(10);
  });

  it("acts carry energy offsets and degrade silently without planned duration", () => {
    expect(
      driveStoryAct({ ...base, elapsedMinutes: 70 }).energyOffset,
    ).toBeGreaterThan(0);
    const degraded = driveStoryAct({
      elapsedMinutes: 70,
      plannedDurationMinutes: undefined,
      etaMinutes: undefined,
      isFirstPass: false,
    });
    expect(degraded.act).toBe("act_one");
    expect(degraded.energyOffset).toBe(0);
  });

  it("eta inside the arrival window forces the finale", () => {
    expect(
      driveStoryAct({
        ...base,
        elapsedMinutes: 20,
        etaMinutes: 8,
        arrivalWindowMinutes: 10,
      }).act,
    ).toBe("finale");
  });
});
