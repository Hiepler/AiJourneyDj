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
  | "degraded"
  | "fallback"
  | "not_ready"
  | "account_error"
  | "authentication_error"
  | "playback_error"
  | "autoplay_failed";

export interface JourneyContext {
  destination: string;
  coarseRegion?: string;
  localTimeIso: string;
  weatherFeel?: string;
  etaMinutes?: number;
  speedBucket: SpeedBucket;
  temperatureBucket?: TemperatureBucket;
  phase: JourneyPhase;
  userPrompt: string;
  passengerMode: PassengerMode;
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
  spotifyDeviceId?: string;
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
