import type { JourneyContext, ResolvedTrack, SongCandidate } from "@ai-journey-dj/core";
import { clampConfidence, normalizeText } from "@ai-journey-dj/core";

const FALLBACK_CANDIDATES: SongCandidate[] = [
  {
    artist: "Khruangbin",
    title: "A Calf Born in Winter",
    reason: "warm instrumental motion that stays calm but awake",
    source: "fallback",
    confidence: 0.72
  },
  {
    artist: "The War on Drugs",
    title: "Red Eyes",
    reason: "open-road momentum with melodic lift",
    source: "fallback",
    confidence: 0.78
  },
  {
    artist: "M83",
    title: "Wait",
    reason: "cinematic late-drive atmosphere",
    source: "fallback",
    confidence: 0.7
  },
  {
    artist: "Tycho",
    title: "A Walk",
    reason: "focused cruise energy without harsh edges",
    source: "fallback",
    confidence: 0.74
  },
  {
    artist: "Roosevelt",
    title: "Moving On",
    reason: "bright forward motion for a long drive",
    source: "fallback",
    confidence: 0.73
  },
  {
    artist: "Bonobo",
    title: "Kerala",
    reason: "textured rhythm for a steady highway section",
    source: "fallback",
    confidence: 0.71
  },
  {
    artist: "Beach House",
    title: "Space Song",
    reason: "dreamy arrival texture without becoming too sleepy",
    source: "fallback",
    confidence: 0.69
  },
  {
    artist: "Jungle",
    title: "Casio",
    reason: "light rhythmic lift for a confident cruise",
    source: "fallback",
    confidence: 0.74
  },
  {
    artist: "Caribou",
    title: "Can't Do Without You",
    reason: "emotional momentum for an open road segment",
    source: "fallback",
    confidence: 0.73
  },
  {
    artist: "Air",
    title: "La femme d'argent",
    reason: "smooth spacious drive texture",
    source: "fallback",
    confidence: 0.71
  },
  {
    artist: "Rufus Du Sol",
    title: "Innerbloom",
    reason: "long-form build for scenic distance",
    source: "fallback",
    confidence: 0.76
  },
  {
    artist: "Parcels",
    title: "Tieduprightnow",
    reason: "sunlit groove that stays relaxed",
    source: "fallback",
    confidence: 0.72
  },
  {
    artist: "Massive Attack",
    title: "Teardrop",
    reason: "night-drive focus with familiar gravity",
    source: "fallback",
    confidence: 0.7
  },
  {
    artist: "The xx",
    title: "Intro",
    reason: "minimal reset between bigger tracks",
    source: "fallback",
    confidence: 0.68
  },
  {
    artist: "Jamie xx",
    title: "Loud Places",
    reason: "late-journey emotional lift",
    source: "fallback",
    confidence: 0.73
  },
  {
    artist: "Odesza",
    title: "A Moment Apart",
    reason: "cinematic arrival energy",
    source: "fallback",
    confidence: 0.75
  },
  {
    artist: "Foals",
    title: "Spanish Sahara",
    reason: "slow-building landscape feeling",
    source: "fallback",
    confidence: 0.69
  },
  {
    artist: "Phoenix",
    title: "Lisztomania",
    reason: "bright familiar energy for fatigue prevention",
    source: "fallback",
    confidence: 0.7
  },
  {
    artist: "Tame Impala",
    title: "Let It Happen",
    reason: "rolling pulse for a long highway stretch",
    source: "fallback",
    confidence: 0.74
  }
];

const FORBIDDEN_PROMPT_KEYS = [
  "tidal",
  "spotify",
  "apple music",
  "playlist id",
  "library",
  "vin",
  "gps",
  "latitude",
  "longitude",
  "raw location"
];

export interface SongScout {
  generateCandidates(context: JourneyContext, targetCount: number): Promise<SongCandidate[]>;
}

export interface XaiSongScoutOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  mock: boolean;
  fetchImpl?: typeof fetch;
}

const DEPRECATED_XAI_MODELS: Record<string, string> = {
  "grok-4": "grok-4.3",
  "grok-3": "grok-4.3",
  "grok-4-0709": "grok-4.3",
  "grok-4-fast-reasoning": "grok-4.3",
  "grok-4-fast-non-reasoning": "grok-4.20-non-reasoning",
  "grok-4-1-fast-reasoning": "grok-4.3",
  "grok-4-1-fast-non-reasoning": "grok-4.20-non-reasoning"
};

export function resolveXaiModel(model: string): string {
  return DEPRECATED_XAI_MODELS[model] ?? model;
}

export function extractXaiResponseText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const response = payload as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
    choices?: Array<{ message?: { content?: string } }>;
  };

  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }

  for (const item of response.output ?? []) {
    if (item.type !== "message" || !item.content) {
      continue;
    }
    for (const part of item.content) {
      if (part.type === "output_text" && part.text) {
        return part.text;
      }
    }
  }

  return response.choices?.[0]?.message?.content;
}

export function buildJourneyPrompt(context: JourneyContext, targetCount: number): string {
  const safeContext = {
    destination: context.destination,
    coarseRegion: context.coarseRegion,
    localTimeIso: context.localTimeIso,
    weatherFeel: context.weatherFeel,
    etaMinutes: context.etaMinutes,
    speedBucket: context.speedBucket,
    temperatureBucket: context.temperatureBucket,
    phase: context.phase,
    userPrompt: context.userPrompt,
    passengerMode: context.passengerMode
  };

  return [
    "You are AI Journey DJ, a road-trip music scout.",
    "Suggest real, widely released songs as artist/title pairs for the current drive.",
    "Do not depend on streaming catalogs, personal collections, or private vehicle telemetry.",
    `Return exactly ${targetCount} JSON items with artist, title, reason, confidence, and optional album/year/isrc.`,
    "Avoid sleepy, aggressive, novelty, or unsafe driving energy unless explicitly requested.",
    `Journey context: ${JSON.stringify(safeContext)}`
  ].join("\n");
}

export function assertPromptIsPrivacySafe(prompt: string): void {
  const normalized = prompt.toLowerCase();
  const forbidden = FORBIDDEN_PROMPT_KEYS.filter((key) => {
    const pattern = key.length <= 3 ? new RegExp(`\\b${key}\\b`, "i") : new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return pattern.test(normalized);
  });
  if (forbidden.length > 0) {
    throw new Error(`Prompt contains forbidden data hints: ${forbidden.join(", ")}`);
  }
}

export function assertJourneyContextIsPrivacySafe(context: JourneyContext): void {
  assertPromptIsPrivacySafe(context.userPrompt);
  assertPromptIsPrivacySafe(context.destination);
  if (context.coarseRegion) {
    assertPromptIsPrivacySafe(context.coarseRegion);
  }
  if (context.weatherFeel) {
    assertPromptIsPrivacySafe(context.weatherFeel);
  }
}

export class XaiSongScout implements SongScout {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: XaiSongScoutOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generateCandidates(context: JourneyContext, targetCount: number): Promise<SongCandidate[]> {
    if (this.options.mock || !this.options.apiKey) {
      return fallbackCandidates(context, targetCount);
    }

    assertJourneyContextIsPrivacySafe(context);
    const prompt = buildJourneyPrompt(context, targetCount);
    const model = resolveXaiModel(this.options.model);

    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        store: false,
        reasoning_effort: "none",
        input: [
          {
            role: "system",
            content:
              "Return only JSON. Never include streaming-service data, raw GPS, VINs, or user-library references."
          },
          { role: "user", content: prompt }
        ],
        tools: [{ type: "web_search" }]
      })
    });

    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(`xAI request failed with ${response.status}: ${responseBody}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseBody);
    } catch {
      throw new Error("xAI response was not valid JSON.");
    }

    const content = extractXaiResponseText(payload);
    if (!content) {
      throw new Error("xAI response did not include candidate JSON.");
    }

    return parseCandidateJson(content, targetCount);
  }
}

export function parseCandidateJson(content: string, targetCount: number): SongCandidate[] {
  const parsed = JSON.parse(content) as { songs?: unknown; candidates?: unknown } | unknown[];
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.songs)
      ? parsed.songs
      : Array.isArray(parsed.candidates)
        ? parsed.candidates
        : [];

  return items
    .map((item) => item as Partial<SongCandidate>)
    .filter((item) => typeof item.artist === "string" && typeof item.title === "string")
    .slice(0, targetCount)
    .map((item) => ({
      artist: item.artist?.trim() ?? "",
      title: item.title?.trim() ?? "",
      album: typeof item.album === "string" ? item.album : undefined,
      year: typeof item.year === "number" ? item.year : undefined,
      isrc: typeof item.isrc === "string" ? item.isrc : undefined,
      reason: typeof item.reason === "string" ? item.reason : "fits the current drive context",
      source: "grok",
      confidence: clampConfidence(typeof item.confidence === "number" ? item.confidence : 0.65)
    }));
}

export function fallbackCandidates(context: JourneyContext, targetCount: number): SongCandidate[] {
  const phaseOffset = Math.abs(normalizeText(context.phase).split("").reduce((acc, char) => acc + char.charCodeAt(0), 0));
  return [...FALLBACK_CANDIDATES]
    .slice(phaseOffset % 3)
    .concat(FALLBACK_CANDIDATES)
    .slice(0, targetCount)
    .map((candidate) => ({
      ...candidate,
      reason: `${candidate.reason}; selected for ${context.phase} toward ${context.destination}`
    }));
}

export function selectRollingBatch<T extends ResolvedTrack>(
  resolvedTracks: T[],
  alreadyAddedProviderIds: Set<string>,
  batchSize = 5
): T[] {
  const seen = new Set(alreadyAddedProviderIds);
  const selected: T[] = [];

  for (const track of resolvedTracks) {
    if (seen.has(track.providerTrackId)) continue;
    seen.add(track.providerTrackId);
    selected.push(track);
    if (selected.length === batchSize) break;
  }

  return selected;
}
