import { describe, expect, it } from "vitest";

import { buildContextPills, telemetryLiveness } from "./driveContext.js";

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
    expect(pills.find((pill) => pill.key === "eta")?.value).toBe("1 h 15 min");
    expect(pills.find((pill) => pill.key === "weather")?.value).toBe("Warm");
  });

  it("formats a sub-hour eta as minutes", () => {
    const pills = buildContextPills({ phase: "departure", etaMinutes: 45, coarseRegion: "X" });
    expect(pills.find((pill) => pill.key === "eta")?.value).toBe("45 min");
  });

  it("surfaces privacy-safe drive trends when present", () => {
    const pills = buildContextPills({
      phase: "cruise",
      speedBucket: "highway",
      paceTrend: "accelerating",
      etaTrend: "approaching",
      autopilotState: "active"
    });

    expect(pills.map((pill) => pill.key)).toEqual(["phase", "tempo", "pace-trend", "eta-trend", "assist"]);
    expect(pills.find((pill) => pill.key === "pace-trend")?.value).toBe("Accelerating");
    expect(pills.find((pill) => pill.key === "eta-trend")?.value).toBe("Approaching");
    expect(pills.find((pill) => pill.key === "assist")?.value).toBe("Autopilot");
  });
});

describe("telemetryLiveness", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");

  it("reports none when no telemetry has ever arrived", () => {
    expect(telemetryLiveness(undefined, now)).toEqual({ state: "none", label: "Keine Live-Daten" });
  });

  it("reports none for an unparseable timestamp", () => {
    expect(telemetryLiveness("not-a-date", now).state).toBe("none");
  });

  it("treats a very recent reading as live with 'gerade eben'", () => {
    const result = telemetryLiveness("2026-06-01T11:59:58.000Z", now);
    expect(result.state).toBe("live");
    expect(result.label).toBe("Live · gerade eben");
  });

  it("shows seconds for a reading within the live window", () => {
    const result = telemetryLiveness("2026-06-01T11:59:15.000Z", now); // 45s ago
    expect(result.state).toBe("live");
    expect(result.label).toBe("Live · vor 45s");
  });

  it("is still live at the 3-minute boundary", () => {
    const result = telemetryLiveness("2026-06-01T11:57:00.000Z", now); // 180s
    expect(result.state).toBe("live");
  });

  it("becomes stale just past the threshold and shows minutes", () => {
    const result = telemetryLiveness("2026-06-01T11:55:00.000Z", now); // 5 min ago
    expect(result.state).toBe("stale");
    expect(result.label).toBe("Zuletzt vor 5 min");
  });

  it("shows hours for very old readings", () => {
    const result = telemetryLiveness("2026-06-01T10:00:00.000Z", now); // 2h ago
    expect(result.state).toBe("stale");
    expect(result.label).toBe("Zuletzt vor 2 Std");
  });

  it("never reports negative ages for clock skew", () => {
    const result = telemetryLiveness("2026-06-01T12:00:30.000Z", now); // 30s in the future
    expect(result.state).toBe("live");
    if (result.state === "none") throw new Error("expected a dated reading");
    expect(result.secondsAgo).toBe(0);
  });
});
