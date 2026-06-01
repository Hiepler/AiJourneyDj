export type JourneyPhase =
  | "departure"
  | "cruise"
  | "golden_hour"
  | "focus"
  | "arrival"
  | "rest";

export type PassengerMode = "solo" | "couple" | "family" | "friends";

export type SpeedBucket = "parked" | "city" | "country" | "highway" | "unknown";

export type TemperatureBucket = "cold" | "cool" | "mild" | "warm" | "hot" | "unknown";

export type PlaylistUpdateStatus = "success" | "degraded" | "failed" | "pending";

export type StreamingProvider = "spotify" | "tidal";

export type PlaybackSessionStatus =
  | "idle"
  | "ready"
  | "playing"
  | "external"
  | "degraded"
  | "fallback"
  | "not_ready"
  | "account_error"
  | "authentication_error"
  | "playback_error"
  | "autoplay_failed";

/**
 * Steering signal derived from the listener's Spotify top artists. Used to personalize
 * the musical brief without ever exposing raw streaming-library data to prompts.
 */
export interface TasteProfile {
  /** Favorite genres, most representative first. */
  topGenres: string[];
  /** A few representative artist names that exemplify the taste. */
  representativeArtists: string[];
}

export interface JourneyContext {
  destination: string;
  coarseRegion?: string;
  localTimeIso: string;
  weatherFeel?: string;
  etaMinutes?: number;
  speedBucket: SpeedBucket;
  temperatureBucket?: TemperatureBucket;
  paceTrend?: "accelerating" | "steady" | "slowing";
  etaTrend?: "approaching" | "steady" | "unknown";
  autopilotState?: "off" | "available" | "active" | "unknown";
  batteryPercent?: number;
  phase: JourneyPhase;
  userPrompt: string;
  passengerMode: PassengerMode;
  /** Optional personalization signal from the listener's Spotify top artists. */
  tasteProfile?: TasteProfile;
  /** Familiarity↔discovery balance, 0 = pure discovery … 1 = lean into known taste. */
  tasteWeight?: number;
}

export type SongCandidateRole = "anchor" | "momentum" | "bridge" | "surprise" | "resolution";

export interface SongCandidateScores {
  contextFit: number;
  telemetryFit: number;
  tasteFit: number;
  diversityGain: number;
  novelty: number;
  fatiguePenalty: number;
  total: number;
}

export interface SongCandidate {
  id?: string;
  artist: string;
  title: string;
  album?: string;
  year?: number;
  isrc?: string;
  /** Coarse genre label used for diversity balancing across the candidate set. */
  genre?: string;
  /** Generation lens this candidate came from (e.g. "current", "classics") — diagnostics/balancing. */
  lens?: string;
  /** Role in the next five-track cinematic journey set. */
  role?: SongCandidateRole;
  /** Internal selection diagnostics; never provider catalog data. */
  scores?: SongCandidateScores;
  /** Privacy-safe drive signals that influenced this pick. */
  telemetrySignals?: string[];
  reason: string;
  source: "grok" | "gemini" | "fallback" | "musicbrainz" | "listenbrainz";
  confidence: number;
}

export interface ResolvedTrack {
  provider: StreamingProvider;
  providerTrackId: string;
  providerUri?: string;
  externalUrl?: string;
  isPlayable?: boolean;
  market?: string;
  albumArtUrl?: string;
  artist: string;
  title: string;
  isrc?: string;
  matchConfidence: number;
  matchReason: string;
}

export interface PlaylistUpdate {
  id: string;
  journeyId: string;
  provider?: StreamingProvider;
  batchSize: number;
  candidateIds: string[];
  resolvedTrackIds: string[];
  idempotencyKey: string;
  status: PlaylistUpdateStatus;
  createdAtIso: string;
}

export interface NormalizedTelemetryEvent {
  vehicleIdHash?: string;
  journeyId?: string;
  timestampIso: string;
  coarseRegion?: string;
  destination?: string;
  etaMinutes?: number;
  speedKph?: number;
  outsideTempC?: number;
  autopilotState?: "off" | "available" | "active" | "unknown";
  batteryPercent?: number;
}

export interface JourneyRecord {
  id: string;
  provider: StreamingProvider;
  destination: string;
  userPrompt: string;
  passengerMode: PassengerMode;
  phase: JourneyPhase;
  status: "active" | "stopped";
  /** Familiarity↔discovery balance for this drive, 0 = discovery … 1 = familiar. */
  tasteWeight?: number;
  spotifyDeviceId?: string;
  spotifyPlaylistId?: string;
  spotifyPlaylistUrl?: string;
  tidalPlaylistId?: string;
  tidalPlaylistUrl?: string;
  createdAtIso: string;
  stoppedAtIso?: string;
}

export interface PlaybackSession {
  journeyId: string;
  provider: StreamingProvider;
  deviceId?: string;
  status: PlaybackSessionStatus;
  activeTrack?: ResolvedTrack & { id?: string };
  queuedTrackIds: string[];
  playedTrackIds?: string[];
  targetBufferSize: 5;
  lastHeartbeatAt: string;
}

export interface QueueOperation {
  id: string;
  journeyId: string;
  provider: StreamingProvider;
  providerTrackId: string;
  providerUri?: string;
  operation: "start" | "queue" | "fallback" | "skip";
  status: PlaylistUpdateStatus;
  deviceId?: string;
  createdAtIso: string;
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

const VERSION_QUALIFIER = /\b(live|remaster(?:ed)?|extended|radio edit|mono|stereo|deluxe|acoustic|version|intro)\b/i;

/**
 * Reduces a track title to its "base song" form for de-duplication: drops bracketed segments
 * ((...) / [...]) and a trailing version qualifier after " - " or " / " (Live, Remaster, Extended,
 * Acoustic, …). Remixes and numbered parts are intentionally preserved as distinct songs.
 */
export function normalizeBaseTitle(title: string): string {
  let base = title.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  const separator = base.match(/\s[-/]\s/);
  if (separator && separator.index !== undefined) {
    const tail = base.slice(separator.index);
    if (VERSION_QUALIFIER.test(tail)) {
      base = base.slice(0, separator.index);
    }
  }
  return normalizeText(base);
}

/** Journey-scoped identity for a song: normalized artist + base title. Used to prevent repeats. */
export function songKey(artist: string, title: string): string {
  return `${normalizeText(artist)}::${normalizeBaseTitle(title)}`;
}
