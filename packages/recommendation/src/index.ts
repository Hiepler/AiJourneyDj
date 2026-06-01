import type {
  JourneyContext,
  ResolvedTrack,
  SongCandidate,
  SongCandidateRole,
  SongCandidateScores,
  TasteProfile
} from "@ai-journey-dj/core";
import { clampConfidence, normalizeText, songKey } from "@ai-journey-dj/core";

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
  /** Abort the LLM request after this many ms so a hung provider never blocks a journey. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_SCOUT_TIMEOUT_MS = 30_000;

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
    "You are AI Journey DJ, an expert road-trip music director.",
    "Curate real, released songs (artist/title) that feel hand-picked for THIS drive — as if each track",
    "were chosen the moment the car's mood, pace, and surroundings shifted.",
    "Use web search to verify releases and to include genuinely current charting or viral tracks alongside",
    "timeless classics; vary artists, eras, and energy and avoid obvious repetition.",
    "Map abstract drive signals (never invent raw GPS, VINs, or streaming-library data):",
    "- speedBucket: parked = slow/ambient, city = mid-tempo groove, highway = forward momentum",
    "- phase: departure = lift, cruise = steady flow, golden_hour = cinematic warmth, arrival = wind-down, focus = minimal",
    "- weatherFeel / temperatureBucket: color the mood (warm sun, cool air, rain, etc.)",
    "- etaMinutes: shorter ETA → slightly more alert energy; long haul → allow longer builds",
    "- passengerMode: adjust social energy (solo vs couple vs family)",
    "Each reason must cite at least two context fields (e.g. phase + region, or speed + weather) so picks feel tailored.",
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
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: XaiSongScoutOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_SCOUT_TIMEOUT_MS;
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
      signal: AbortSignal.timeout(this.requestTimeoutMs),
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

    return resolveCandidatesFromModelText(content, context, targetCount, "grok");
  }
}

export interface GeminiSongScoutOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  mock: boolean;
  /** Abort the LLM request after this many ms so a hung provider never blocks a journey. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const GEMINI_SYSTEM_INSTRUCTION = [
  "You are AI Journey DJ. Use Google Search grounding to find real, released songs that match the",
  "abstract journey context (destination, region, time, weather feel, pace bucket, phase, ETA, passengers).",
  "Blend classics with current charting or viral tracks. Each reason must reference at least two context",
  "signals so the set feels written for this exact drive.",
  'Respond with ONLY valid JSON, no markdown, no schema placeholders. Example:',
  '{"songs":[{"artist":"Khruangbin","title":"Time","reason":"highway cruise through warm evening","confidence":0.82}]}',
  "Never include streaming-service data, raw GPS coordinates, VINs, or user-library references."
].join(" ");

export type SongScoutProvider = "multilens" | "gemini" | "xai";

export interface SongScoutInfo {
  provider: SongScoutProvider;
  model: string;
  webSearch: boolean;
  mock: boolean;
  lenses?: number;
}

export function createSongScout(input: {
  provider: SongScoutProvider;
  mock: boolean;
  gemini: GeminiSongScoutOptions;
  xai: XaiSongScoutOptions;
  multilens?: { perLensCount?: number; maxOutputTokens?: number; lenses?: SongLens[] };
}): { scout: SongScout; info: SongScoutInfo } {
  const geminiUsable = input.mock || Boolean(input.gemini.apiKey);

  // Default/preferred path: telemetry-driven multi-lens engine (needs the Gemini path usable).
  if (input.provider === "multilens" && geminiUsable) {
    const lenses = input.multilens?.lenses;
    return {
      scout: new MultiLensSongScout({
        apiKey: input.gemini.apiKey,
        baseUrl: input.gemini.baseUrl,
        model: input.gemini.model,
        mock: input.mock,
        requestTimeoutMs: input.gemini.requestTimeoutMs,
        fetchImpl: input.gemini.fetchImpl,
        lenses,
        perLensCount: input.multilens?.perLensCount,
        maxOutputTokens: input.multilens?.maxOutputTokens
      }),
      info: {
        provider: "multilens",
        model: input.gemini.model,
        webSearch: !input.mock && Boolean(input.gemini.apiKey),
        mock: input.mock,
        lenses: lenses?.length ?? 5
      }
    };
  }

  if (input.provider !== "xai" && geminiUsable) {
    return {
      scout: new GeminiSongScout(input.gemini),
      info: {
        provider: "gemini",
        model: input.gemini.model,
        webSearch: !input.mock && Boolean(input.gemini.apiKey),
        mock: input.mock
      }
    };
  }

  return {
    scout: new XaiSongScout(input.xai),
    info: {
      provider: "xai",
      model: resolveXaiModel(input.xai.model),
      webSearch: !input.mock && Boolean(input.xai.apiKey),
      mock: input.mock
    }
  };
}

/** Concatenates the text parts of a native Gemini `generateContent` response. */
export function extractGeminiText(payload: unknown): string | undefined {
  const parts = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates?.[0]
    ?.content?.parts;
  if (!Array.isArray(parts)) {
    return undefined;
  }
  const text = parts.map((part) => part?.text ?? "").join("").trim();
  return text.length > 0 ? text : undefined;
}

/** Walks from the first `{` or `[` and returns the balanced JSON slice. */
export function extractBalancedJson(text: string): string | undefined {
  const startObject = text.indexOf("{");
  const startArray = text.indexOf("[");
  let start = -1;
  if (startObject === -1) {
    start = startArray;
  } else if (startArray === -1) {
    start = startObject;
  } else {
    start = Math.min(startObject, startArray);
  }
  if (start === -1) {
    return undefined;
  }

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

/** Extracts a JSON object/array from model text that may be wrapped in markdown fences or prose. */
export function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  return extractBalancedJson(body) ?? extractBalancedJson(text);
}

/** Applies light repairs before `JSON.parse` on model-generated JSON. */
export function repairJsonString(input: string): string {
  return input
    .replace(/^\uFEFF/, "")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)(\s*:)/g, '$1"$2"$3');
}

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`) as string;
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

/** Pulls song objects out of prose when the surrounding JSON is invalid. */
export function salvageCandidatesFromText(text: string): Partial<SongCandidate>[] {
  const salvaged: Partial<SongCandidate>[] = [];
  const objectPattern =
    /\{[^{}]*?"artist"\s*:\s*"((?:\\.|[^"\\])*)"[^{}]*?"title"\s*:\s*"((?:\\.|[^"\\])*)"[^{}]*?\}/gi;

  for (const match of text.matchAll(objectPattern)) {
    const block = match[0];
    const artist = decodeJsonString(match[1]);
    const title = decodeJsonString(match[2]);
    const reasonMatch = block.match(/"reason"\s*:\s*"((?:\\.|[^"\\])*)"/i);
    const confidenceMatch = block.match(/"confidence"\s*:\s*([\d.]+)/i);
    const albumMatch = block.match(/"album"\s*:\s*"((?:\\.|[^"\\])*)"/i);
    const yearMatch = block.match(/"year"\s*:\s*(\d{4})/i);

    salvaged.push({
      artist,
      title,
      reason: reasonMatch ? decodeJsonString(reasonMatch[1]) : undefined,
      confidence: confidenceMatch ? Number(confidenceMatch[1]) : undefined,
      album: albumMatch ? decodeJsonString(albumMatch[1]) : undefined,
      year: yearMatch ? Number(yearMatch[1]) : undefined
    });
  }

  return salvaged;
}

function candidateItemsFromParsed(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const record = parsed as { songs?: unknown; candidates?: unknown };
  if (Array.isArray(record.songs)) {
    return record.songs;
  }
  if (Array.isArray(record.candidates)) {
    return record.candidates;
  }
  return [];
}

function mapCandidateItems(
  items: unknown[],
  targetCount: number,
  source: SongCandidate["source"]
): SongCandidate[] {
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
      genre: typeof item.genre === "string" ? item.genre : undefined,
      lens: typeof item.lens === "string" ? item.lens : undefined,
      role: parseCandidateRole(item.role),
      scores: parseCandidateScores(item.scores),
      reason: typeof item.reason === "string" ? item.reason : "fits the current drive context",
      source,
      confidence: clampConfidence(typeof item.confidence === "number" ? item.confidence : 0.65)
    }));
}

const SET_ROLES: SongCandidateRole[] = ["anchor", "momentum", "bridge", "surprise", "resolution"];

function parseCandidateRole(value: unknown): SongCandidateRole | undefined {
  return typeof value === "string" && SET_ROLES.includes(value as SongCandidateRole)
    ? (value as SongCandidateRole)
    : undefined;
}

function parseCandidateScores(value: unknown): SongCandidateScores | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<Record<keyof SongCandidateScores, unknown>>;
  const score = (key: keyof SongCandidateScores, fallback = 0): number =>
    clampConfidence(typeof record[key] === "number" ? record[key] : fallback);
  return {
    contextFit: score("contextFit"),
    telemetryFit: score("telemetryFit"),
    tasteFit: score("tasteFit"),
    diversityGain: score("diversityGain"),
    novelty: score("novelty"),
    fatiguePenalty: score("fatiguePenalty"),
    total: score("total")
  };
}

/**
 * Parses model JSON with repair, balanced extraction, and regex salvage.
 * Returns `undefined` when no usable songs were found.
 */
/** Collects every top-level `{...}` slice in model text (works when the outer array JSON is broken). */
export function collectBalancedObjectSlices(text: string): string[] {
  const slices: string[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf("{", searchFrom);
    if (start === -1) {
      break;
    }
    const slice = extractBalancedJson(text.slice(start));
    if (!slice) {
      searchFrom = start + 1;
      continue;
    }
    slices.push(slice);
    searchFrom = start + slice.length;
  }
  return slices;
}

export function tryParseCandidateJson(
  content: string,
  targetCount: number,
  source: SongCandidate["source"] = "grok"
): SongCandidate[] | undefined {
  const slices = new Set<string>();
  for (const slice of [content, extractJsonObject(content), extractBalancedJson(content)]) {
    if (slice) {
      slices.add(slice);
    }
  }
  for (const slice of collectBalancedObjectSlices(content)) {
    slices.add(slice);
  }

  const merged: SongCandidate[] = [];
  for (const slice of slices) {
    for (const candidate of [slice, repairJsonString(slice)]) {
      try {
        const mapped = mapCandidateItems(candidateItemsFromParsed(JSON.parse(candidate)), targetCount, source);
        for (const song of mapped) {
          if (!merged.some((item) => item.artist === song.artist && item.title === song.title)) {
            merged.push(song);
          }
          if (merged.length >= targetCount) {
            return merged.slice(0, targetCount);
          }
        }
      } catch {
        // Try the next slice/repair variant.
      }
    }
    const sliceSalvaged = mapCandidateItems(salvageCandidatesFromText(slice), targetCount, source);
    for (const song of sliceSalvaged) {
      if (!merged.some((item) => item.artist === song.artist && item.title === song.title)) {
        merged.push(song);
      }
      if (merged.length >= targetCount) {
        return merged.slice(0, targetCount);
      }
    }
  }

  if (merged.length > 0) {
    return merged.slice(0, targetCount);
  }

  const salvaged = mapCandidateItems(salvageCandidatesFromText(content), targetCount, source);
  return salvaged.length > 0 ? salvaged : undefined;
}

const GEMINI_STRUCTURED_SCHEMA = {
  type: "object",
  properties: {
    songs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          artist: { type: "string" },
          title: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number" },
          album: { type: "string" },
          year: { type: "integer" }
        },
        required: ["artist", "title", "reason", "confidence"]
      }
    }
  },
  required: ["songs"]
} as const;

/**
 * Song scout backed by Gemini Flash via Google's native Generative Language API
 * (`<baseUrl>/models/<model>:generateContent`) with Google Search grounding enabled. Grounding
 * keeps the set anchored to real, current songs while Flash keeps latency low.
 */
export class GeminiSongScout implements SongScout {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: GeminiSongScoutOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_SCOUT_TIMEOUT_MS;
  }

  async generateCandidates(context: JourneyContext, targetCount: number): Promise<SongCandidate[]> {
    if (this.options.mock || !this.options.apiKey) {
      return fallbackCandidates(context, targetCount);
    }

    try {
      assertJourneyContextIsPrivacySafe(context);
      const prompt = buildJourneyPrompt(context, targetCount);
      const url = `${this.options.baseUrl.replace(/\/$/, "")}/models/${this.options.model}:generateContent`;

      const groundedText = await this.requestGeminiText(url, {
        systemInstruction: { parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.75, maxOutputTokens: 4096 }
      });
      const grounded = tryParseCandidateJson(groundedText, targetCount, "gemini");
      if (grounded && grounded.length > 0) {
        return buildJourneySet(grounded, buildMusicalBrief(context), targetCount);
      }

      const structuredText = await this.requestGeminiText(url, {
        systemInstruction: {
          parts: [
            {
              text: [
                "You are AI Journey DJ. Return only JSON matching the schema.",
                "Pick real, released songs that fit the journey context.",
                "Never include streaming-service data, raw GPS, VINs, or user-library references."
              ].join(" ")
            }
          ]
        },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
          responseSchema: GEMINI_STRUCTURED_SCHEMA
        }
      });
      const structured = tryParseCandidateJson(structuredText, targetCount, "gemini");
      if (structured && structured.length > 0) {
        return buildJourneySet(structured, buildMusicalBrief(context), targetCount);
      }

      return fallbackCandidates(context, targetCount);
    } catch {
      return fallbackCandidates(context, targetCount);
    }
  }

  private async requestGeminiText(
    url: string,
    body: Record<string, unknown>
  ): Promise<string> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.options.apiKey!
      },
      body: JSON.stringify(body)
    });

    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(`Gemini request failed with ${response.status}: ${responseBody}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseBody);
    } catch {
      throw new Error("Gemini response was not valid JSON.");
    }

    const text = extractGeminiText(payload);
    if (!text) {
      throw new Error("Gemini response did not include text.");
    }
    return text;
  }
}

// ============================================================================
// Multi-lens engine: telemetry brief -> parallel lenses -> diversity balancing
// ============================================================================

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export interface MusicalBrief {
  /** 0 = calm, 1 = high-energy. Drives the per-lens prompts. */
  targetEnergy: number;
  /** Desired energy for the next five-track set, active track excluded. */
  energyCurve: number[];
  intensity: string;
  focusLevel: number;
  socialEnergy: string;
  eras: string;
  genres: string[];
  regionHint?: string;
  moodWords: string[];
  driveSignals: string[];
  destination: string;
  userPrompt: string;
  passengerMode: string;
  /** Familiarity↔discovery balance, 0 = discovery … 1 = lean into known taste. */
  tasteWeight: number;
  /** Listener's favorite genres (from their Spotify top artists). */
  favoredGenres: string[];
  /** A few representative artists that exemplify the listener's taste. */
  representativeArtists: string[];
}

/**
 * Aggregates a listener's Spotify top artists into a compact, prompt-safe taste signal:
 * most-frequent genres first, plus a handful of representative artist names. Pure + cheap;
 * the result is cached upstream so the Spotify API is touched at most ~once/day.
 */
export function deriveTasteProfile(
  artists: Array<{ name: string; genres?: string[] }>,
  options: { maxGenres?: number; maxArtists?: number } = {}
): TasteProfile {
  const maxGenres = options.maxGenres ?? 6;
  const maxArtists = options.maxArtists ?? 5;

  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const artist of artists) {
    for (const rawGenre of artist.genres ?? []) {
      const genre = rawGenre.trim().toLowerCase();
      if (!genre) continue;
      counts.set(genre, (counts.get(genre) ?? 0) + 1);
      if (!firstSeen.has(genre)) {
        firstSeen.set(genre, order++);
      }
    }
  }

  const topGenres = [...counts.entries()]
    // Higher frequency first; ties keep the order they were first encountered.
    .sort((a, b) => b[1] - a[1] || (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0))
    .slice(0, maxGenres)
    .map(([genre]) => genre);

  const representativeArtists = artists
    .map((artist) => artist.name.trim())
    .filter(Boolean)
    .slice(0, maxArtists);

  return { topGenres, representativeArtists };
}

const SPEED_ENERGY: Record<string, number> = {
  parked: 0.3,
  city: 0.45,
  country: 0.6,
  highway: 0.8,
  unknown: 0.55
};

const PHASE_PROFILE: Record<string, { delta: number; intensity: string; mood: string[] }> = {
  departure: { delta: 0.05, intensity: "building", mood: ["anticipation", "fresh start"] },
  cruise: { delta: 0, intensity: "steady", mood: ["momentum", "open road"] },
  golden_hour: { delta: -0.05, intensity: "cinematic", mood: ["warm", "emotional", "expansive"] },
  focus: { delta: -0.05, intensity: "focused", mood: ["steady", "low-distraction"] },
  arrival: { delta: -0.15, intensity: "resolving", mood: ["uplift", "arrival"] },
  rest: { delta: -0.25, intensity: "winding-down", mood: ["calm", "mellow"] }
};

function deriveGenres(targetEnergy: number): string[] {
  const broad = ["indie", "electronic", "rock", "soul/funk", "pop", "hip-hop", "folk/acoustic", "ambient/cinematic"];
  if (targetEnergy >= 0.7) {
    return ["electronic", "rock", "hip-hop", "pop", "indie", "funk"];
  }
  if (targetEnergy <= 0.4) {
    return ["ambient/cinematic", "folk/acoustic", "soul", "indie", "downtempo electronic", "classic"];
  }
  return broad;
}

/** Deterministic mapping from live telemetry to musical targets — the dynamic core, zero tokens. */
export function buildMusicalBrief(context: JourneyContext): MusicalBrief {
  const baseEnergy = SPEED_ENERGY[context.speedBucket ?? "unknown"] ?? 0.55;
  const profile = PHASE_PROFILE[context.phase ?? "departure"] ?? PHASE_PROFILE.departure;
  const hour = context.localTimeIso ? new Date(context.localTimeIso).getHours() : 12;
  const isNight = Number.isFinite(hour) && (hour >= 22 || hour < 6);
  const trendDelta = context.paceTrend === "accelerating" ? 0.05 : context.paceTrend === "slowing" ? -0.06 : 0;
  const focusDelta = context.autopilotState === "active" || context.phase === "focus" ? -0.04 : 0;
  const etaDelta =
    typeof context.etaMinutes === "number" && context.etaMinutes <= 15
      ? -0.12
      : typeof context.etaMinutes === "number" && context.etaMinutes > 90
        ? 0.04
        : 0;
  const targetEnergy = clamp01(baseEnergy + profile.delta + trendDelta + focusDelta + etaDelta + (isNight ? -0.1 : 0));

  const moodWords = [...profile.mood];
  if (context.temperatureBucket === "warm" || context.temperatureBucket === "hot") moodWords.push("sunlit");
  if (context.temperatureBucket === "cold") moodWords.push("moody");
  if (isNight) moodWords.push("nocturnal");
  if (context.paceTrend === "accelerating") moodWords.push("lifting");
  if (context.paceTrend === "slowing") moodWords.push("easing");
  if (context.autopilotState === "active") moodWords.push("low-distraction");

  const focusLevel = clamp01((context.phase === "focus" ? 0.75 : 0.35) + (context.autopilotState === "active" ? 0.15 : 0));
  const socialEnergy =
    context.passengerMode === "family"
      ? "friendly"
      : context.passengerMode === "couple"
        ? "intimate"
        : context.passengerMode === "friends"
          ? "social"
          : "solo";
  const energyCurve =
    context.phase === "arrival" || context.etaTrend === "approaching"
      ? [targetEnergy, clamp01(targetEnergy + 0.05), targetEnergy, clamp01(targetEnergy - 0.08), clamp01(targetEnergy - 0.16)]
      : context.phase === "departure"
        ? [clamp01(targetEnergy - 0.08), targetEnergy, clamp01(targetEnergy + 0.06), targetEnergy, clamp01(targetEnergy + 0.02)]
        : [targetEnergy, clamp01(targetEnergy + 0.04), clamp01(targetEnergy - 0.02), clamp01(targetEnergy + 0.08), clamp01(targetEnergy - 0.06)];
  const driveSignals = [
    context.phase,
    context.speedBucket,
    context.temperatureBucket,
    context.paceTrend,
    context.etaTrend,
    context.autopilotState,
    isNight ? "night" : undefined,
    socialEnergy
  ].filter((value): value is string => Boolean(value));

  return {
    targetEnergy,
    energyCurve,
    intensity: profile.intensity,
    focusLevel,
    socialEnergy,
    eras: "1970s through current releases",
    genres: deriveGenres(targetEnergy),
    regionHint: context.coarseRegion || context.destination,
    moodWords,
    driveSignals,
    destination: context.destination,
    userPrompt: context.userPrompt,
    passengerMode: context.passengerMode,
    tasteWeight: clamp01(context.tasteWeight ?? 0),
    favoredGenres: context.tasteProfile?.topGenres ?? [],
    representativeArtists: context.tasteProfile?.representativeArtists ?? []
  };
}

export interface SongLens {
  key: string;
  /** When true the lens uses Google Search grounding (current data); false = model knowledge. */
  grounded: boolean;
  instruction: string;
}

export const DEFAULT_LENSES: SongLens[] = [
  { key: "current", grounded: true, instruction: "Focus on current, recently released or charting tracks (roughly the last 24 months)." },
  { key: "classics", grounded: false, instruction: "Focus on timeless, iconic tracks spanning several past decades — beloved, well-known cuts." },
  { key: "crossgenre", grounded: false, instruction: "Deliberately span diverse genres with surprising-but-fitting picks the listener may not expect." },
  { key: "regional", grounded: true, instruction: "Favor artists connected to, or culturally evocative of, the journey's region/destination." }
];

const CINEMATIC_LENSES: Record<string, SongLens> = {
  cinematic_warmth: {
    key: "cinematic_warmth",
    grounded: false,
    instruction: "Find emotionally warm, cinematic songs that make the drive feel filmed without becoming sleepy."
  },
  steady_momentum: {
    key: "steady_momentum",
    grounded: false,
    instruction: "Find songs with forward motion and clean rhythmic confidence for the current road pace."
  },
  regional_texture: {
    key: "regional_texture",
    grounded: true,
    instruction: "Use the region or destination as cultural texture, not a gimmick; favor real local or evocative artists."
  },
  timeless_anchor: {
    key: "timeless_anchor",
    grounded: false,
    instruction: "Find one or two durable, familiar anchors from past decades that stabilize the set."
  },
  leftfield_bridge: {
    key: "leftfield_bridge",
    grounded: false,
    instruction: "Find surprising cross-genre bridges that still connect smoothly to the drive mood."
  },
  low_distraction: {
    key: "low_distraction",
    grounded: false,
    instruction: "Find focused, low-distraction tracks with steady pulse and minimal lyrical clutter."
  },
  resolving_arrival: {
    key: "resolving_arrival",
    grounded: false,
    instruction: "Find graceful resolution tracks for approaching the destination without draining energy."
  }
};

export function selectJourneyLenses(brief: MusicalBrief): SongLens[] {
  const picked: SongLens[] = [];
  const add = (key: keyof typeof CINEMATIC_LENSES): void => {
    const lens = CINEMATIC_LENSES[key];
    if (!picked.some((item) => item.key === lens.key)) picked.push(lens);
  };

  if (brief.focusLevel >= 0.7 || brief.moodWords.includes("low-distraction")) {
    add("low_distraction");
  } else if (
    brief.intensity === "cinematic" ||
    brief.moodWords.some((word) => ["warm", "emotional", "sunlit", "expansive"].includes(word))
  ) {
    add("cinematic_warmth");
  } else if (brief.intensity === "resolving" || brief.targetEnergy < 0.45) {
    add("resolving_arrival");
  } else {
    add("steady_momentum");
  }

  if (brief.targetEnergy >= 0.5) add("steady_momentum");
  if (brief.regionHint) add("regional_texture");
  add("timeless_anchor");
  add("leftfield_bridge");
  if (picked.length < 5) add("cinematic_warmth");
  if (picked.length < 5) add("resolving_arrival");

  return picked.slice(0, 5);
}

/**
 * Taste steering: the "crossgenre" lens is the discovery counterweight and stays neutral so the
 * set never collapses into an echo chamber. The other lenses lean toward the listener's favorite
 * genres in proportion to tasteWeight (a single number changes only prompt text — zero extra tokens).
 */
function tasteSteeringLine(lens: SongLens, brief: MusicalBrief): string {
  if (lens.key === "crossgenre") return "";
  if (brief.tasteWeight <= 0 || brief.favoredGenres.length === 0) return "";
  const familiarPct = Math.round(brief.tasteWeight * 100);
  const artistHint = brief.representativeArtists.length
    ? `, e.g. artists like ${brief.representativeArtists.join(", ")}`
    : "";
  return [
    `Listener taste: aim for roughly ${familiarPct}% of picks to lean toward their favorite genres`,
    `(${brief.favoredGenres.join(", ")}${artistHint});`,
    `keep the remaining ${100 - familiarPct}% as fresh discovery beyond their usual taste.`
  ].join(" ");
}

export function buildLensPrompt(lens: SongLens, brief: MusicalBrief, count: number): string {
  return [
    `You are AI Journey DJ curating the "${lens.key}" portion of a road-trip set.`,
    lens.instruction,
    `Target energy: ${brief.targetEnergy.toFixed(2)} (0=calm, 1=high). Five-track energy curve: ${brief.energyCurve.map((value) => value.toFixed(2)).join(" -> ")}.`,
    `Intensity: ${brief.intensity}. Focus level: ${brief.focusLevel.toFixed(2)}. Social energy: ${brief.socialEnergy}. Mood: ${brief.moodWords.join(", ")}.`,
    `Drive signals: ${brief.driveSignals.join(", ")}.`,
    `Span eras (${brief.eras}) and vary genres broadly (e.g. ${brief.genres.join(", ")}).`,
    brief.regionHint ? `Region/destination context: ${brief.regionHint}.` : "",
    tasteSteeringLine(lens, brief),
    `Listener mode: ${brief.passengerMode}. Direction: "${brief.userPrompt}".`,
    `Return ONLY JSON {"songs":[{"artist","title","year","genre","reason","role"}]} with exactly ${count} real, released songs.`,
    `If you include role, use one of: ${SET_ROLES.join(", ")}.`,
    "Vary artists; no duplicates. Keep 'reason' to one short clause tying the pick to the drive.",
    "Never include streaming-service data, raw GPS coordinates, VINs, or user-library references."
  ]
    .filter(Boolean)
    .join("\n");
}

function decadeOf(year?: number): string {
  return typeof year === "number" && year > 1900 ? `${Math.floor(year / 10) * 10}s` : "unknown";
}

const GENRE_ENERGY_HINTS: Array<[RegExp, number]> = [
  [/\b(ambient|cinematic|downtempo|classical|folk|acoustic)\b/i, 0.3],
  [/\b(soul|jazz|r&b|funk)\b/i, 0.5],
  [/\b(indie|pop|disco|new wave)\b/i, 0.6],
  [/\b(electronic|house|techno|rock|hip-hop|hip hop)\b/i, 0.78]
];

function inferredCandidateEnergy(candidate: SongCandidate): number {
  const text = [candidate.genre, candidate.lens, candidate.reason].filter(Boolean).join(" ");
  const match = GENRE_ENERGY_HINTS.find(([pattern]) => pattern.test(text));
  return match?.[1] ?? 0.55;
}

function genreKey(candidate: SongCandidate): string {
  return normalizeText(candidate.genre ?? "unknown");
}

function candidateNovelty(candidate: SongCandidate, role: SongCandidateRole): number {
  const year = candidate.year ?? 0;
  const currentBoost = year >= new Date().getFullYear() - 2 ? 0.18 : 0;
  const oldAnchorBoost = role === "anchor" && year > 1900 && year < 2000 ? 0.1 : 0;
  const surpriseBoost = role === "surprise" || candidate.lens === "leftfield_bridge" ? 0.18 : 0;
  return clamp01(0.45 + currentBoost + oldAnchorBoost + surpriseBoost);
}

function scoreForRole(
  candidate: SongCandidate,
  brief: MusicalBrief,
  role: SongCandidateRole,
  index: number,
  usedArtists: Map<string, number>,
  usedGenres: Map<string, number>,
  usedDecades: Map<string, number>
): SongCandidateScores {
  const genre = genreKey(candidate);
  const artist = normalizeText(candidate.artist);
  const decade = decadeOf(candidate.year);
  const roleEnergy = brief.energyCurve[index % brief.energyCurve.length] ?? brief.targetEnergy;
  const energyFit = 1 - Math.abs(inferredCandidateEnergy(candidate) - roleEnergy);
  const contextFit = brief.genres.some((item) => genre.includes(normalizeText(item)) || normalizeText(item).includes(genre))
    ? 0.88
    : brief.moodWords.some((word) => normalizeText(candidate.reason).includes(normalizeText(word)))
      ? 0.72
      : 0.58;
  const tasteFit =
    brief.favoredGenres.length === 0
      ? 0.5
      : brief.favoredGenres.some((item) => genre.includes(normalizeText(item)))
        ? 0.85
        : 0.42;
  const diversityGain = clamp01(
    0.42 +
      (usedArtists.has(artist) ? -0.45 : 0.25) +
      (usedGenres.has(genre) ? -0.25 : 0.2) +
      (usedDecades.has(decade) ? -0.08 : 0.08)
  );
  const novelty = candidateNovelty(candidate, role);
  const fatiguePenalty = clamp01(
    (usedArtists.get(artist) ?? 0) * 0.55 + (usedGenres.get(genre) ?? 0) * 0.18 + (usedDecades.get(decade) ?? 0) * 0.05
  );
  const telemetryFit = clamp01(energyFit + (brief.focusLevel >= 0.7 && inferredCandidateEnergy(candidate) <= 0.65 ? 0.08 : 0));
  const total = clamp01(
    candidate.confidence * 0.22 +
      contextFit * 0.22 +
      telemetryFit * 0.22 +
      tasteFit * 0.1 +
      diversityGain * 0.16 +
      novelty * 0.08 -
      fatiguePenalty * 0.18
  );
  return { contextFit, telemetryFit, tasteFit, diversityGain, novelty, fatiguePenalty, total };
}

export function buildJourneySet(candidates: SongCandidate[], brief: MusicalBrief, count: number): SongCandidate[] {
  const seenSongs = new Set<string>();
  const pool: SongCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.isrc ? `isrc:${candidate.isrc}` : songKey(candidate.artist, candidate.title);
    if (seenSongs.has(key)) continue;
    seenSongs.add(key);
    pool.push(candidate);
  }

  const selected: SongCandidate[] = [];
  const usedArtists = new Map<string, number>();
  const usedGenres = new Map<string, number>();
  const usedDecades = new Map<string, number>();

  while (selected.length < count && pool.length > 0) {
    const role = SET_ROLES[selected.length % SET_ROLES.length];
    const enforceArtistDiversity = selected.length < Math.min(count, 5);
    const enforceGenreDiversity = selected.length < Math.min(count, 5);
    let bestIndex = -1;
    let bestScores: SongCandidateScores | undefined;
    let bestScore = -Infinity;

    for (let index = 0; index < pool.length; index += 1) {
      const candidate = pool[index];
      const artist = normalizeText(candidate.artist);
      const genre = genreKey(candidate);
      if (enforceArtistDiversity && usedArtists.has(artist) && pool.some((item) => !usedArtists.has(normalizeText(item.artist)))) {
        continue;
      }
      if (enforceGenreDiversity && usedGenres.has(genre) && pool.some((item) => !usedGenres.has(genreKey(item)))) {
        continue;
      }
      const scores = scoreForRole(candidate, brief, role, selected.length, usedArtists, usedGenres, usedDecades);
      if (scores.total > bestScore) {
        bestIndex = index;
        bestScore = scores.total;
        bestScores = scores;
      }
    }

    if (bestIndex === -1) {
      bestIndex = 0;
      bestScores = scoreForRole(pool[0], brief, role, selected.length, usedArtists, usedGenres, usedDecades);
    }

    const [picked] = pool.splice(bestIndex, 1);
    const decorated: SongCandidate = {
      ...picked,
      role,
      scores: bestScores,
      telemetrySignals: brief.driveSignals,
      reason: picked.reason || `${role} for ${brief.intensity} ${brief.destination}`
    };
    selected.push(decorated);
    const artist = normalizeText(decorated.artist);
    const genre = genreKey(decorated);
    const decade = decadeOf(decorated.year);
    usedArtists.set(artist, (usedArtists.get(artist) ?? 0) + 1);
    usedGenres.set(genre, (usedGenres.get(genre) ?? 0) + 1);
    usedDecades.set(decade, (usedDecades.get(decade) ?? 0) + 1);
  }

  return selected;
}

/**
 * Deterministic diversity selection: dedupe, then greedily pick to spread across decades,
 * genres and artists so the set never collapses to one era/genre.
 */
export function balanceCandidates(candidates: SongCandidate[], _brief: MusicalBrief, count: number): SongCandidate[] {
  const seen = new Set<string>();
  const pool: SongCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.isrc
      ? `isrc:${candidate.isrc}`
      : `${normalizeText(candidate.artist)}::${normalizeText(candidate.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(candidate);
  }

  const selected: SongCandidate[] = [];
  const usedDecades = new Map<string, number>();
  const usedGenres = new Map<string, number>();
  const usedArtists = new Map<string, number>();

  while (selected.length < count && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i];
      const decade = decadeOf(candidate.year);
      const genre = (candidate.genre ?? "unknown").toLowerCase();
      const artist = normalizeText(candidate.artist);
      // Lower repetition counts -> higher diversity score; confidence breaks ties.
      const score =
        -3 * (usedDecades.get(decade) ?? 0) -
        3 * (usedGenres.get(genre) ?? 0) -
        5 * (usedArtists.get(artist) ?? 0) +
        candidate.confidence;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const [picked] = pool.splice(bestIndex, 1);
    selected.push(picked);
    const decade = decadeOf(picked.year);
    const genre = (picked.genre ?? "unknown").toLowerCase();
    const artist = normalizeText(picked.artist);
    usedDecades.set(decade, (usedDecades.get(decade) ?? 0) + 1);
    usedGenres.set(genre, (usedGenres.get(genre) ?? 0) + 1);
    usedArtists.set(artist, (usedArtists.get(artist) ?? 0) + 1);
  }

  return selected;
}

async function geminiRequestText(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<string> {
  const response = await fetchImpl(url, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body)
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini request failed with ${response.status}: ${responseBody}`);
  }
  const text = extractGeminiText(JSON.parse(responseBody));
  if (!text) {
    throw new Error("Gemini response did not include text.");
  }
  return text;
}

export interface MultiLensSongScoutOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  mock: boolean;
  lenses?: SongLens[];
  /** Songs requested per lens (cost lever — keep small). */
  perLensCount?: number;
  /** Output-token cap per lens call (cost lever). */
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Test seam: overrides the real Gemini call per lens. */
  lensRunner?: (lens: SongLens, brief: MusicalBrief, count: number) => Promise<SongCandidate[]>;
}

/**
 * Telemetry-driven, multi-lens song scout. Builds a deterministic brief, runs several lenses
 * in parallel (current/classics/cross-genre/regional), then balances for diversity.
 */
export class MultiLensSongScout implements SongScout {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly perLensCount: number;
  private readonly maxOutputTokens: number;

  constructor(private readonly options: MultiLensSongScoutOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_SCOUT_TIMEOUT_MS;
    this.perLensCount = options.perLensCount ?? 5;
    this.maxOutputTokens = options.maxOutputTokens ?? 2048;
  }

  async generateCandidates(context: JourneyContext, targetCount: number): Promise<SongCandidate[]> {
    if (this.options.mock || !this.options.apiKey) {
      return fallbackCandidates(context, targetCount);
    }

    try {
      assertJourneyContextIsPrivacySafe(context);
      const brief = buildMusicalBrief(context);
      const runner = this.options.lensRunner ?? ((lens, b, count) => this.runLens(lens, b, count));
      const lenses = this.options.lenses ?? selectJourneyLenses(brief);
      const settled = await Promise.all(
        lenses.map((lens) => runner(lens, brief, this.perLensCount).catch(() => [] as SongCandidate[]))
      );
      const all = settled.flat();
      if (all.length === 0) {
        return fallbackCandidates(context, targetCount);
      }
      const balanced = buildJourneySet(all, brief, targetCount);
      return balanced.length > 0 ? balanced : fallbackCandidates(context, targetCount);
    } catch {
      return fallbackCandidates(context, targetCount);
    }
  }

  private async runLens(lens: SongLens, brief: MusicalBrief, count: number): Promise<SongCandidate[]> {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/models/${this.options.model}:generateContent`;
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }] },
      contents: [{ role: "user", parts: [{ text: buildLensPrompt(lens, brief, count) }] }],
      generationConfig: {
        temperature: 0.85,
        maxOutputTokens: this.maxOutputTokens,
        // Flash "thinking" otherwise eats the output budget (MAX_TOKENS with empty JSON) and bills
        // extra tokens. Song lists need no reasoning trace — disable it: cheaper, faster, complete.
        thinkingConfig: { thinkingBudget: 0 }
      }
    };
    if (lens.grounded) {
      body.tools = [{ google_search: {} }];
    }
    const text = await geminiRequestText(url, body, this.options.apiKey!, this.requestTimeoutMs, this.fetchImpl);
    const parsed = tryParseCandidateJson(text, count, "gemini") ?? [];
    return parsed.map((candidate) => ({ ...candidate, lens: lens.key }));
  }
}

function resolveCandidatesFromModelText(
  text: string,
  context: JourneyContext,
  targetCount: number,
  source: SongCandidate["source"]
): SongCandidate[] {
  const parsed = tryParseCandidateJson(text, targetCount, source);
  if (parsed && parsed.length >= targetCount) {
    return buildJourneySet(parsed, buildMusicalBrief(context), targetCount);
  }

  if (parsed && parsed.length > 0) {
    const padded = [...parsed, ...fallbackCandidates(context, targetCount - parsed.length)];
    return buildJourneySet(
      padded.map((item) => ({ ...item, source })),
      buildMusicalBrief(context),
      targetCount
    );
  }

  return fallbackCandidates(context, targetCount);
}

export function parseCandidateJson(
  content: string,
  targetCount: number,
  source: SongCandidate["source"] = "grok"
): SongCandidate[] {
  const parsed = tryParseCandidateJson(content, targetCount, source);
  if (!parsed || parsed.length === 0) {
    throw new SyntaxError("Model response did not include parseable song JSON.");
  }
  return parsed;
}

export function fallbackCandidates(context: JourneyContext, targetCount: number): SongCandidate[] {
  const phaseOffset = Math.abs(normalizeText(context.phase).split("").reduce((acc, char) => acc + char.charCodeAt(0), 0));
  const candidates = [...FALLBACK_CANDIDATES]
    .slice(phaseOffset % 3)
    .concat(FALLBACK_CANDIDATES)
    .slice(0, targetCount)
    .map((candidate) => ({
      ...candidate,
      reason: `${candidate.reason}; selected for ${context.phase} toward ${context.destination}`
    }));
  return buildJourneySet(candidates, buildMusicalBrief(context), targetCount);
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
