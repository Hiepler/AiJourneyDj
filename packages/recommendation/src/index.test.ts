import { describe, expect, it } from "vitest";

import type { JourneyContext, ResolvedTrack } from "@ai-journey-dj/core";

import {
  assertJourneyContextIsPrivacySafe,
  assertPromptIsPrivacySafe,
  buildJourneyPrompt,
  createSongScout,
  extractXaiResponseText,
  fallbackCandidates,
  GeminiSongScout,
  parseCandidateJson,
  repairJsonString,
  resolveXaiModel,
  salvageCandidatesFromText,
  selectRollingBatch,
  tryParseCandidateJson,
  XaiSongScout
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
    expect(prompt).toContain("speedbucket");
    expect(prompt).toContain("web search");
    expect(() => assertJourneyContextIsPrivacySafe(context)).not.toThrow();
  });

  it("createSongScout prefers Gemini by default and respects SONG_SCOUT=xai", () => {
    const gemini = createSongScout({
      provider: "gemini",
      mock: false,
      gemini: { apiKey: "g", baseUrl: "https://gemini.test/v1beta", model: "gemini-3.5-flash", mock: false },
      xai: { apiKey: "x", baseUrl: "https://api.x.ai/v1", model: "grok-4.3", mock: false }
    });
    expect(gemini.info).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash", webSearch: true });
    expect(gemini.scout).toBeInstanceOf(GeminiSongScout);

    const grok = createSongScout({
      provider: "xai",
      mock: false,
      gemini: { apiKey: "g", baseUrl: "https://gemini.test/v1beta", model: "gemini-3.5-flash", mock: false },
      xai: { apiKey: "x", baseUrl: "https://api.x.ai/v1", model: "grok-4.3", mock: false }
    });
    expect(grok.info.provider).toBe("xai");
    expect(grok.scout).toBeInstanceOf(XaiSongScout);
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

  it("GeminiSongScout falls back to deterministic candidates in mock mode", async () => {
    const scout = new GeminiSongScout({
      apiKey: "k",
      baseUrl: "https://gemini.test/v1beta/openai",
      model: "gemini-3.5-flash",
      mock: true
    });
    await expect(scout.generateCandidates(context, 4)).resolves.toHaveLength(4);
  });

  it("repairs and salvages malformed Gemini JSON instead of throwing", () => {
    const broken = `Here is the set:
{
  "songs":.
  {"artist":"M83","title":"Wait","reason":"golden hour cruise","confidence":0.8},
  {"artist":"Tycho","title":"A Walk","reason":"steady highway flow","confidence":0.77},
]`;

    const parsed = tryParseCandidateJson(broken, 5, "gemini");
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]).toMatchObject({ artist: "M83", title: "Wait", source: "gemini" });

    expect(salvageCandidatesFromText(broken)).toHaveLength(2);
    expect(parseCandidateJson(repairJsonString('{"songs":[{"artist":"A","title":"B","confidence":0.7}]}'), 1)).toHaveLength(1);
  });

  it("GeminiSongScout falls back when the model returns unparseable text", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "No JSON here, just prose about driving." }] } }]
        }),
        { status: 200 }
      );

    const scout = new GeminiSongScout({
      apiKey: "k",
      baseUrl: "https://gemini.test/v1beta",
      model: "gemini-3.5-flash",
      mock: false,
      fetchImpl
    });

    const candidates = await scout.generateCandidates(context, 4);
    expect(candidates).toHaveLength(4);
    expect(candidates.every((item) => item.source === "fallback")).toBe(true);
  });

  it("GeminiSongScout uses native generateContent with Google Search grounding and parses fenced JSON", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      // Grounded responses often wrap JSON in a markdown fence with surrounding prose.
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: "Here is your set:\n```json\n{\"songs\":[{\"artist\":\"M83\",\"title\":\"Wait\",\"confidence\":0.8}]}\n```" }
                ]
              }
            }
          ]
        }),
        { status: 200 }
      );
    };

    const scout = new GeminiSongScout({
      apiKey: "k",
      baseUrl: "https://gemini.test/v1beta",
      model: "gemini-3.5-flash",
      mock: false,
      fetchImpl
    });

    const candidates = await scout.generateCandidates(context, 5);

    expect(captured?.url).toBe("https://gemini.test/v1beta/models/gemini-3.5-flash:generateContent");
    expect(captured?.headers.get("x-goog-api-key")).toBe("k");
    expect(captured?.body.tools).toEqual([{ google_search: {} }]);
    expect(Array.isArray(captured?.body.contents)).toBe(true);
    expect(candidates[0]).toMatchObject({ artist: "M83", title: "Wait", source: "gemini" });
  });

  it("GeminiSongScout aborts a hanging request via its timeout signal", async () => {
    let sawSignal = false;
    const fetchImpl: typeof fetch = (_input, init) => {
      sawSignal = init?.signal instanceof AbortSignal;
      // Never resolves on its own — only the abort signal can settle it (simulates a hung provider).
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    };
    const scout = new GeminiSongScout({
      apiKey: "k",
      baseUrl: "https://gemini.test/v1beta",
      model: "gemini-3.5-flash",
      mock: false,
      requestTimeoutMs: 30,
      fetchImpl
    });

    // On timeout the scout aborts and degrades to deterministic candidates, so a journey
    // never blocks forever on a hung provider.
    const candidates = await scout.generateCandidates(context, 5);
    expect(sawSignal).toBe(true);
    expect(candidates).toHaveLength(5);
    expect(candidates[0].source).toBe("fallback");
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
