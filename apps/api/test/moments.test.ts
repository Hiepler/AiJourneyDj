import { describe, expect, it } from "vitest";

import { detectJourneyMoment } from "../src/playback/moments.js";

const NOW = Date.parse("2026-06-12T17:00:00.000Z");
const cfg = {
  jamDelayMinutes: 10,
  releaseDelayMinutes: 3,
  cooldownMs: 25 * 60 * 1000,
  arrivalWindowMinutes: 10,
};

function snap(over: Record<string, unknown>) {
  return { timestampIso: new Date(NOW).toISOString(), ...over } as any;
}

describe("detectJourneyMoment", () => {
  it("detects a sustained traffic jam (two snapshots)", () => {
    const moment = detectJourneyMoment({
      context: { phase: "cruise" } as any,
      history: [
        snap({ trafficDelayMinutes: 14 }),
        snap({ trafficDelayMinutes: 12 }),
      ],
      previousPhase: "cruise",
      act: "act_one",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment?.type).toBe("traffic_jam");
    expect(moment!.energyBias).toBeLessThan(0);
  });

  it("detects the release lift after a jam", () => {
    const moment = detectJourneyMoment({
      context: { phase: "cruise" } as any,
      history: [
        snap({ trafficDelayMinutes: 1 }),
        snap({ trafficDelayMinutes: 14 }),
      ],
      previousPhase: "cruise",
      act: "act_one",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment?.type).toBe("traffic_release");
    expect(moment!.energyBias).toBeGreaterThan(0);
    expect(moment!.priorityTrackRequest).toBe("banger");
  });

  it("border crossing wins over traffic and requests local charts", () => {
    const moment = detectJourneyMoment({
      context: { phase: "cruise" } as any,
      history: [
        snap({ countryCode: "IT", countryName: "Italy", trafficDelayMinutes: 1 }),
        snap({ countryCode: "DE", countryName: "Germany", trafficDelayMinutes: 14 }),
      ],
      previousPhase: "cruise",
      act: "act_one",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment?.type).toBe("border_crossing");
    expect(moment!.candidateRequest).toEqual({
      kind: "geo-charts",
      country: "Italy",
    });
  });

  it("golden hour fires only on the phase transition", () => {
    const args = {
      context: { phase: "golden_hour" } as any,
      history: [snap({})],
      act: "climax" as const,
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    };
    expect(
      detectJourneyMoment({ ...args, previousPhase: "cruise" })?.type,
    ).toBe("golden_hour");
    expect(
      detectJourneyMoment({ ...args, previousPhase: "golden_hour" }),
    ).toBeUndefined();
  });

  it("arrival fires inside the eta window and requests the anthem", () => {
    const moment = detectJourneyMoment({
      context: { phase: "arrival", etaMinutes: 8 } as any,
      history: [snap({ etaMinutes: 8 })],
      previousPhase: "arrival",
      act: "finale",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment?.type).toBe("arrival");
    expect(moment!.candidateRequest).toEqual({ kind: "taste-anchor" });
  });

  it("does NOT fire arrival at an interim charge stop (next nav target is a charger)", () => {
    const moment = detectJourneyMoment({
      context: {
        phase: "arrival",
        etaMinutes: 8,
        destination: "Supercharger Kassel",
        finalDestination: "Lago di Garda",
      } as any,
      history: [snap({ etaMinutes: 8, batteryPercent: 14 })],
      previousPhase: "cruise",
      act: "act_one",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment?.type).not.toBe("arrival");
  });

  it("fires arrival when the nav target IS the final destination", () => {
    const moment = detectJourneyMoment({
      context: {
        phase: "arrival",
        etaMinutes: 8,
        destination: "Lago di Garda",
        finalDestination: "Lago di Garda",
      } as any,
      history: [snap({ etaMinutes: 8, batteryPercent: 70 })],
      previousPhase: "arrival",
      act: "finale",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment?.type).toBe("arrival");
  });

  it("still fires arrival at the final destination even on low battery (name matches)", () => {
    const moment = detectJourneyMoment({
      context: {
        phase: "arrival",
        etaMinutes: 8,
        destination: "Lago di Garda",
        finalDestination: "Lago di Garda",
      } as any,
      history: [snap({ etaMinutes: 8, batteryPercent: 12 })],
      previousPhase: "arrival",
      act: "finale",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment?.type).toBe("arrival");
  });

  it("respects the per-type cooldown", () => {
    const lastMomentAt = new Map([["traffic_jam", NOW - 60_000]]);
    const moment = detectJourneyMoment({
      context: { phase: "cruise" } as any,
      history: [
        snap({ trafficDelayMinutes: 14 }),
        snap({ trafficDelayMinutes: 12 }),
      ],
      previousPhase: "cruise",
      act: "act_one",
      lastMomentAt,
      nowMs: NOW,
      config: cfg,
    });
    expect(moment).toBeUndefined();
  });

  it("temp swing triggers on a >=6°C jump across the history", () => {
    const moment = detectJourneyMoment({
      context: { phase: "cruise" } as any,
      history: [snap({ outsideTempC: 24 }), snap({ outsideTempC: 12 })],
      previousPhase: "cruise",
      act: "act_one",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment?.type).toBe("temp_swing");
  });

  it("charge approach fires when battery runs low", () => {
    const moment = detectJourneyMoment({
      context: { phase: "cruise" } as any,
      history: [snap({ batteryPercent: 15 }), snap({ batteryPercent: 16 })],
      previousPhase: "cruise",
      act: "act_one",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment?.type).toBe("charge_approach");
    expect(moment!.energyBias).toBeLessThan(0);
  });

  it("charge approach also fires on low predicted energy at arrival", () => {
    const moment = detectJourneyMoment({
      context: { phase: "cruise" } as any,
      history: [snap({ batteryPercent: 45, energyPercentAtArrival: 8 })],
      previousPhase: "cruise",
      act: "act_one",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment?.type).toBe("charge_approach");
  });

  it("charge resume fires on a sustained battery jump and requests local charts", () => {
    const moment = detectJourneyMoment({
      context: { phase: "cruise" } as any,
      history: [
        snap({ batteryPercent: 82, countryName: "France", countryCode: "FR" }),
        snap({ batteryPercent: 80, countryName: "France", countryCode: "FR" }),
        snap({ batteryPercent: 20, countryName: "France", countryCode: "FR" }),
        snap({ batteryPercent: 18, countryName: "France", countryCode: "FR" }),
      ],
      previousPhase: "cruise",
      act: "act_one",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment?.type).toBe("charge_resume");
    expect(moment!.energyBias).toBeGreaterThan(0);
    expect(moment!.candidateRequest).toEqual({
      kind: "geo-charts",
      country: "France",
    });
  });

  it("does not fire charge resume on a single-sample SoC blip", () => {
    const moment = detectJourneyMoment({
      context: { phase: "cruise" } as any,
      history: [
        snap({ batteryPercent: 80 }),
        snap({ batteryPercent: 20 }),
        snap({ batteryPercent: 18 }),
      ],
      previousPhase: "cruise",
      act: "act_one",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment).toBeUndefined();
  });

  it("charge resume fires on a real charging→complete transition (even a tiny SoC delta)", () => {
    const moment = detectJourneyMoment({
      context: { phase: "cruise" } as any,
      history: [
        snap({
          chargingState: "complete",
          batteryPercent: 38,
          countryName: "Italy",
          countryCode: "IT",
        }),
        snap({ chargingState: "charging", batteryPercent: 36 }),
        snap({ chargingState: "charging", batteryPercent: 35 }),
      ],
      previousPhase: "cruise",
      act: "act_one",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment?.type).toBe("charge_resume");
    expect(moment!.candidateRequest).toEqual({
      kind: "geo-charts",
      country: "Italy",
    });
  });

  it("does not fire charge approach while the car is actively charging", () => {
    const moment = detectJourneyMoment({
      context: { phase: "cruise" } as any,
      history: [snap({ chargingState: "charging", batteryPercent: 15 })],
      previousPhase: "cruise",
      act: "act_one",
      lastMomentAt: new Map(),
      nowMs: NOW,
      config: cfg,
    });
    expect(moment?.type).not.toBe("charge_approach");
  });
});
