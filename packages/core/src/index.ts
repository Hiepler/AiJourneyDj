export type JourneyPhase =
  | "departure"
  | "cruise"
  | "golden_hour"
  | "focus"
  | "arrival"
  | "rest";

export type PassengerMode = "solo" | "couple" | "family" | "friends";

export type SpeedBucket = "parked" | "city" | "country" | "highway" | "unknown";

export type TemperatureBucket =
  | "cold"
  | "cool"
  | "mild"
  | "warm"
  | "hot"
  | "unknown";

export type PlaylistUpdateStatus =
  | "success"
  | "degraded"
  | "failed"
  | "pending";

export type StreamingProvider = "spotify" | "tidal";

export type PlaybackSessionStatus =
  | "idle"
  | "ready"
  | "playing"
  | "paused"
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
  countryName?: string;
  countryCode?: string;
  geoSource?: "reverse-geocode" | "manual" | "simulated";
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
  /** Adaptive Drive Mode assessment (comfort feature; biases selection toward calm/focus). */
  driveState?: DriveStateAssessment;
  /** Which source produced the latest context: live streaming vs REST polling. */
  telemetrySource?: "streaming" | "polling";
  /** Snapshot of the planned total trip duration in minutes (first ETA seen). */
  plannedDurationMinutes?: number;
  /** Minutes elapsed since the journey started (now − createdAt). */
  elapsedMinutes?: number;
  /** Active music-wish layers steering this journey. */
  activeMusicWishes?: MusicWish[];
  /** Gerade gespielter Track — Seed für das Momentum-Radio. */
  nowPlaying?: { artist: string; title: string };
  /** Rotating "exploration angle" hint for the LLM scout (variety engine). */
  varietyAngle?: string;
  /** Recently surfaced artists across journeys to de-prioritize (variety engine). */
  recentlyPlayedArtists?: string[];
}

export type SongCandidateRole =
  | "anchor"
  | "momentum"
  | "bridge"
  | "surprise"
  | "resolution";

export interface SongCandidateScores {
  contextFit: number;
  telemetryFit: number;
  tasteFit: number;
  diversityGain: number;
  novelty: number;
  fatiguePenalty: number;
  total: number;
}

export type MusicWishSource = "text" | "voice" | "chip";

export type MusicWishStatus =
  | "pending_confirmation"
  | "active"
  | "soft_applied"
  | "expired"
  | "undone"
  | "failed";

export type MusicWishIntent =
  | { type: "song"; artist?: string; title: string; immediate: boolean }
  | { type: "artist"; artist: string; strength: number }
  | { type: "genre"; genre: string; strength: number }
  | { type: "mood"; moodTags: string[]; strength: number }
  | {
      type: "avoid";
      artists?: string[];
      songKeys?: string[];
      moodTags?: string[];
    }
  | {
      type: "role";
      role: "singalong" | "wake_up" | "kids" | "calm_down";
      strength: number;
    };

export interface MusicWish {
  id: string;
  journeyId: string;
  rawText: string;
  source: MusicWishSource;
  intents: MusicWishIntent[];
  status: MusicWishStatus;
  confidence: number;
  summary: string;
  pinned: boolean;
  expiresAfterTracks: number;
  remainingTracks: number;
  createdAtIso: string;
  updatedAtIso: string;
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
  popularity?: number;
  explicit?: boolean;
  releaseDate?: string;
  chartRank?: number;
  chartPlaycount?: number;
  chartCountry?: string;
  chartSource?: string;
  moodTags?: string[];
  reason: string;
  source:
    | "grok"
    | "gemini"
    | "fallback"
    | "musicbrainz"
    | "listenbrainz"
    | "lastfm"
    | "music-wish"
    | "lastfm-similar";
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
  popularity?: number;
  explicit?: boolean;
  releaseDate?: string;
  chartRank?: number;
  chartPlaycount?: number;
  chartCountry?: string;
  chartSource?: string;
  moodTags?: string[];
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
  countryName?: string;
  countryCode?: string;
  geoSource?: "reverse-geocode" | "manual" | "simulated";
  destination?: string;
  etaMinutes?: number;
  speedKph?: number;
  outsideTempC?: number;
  autopilotState?: "off" | "available" | "active" | "unknown";
  batteryPercent?: number;
  /** Live traffic delay on the active navigation route, in minutes (drive_state.active_route_traffic_minutes_delay). */
  trafficDelayMinutes?: number;
  /** Predicted battery % at the navigation destination (drive_state.active_route_energy_at_arrival). */
  energyPercentAtArrival?: number;
  /** In-cabin media volume 0–11 (media_info.audio_volume). Read-only — used as a calm signal, never set. */
  audioVolume?: number;
  /** Longitudinal acceleration in m/s² (streaming only — LongitudinalAcceleration). Negative = braking. */
  longitudinalAccelMps2?: number;
  /** Brake pedal pressed (streaming only — BrakePedal). */
  brakePedal?: boolean;
  /** Hazard lights active (streaming only — LightsHazardsActive). */
  hazardsActive?: boolean;
}

/** Situational driving mode the Adaptive Drive Mode derives from telemetry. */
export type DriveMode = "calm" | "focus" | "neutral";

/**
 * Result of the deterministic drive-state classifier. Comfort feature, NOT a safety system:
 * it only biases music selection toward calmer/more-engaging tracks for the situation.
 */
export interface DriveStateAssessment {
  mode: DriveMode;
  /** Short human-readable cause for the cockpit chip, e.g. "heavy traffic". */
  reason: string;
  /** 0..1 strength used to scale the brief shift. */
  intensity: number;
  /** Privacy-safe signals that drove the assessment, for the chip tooltip. */
  signals: string[];
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
  /** Engaged Adaptive Drive Mode (hysteresis-stabilized). Defaults to neutral. */
  driveMode?: DriveMode;
  /** Per-journey master switch for Adaptive Drive Mode (default on). */
  adaptiveModeEnabled?: boolean;
  createdAtIso: string;
  stoppedAtIso?: string;
  /** Planned total trip duration in minutes, snapshotted from the first ETA. */
  plannedDurationMinutes?: number;
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

const VERSION_QUALIFIER =
  /\b(live|remaster(?:ed)?|extended|radio edit|mono|stereo|deluxe|acoustic|version|intro)\b/i;

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
