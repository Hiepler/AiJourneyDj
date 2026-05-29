import { describe, expect, it } from "vitest";

import type { JourneyContext, ResolvedTrack } from "@ai-journey-dj/core";

import {
  assertJourneyContextIsPrivacySafe,
  assertPromptIsPrivacySafe,
  buildJourneyPrompt,
  extractXaiResponseText,
  fallbackCandidates,
  resolveXaiModel,
  selectRollingBatch
} from "./index.js";

const context: JourneyContext = {
  destination: "Lago di Garda",
  coarseRegion: "Northern Italy",
  localTimeIso: "2026-05-28T18:00:00.000Z",
  weatherFeel: "warm and clear",
  etaMinutes: 95,
  speedBucket: "highway",
  temperatureBucket: "warm",
  phase: "golden_hour",
  userPrompt: "cinematic but focused",
  passengerMode: "couple"
};

describe("recommendation", () => {
  it("builds prompts without raw provider or vehicle data", () => {
    const prompt = buildJourneyPrompt(context, 8).toLowerCase();

    expect(prompt).not.toContain("playlist id");
    expect(prompt).not.toMatch(/\bvin\b/);
    expect(prompt).not.toContain("latitude");
    expect(prompt).not.toContain("longitude");
    expect(prompt).toContain("northern italy");
    expect(() => assertJourneyContextIsPrivacySafe(context)).not.toThrow();
  });

  it("rejects user prompts that reference private streaming data", () => {
    expect(() => assertPromptIsPrivacySafe("match my tidal library")).toThrow(/library/);
  });

  it("maps retired grok model slugs to current models", () => {
    expect(resolveXaiModel("grok-4")).toBe("grok-4.3");
    expect(resolveXaiModel("grok-4.3")).toBe("grok-4.3");
  });

  it("extracts text from responses API payloads", () => {
    const text = extractXaiResponseText({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: '{"songs":[{"artist":"M83","title":"Wait"}]}' }]
        }
      ]
    });

    expect(text).toContain("M83");
  });

  it("creates deterministic fallback candidates", () => {
    expect(fallbackCandidates(context, 5)).toHaveLength(5);
  });

  it("selects a unique rolling five-track batch", () => {
    const tracks: ResolvedTrack[] = Array.from({ length: 7 }, (_, index) => ({
      provider: "tidal",
      providerTrackId: `track-${index}`,
      artist: "Artist",
      title: `Track ${index}`,
      matchConfidence: 0.9,
      matchReason: "test"
    }));

    const selected = selectRollingBatch(tracks, new Set(["track-1"]), 5);

    expect(selected.map((track) => track.providerTrackId)).toEqual([
      "track-0",
      "track-2",
      "track-3",
      "track-4",
      "track-5"
    ]);
  });
});
