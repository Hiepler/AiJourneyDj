import { describe, expect, it } from "vitest";

import { buildContextPills } from "./driveContext.js";

describe("buildContextPills", () => {
  it("returns no pills when context is missing", () => {
    expect(buildContextPills(undefined)).toEqual([]);
  });

  it("emits only pills with values; hides unknown pace and missing eta/weather", () => {
    const pills = buildContextPills({ phase: "golden_hour", coarseRegion: "Burgundy", speedBucket: "unknown" });
    const keys = pills.map((pill) => pill.key);
    expect(keys).toEqual(["phase", "region"]);
    expect(pills.find((pill) => pill.key === "phase")?.value).toBe("Golden Hour");
    expect(pills.find((pill) => pill.key === "region")?.value).toBe("Burgundy");
  });

  it("includes pace, eta and weather when present, in canonical order", () => {
    const pills = buildContextPills({
      phase: "cruise",
      speedBucket: "highway",
      etaMinutes: 75,
      temperatureBucket: "warm",
      coarseRegion: "Northern Italy"
    });
    expect(pills.map((pill) => pill.key)).toEqual(["phase", "tempo", "eta", "weather", "region"]);
    expect(pills.find((pill) => pill.key === "tempo")?.value).toBe("Highway");
    expect(pills.find((pill) => pill.key === "eta")?.value).toMatch(/75/);
    expect(pills.find((pill) => pill.key === "weather")?.value).toBe("Warm");
  });
});
