import type {
  JourneyContext,
  JourneyPhase,
  JourneyRecord,
  MusicWish,
  MusicWishSource,
  MusicWishStatus,
  NormalizedTelemetryEvent,
  PlaybackSession,
  PlaylistUpdate,
  ResolvedTrack,
  SongCandidate,
  StreamingProvider,
  TasteProfile,
} from "@ai-journey-dj/core";
import { normalizeText, songKey } from "@ai-journey-dj/core";
import { derivePhase } from "@ai-journey-dj/telemetry";
import {
  reconcilePlaybackModel,
  shouldRegenerate,
} from "../playback/reconcile.js";
import { TidalResolver, type TidalAdapter } from "@ai-journey-dj/tidal";
import {
  SpotifyResolver,
  isSpotifyDeviceNotFoundError,
  isSpotifyRateLimitError,
  queueTracksForBuffer,
  type SpotifyAdapter,
  type SpotifyDevice,
} from "@ai-journey-dj/spotify";
import type {
  OpenMusicClient,
  NoopOpenMusicClient,
} from "@ai-journey-dj/open-music";
import type { SongScout } from "@ai-journey-dj/recommendation";
import {
  assessDriveState,
  applyMusicWishesToPolicy,
  buildRecommendationPolicy,
  candidatesFromMusicWishes,
  deriveTasteProfile,
  fallbackCandidates,
  lastfmTracksToCandidates,
  makeVarietyContext,
  parseMusicWish,
  rankResolvedTracksForPolicy,
  rotateWindow,
  seededExplorationAngle,
  selectRollingBatch,
  stabilizeDriveMode,
  type LastfmChartClient,
  type RecommendationPolicy,
} from "@ai-journey-dj/recommendation";

/** Default familiarity↔discovery mix for a new drive — between "light" and "balanced". */
export const DEFAULT_TASTE_WEIGHT = 0.4;
/** Hard cap on the top-artists fetch so taste loading can never block a journey. */
const TASTE_FETCH_TIMEOUT_MS = 8_000;
const COUNTRY_NAME_BY_CODE: Record<string, string> = {
  AT: "Austria",
  CH: "Switzerland",
  DE: "Germany",
  ES: "Spain",
  FR: "France",
  GB: "United Kingdom",
  IT: "Italy",
  NL: "Netherlands",
  US: "United States",
};

import type { AppConfig } from "../config/env.js";
import { contextFromJourney, type Store } from "../db/store.js";
import type { TidalAuthService } from "../auth/tidalAuth.js";
import type { SpotifyAuthService } from "../auth/spotifyAuth.js";

export interface StartJourneyInput {
  destination: string;
  userPrompt: string;
  passengerMode: "solo" | "couple" | "family" | "friends";
  provider?: StreamingProvider;
  deviceId?: string;
}

/** Minimal structured logger (satisfied by the Fastify/pino logger). */
export interface JourneyLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

const noopLogger: JourneyLogger = {
  info() {},
  warn() {},
  error() {},
};

export class JourneyService {
  /** One in-flight analyze per journey; global chain avoids Spotify 429 dogpiles. */
  private readonly analyzeByJourney = new Map<
    string,
    Promise<PlaylistUpdate>
  >();
  private analyzeGlobalChain: Promise<void> = Promise.resolve();
  /** Last autoplay-reclaim attempt per journey — prevents fighting a user who chose Spotify. */
  private readonly reclaimAttemptAt = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly tidalAuth: TidalAuthService,
    private readonly tidalAdapter: TidalAdapter,
    private readonly spotifyAuth: SpotifyAuthService,
    private readonly spotifyAdapter: SpotifyAdapter,
    private readonly songScout: SongScout,
    private readonly openMusic: OpenMusicClient | NoopOpenMusicClient,
    private readonly lastfmCharts?: LastfmChartClient,
    private readonly logger: JourneyLogger = noopLogger,
  ) {}

  async startJourney(input: StartJourneyInput): Promise<JourneyRecord> {
    const provider = input.provider ?? "spotify";
    const id = crypto.randomUUID();
    const createdAtIso = new Date().toISOString();
    const journey: JourneyRecord = {
      id,
      provider,
      destination: input.destination,
      userPrompt: input.userPrompt,
      passengerMode: input.passengerMode,
      phase: "departure",
      status: "active",
      tasteWeight: DEFAULT_TASTE_WEIGHT,
      spotifyDeviceId: provider === "spotify" ? input.deviceId : undefined,
      createdAtIso,
    };

    this.store.createJourney(journey);
    this.store.audit(id, "journey.created", "Journey started.", {
      destination: input.destination,
      provider,
    });

    if (provider === "tidal") {
      await this.ensureTidalPlaylist(id, input.destination);
    } else {
      this.saveSession({
        journeyId: id,
        provider: "spotify",
        deviceId: input.deviceId,
        status: input.deviceId ? "ready" : "idle",
        queuedTrackIds: [],
        targetBufferSize: 5,
        lastHeartbeatAt: new Date().toISOString(),
      });
    }

    try {
      await this.analyzeJourney(id, "initial");
    } catch (error) {
      await this.stopJourney(id);
      throw error;
    }
    return this.getJourneyOrThrow(id);
  }

  getJourneyOrThrow(id: string): JourneyRecord {
    const journey = this.store.getJourney(id);
    if (!journey) {
      throw new Error("Journey not found.");
    }
    return journey;
  }

  async stopJourney(id: string): Promise<JourneyRecord> {
    this.store.stopJourney(id);
    this.store.audit(id, "journey.stopped", "Journey stopped.");
    return this.getJourneyOrThrow(id);
  }

  async ingestTelemetry(event: NormalizedTelemetryEvent): Promise<void> {
    const active = this.store.listActiveJourneys();
    for (const journey of active) {
      const phase = derivePhase(event, journey.phase);
      if (
        journey.plannedDurationMinutes === undefined &&
        typeof event.etaMinutes === "number" &&
        event.etaMinutes > 0
      ) {
        this.store.setPlannedDurationMinutes(journey.id, event.etaMinutes);
      }
      this.store.saveTelemetry(journey.id, event, phase);
      if (phase !== journey.phase) {
        this.store.updateJourneyPhase(journey.id, phase);
        this.store.audit(
          journey.id,
          "telemetry.phase_changed",
          `Journey phase changed to ${phase}.`,
        );
        await this.analyzeJourney(journey.id, "phase-change");
        continue; // the phase re-curation already reflects the latest telemetry
      }
      await this.evaluateDriveMode(journey.id);
    }
  }

  /**
   * Adaptive Drive Mode: classify the situation from recent telemetry, apply hysteresis, and re-curate
   * when the engaged mode actually flips. Comfort feature — biases selection only; never throws.
   */
  private async evaluateDriveMode(journeyId: string): Promise<void> {
    if (!this.config.ADAPTIVE_DRIVE_MODE_ENABLED) return;
    const journey = this.store.getJourney(journeyId);
    if (!journey || journey.adaptiveModeEnabled === false) return;

    // recentTelemetry returns newest-first; sort to oldest→newest for the classifier.
    const recent = [...this.store.recentTelemetry(journeyId, 5)].sort(
      (a, b) => Date.parse(a.timestampIso) - Date.parse(b.timestampIso),
    );
    if (recent.length === 0) return;

    const now = recent[recent.length - 1].timestampIso;
    const raw = assessDriveState(recent, now);
    // Derive the previous poll's raw mode from history (no extra state to persist). With only one
    // snapshot the history is unknown → treat as neutral so a fresh mode genuinely needs two polls.
    const rawPrev =
      recent.length >= 2
        ? assessDriveState(
            recent.slice(0, -1),
            recent[recent.length - 2].timestampIso,
          )
        : { mode: "neutral" as const, reason: "", intensity: 0, signals: [] };
    const engagedPrev = journey.driveMode ?? "neutral";
    const engagedNew = stabilizeDriveMode(
      engagedPrev,
      [rawPrev.mode, raw.mode],
      2,
    );

    if (engagedNew === engagedPrev) return;
    this.store.updateJourneyDriveMode(journeyId, engagedNew);
    this.store.audit(
      journeyId,
      "drive_mode.changed",
      `Adaptive Drive Mode → ${engagedNew}${raw.reason ? ` (${raw.reason})` : ""}.`,
      {
        mode: engagedNew,
        reason: raw.reason,
        signals: raw.signals,
      },
    );
    try {
      await this.analyzeJourney(journeyId, `drive-state:${engagedNew}`);
    } catch (error) {
      this.logger.warn(
        {
          journeyId,
          err: error instanceof Error ? error.message : String(error),
        },
        "drive_mode.recurate_error",
      );
    }
  }

  async createMusicWish(
    journeyId: string,
    input: { text: string; source: MusicWishSource; apply?: boolean },
  ): Promise<{ wish: MusicWish; update?: PlaylistUpdate }> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot add a music wish to a stopped journey.");
    }
    const parsed = parseMusicWish(input.text);
    const createdAtIso = new Date().toISOString();
    const wish: MusicWish = {
      id: crypto.randomUUID(),
      journeyId,
      rawText: parsed.rawText,
      source: input.source,
      intents: parsed.intents,
      status: parsed.status,
      confidence: parsed.confidence,
      summary: parsed.summary,
      pinned: false,
      expiresAfterTracks: 5,
      remainingTracks: 5,
      createdAtIso,
      updatedAtIso: createdAtIso,
    };
    this.store.saveMusicWish(wish);
    this.store.audit(journeyId, "music_wish.created", wish.summary, {
      wishId: wish.id,
      status: wish.status,
    });
    const update =
      wish.status === "active" && input.apply !== false
        ? await this.analyzeJourney(journeyId, "music-wish")
        : undefined;
    return { wish: this.store.getMusicWish(journeyId, wish.id) ?? wish, update };
  }

  async updateMusicWish(
    journeyId: string,
    wishId: string,
    patch: { pinned?: boolean; status?: MusicWishStatus },
  ): Promise<MusicWish> {
    this.getJourneyOrThrow(journeyId);
    this.store.updateMusicWish(journeyId, wishId, patch);
    const wish = this.store.getMusicWish(journeyId, wishId);
    if (!wish) throw new Error("Music wish not found.");
    this.store.audit(journeyId, "music_wish.updated", wish.summary, {
      wishId,
      pinned: wish.pinned,
      status: wish.status,
    });
    return wish;
  }

  async undoMusicWish(journeyId: string, wishId: string): Promise<MusicWish> {
    const wish = await this.updateMusicWish(journeyId, wishId, { status: "undone" });
    // Re-curate only while the journey is still running; the undo itself is
    // already persisted, so a stopped journey must not surface as a failed undo.
    if (this.getJourneyOrThrow(journeyId).status === "active") {
      await this.analyzeJourney(journeyId, "music-wish-undo");
    }
    return wish;
  }

  async analyzeJourney(
    journeyId: string,
    reason = "manual",
  ): Promise<PlaylistUpdate> {
    const inFlight = this.analyzeByJourney.get(journeyId);
    if (inFlight) {
      return inFlight;
    }

    const run = this.analyzeGlobalChain
      .catch(() => undefined)
      .then(() => this.analyzeJourneyBody(journeyId, reason));
    this.analyzeGlobalChain = run.then(
      () => undefined,
      () => undefined,
    );

    const tracked = run.finally(() => {
      if (this.analyzeByJourney.get(journeyId) === tracked) {
        this.analyzeByJourney.delete(journeyId);
      }
    });
    this.analyzeByJourney.set(journeyId, tracked);
    return tracked;
  }

  private async analyzeJourneyBody(
    journeyId: string,
    reason: string,
  ): Promise<PlaylistUpdate> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot analyze a stopped journey.");
    }

    const startedAt = Date.now();
    this.logger.info(
      { journeyId, reason, provider: journey.provider },
      "journey.analyze.start",
    );
    this.store.clearAuditEvents(journeyId, "analysis.failed");
    try {
      const update =
        journey.provider === "tidal"
          ? await this.analyzeTidalJourney(journey, reason)
          : await this.analyzeSpotifyJourney(journey, reason);
      const trackCount = this.store.listResolvedTracks(journeyId).length;
      if (trackCount > 0) {
        this.store.clearAuditEvents(journeyId, "analysis.failed");
      }
      this.logger.info(
        {
          journeyId,
          reason,
          status: update.status,
          batchSize: update.batchSize,
          trackCount,
          ms: Date.now() - startedAt,
        },
        "journey.analyze.done",
      );
      return update;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { journeyId, reason, ms: Date.now() - startedAt, err: message },
        "journey.analyze.failed",
      );
      this.store.audit(journeyId, "analysis.failed", message, { reason });
      throw error;
    }
  }

  async setPhase(
    journeyId: string,
    phase: JourneyPhase,
  ): Promise<JourneyRecord> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot change the phase of a stopped journey.");
    }
    this.store.updateJourneyPhase(journeyId, phase);
    this.store.audit(
      journeyId,
      "phase.manual_override",
      `Drive phase manually set to ${phase}.`,
      { phase },
    );
    await this.analyzeJourney(journeyId, "phase-override");
    return this.getJourneyOrThrow(journeyId);
  }

  /** Sets the familiarity↔discovery mix (0..1) and re-curates the queue around it. */
  async setTasteWeight(
    journeyId: string,
    weight: number,
  ): Promise<JourneyRecord> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot change the taste mix of a stopped journey.");
    }
    const clamped = Math.max(0, Math.min(1, weight));
    this.store.updateJourneyTasteWeight(journeyId, clamped);
    this.store.audit(
      journeyId,
      "taste.weight_set",
      `Vibe mix set to ${Math.round(clamped * 100)}% familiar.`,
      {
        tasteWeight: clamped,
      },
    );
    await this.analyzeJourney(journeyId, "taste-override");
    return this.getJourneyOrThrow(journeyId);
  }

  /** Per-journey master switch for Adaptive Drive Mode. Disabling clears any engaged mode. */
  async setAdaptiveMode(
    journeyId: string,
    enabled: boolean,
  ): Promise<JourneyRecord> {
    const journey = this.getJourneyOrThrow(journeyId);
    this.store.setAdaptiveModeEnabled(journeyId, enabled);
    if (!enabled && journey.driveMode && journey.driveMode !== "neutral") {
      this.store.updateJourneyDriveMode(journeyId, "neutral");
    }
    this.store.audit(
      journeyId,
      "drive_mode.toggled",
      `Adaptive Drive Mode ${enabled ? "enabled" : "disabled"}.`,
      {
        enabled,
      },
    );
    return this.getJourneyOrThrow(journeyId);
  }

  /**
   * Loads the listener's taste profile (top artists → favored genres) for personalization.
   * Cached ~24h so the Spotify API is touched at most once/day; any failure degrades to no taste.
   */
  private async loadTasteProfile(
    accessToken: string,
  ): Promise<TasteProfile | undefined> {
    try {
      const cached = this.store.getCachedTasteProfile("local");
      if (cached) {
        return cached;
      }
      if (!this.spotifyAdapter.getTopArtists) {
        return undefined;
      }
      const artists = await this.spotifyAdapter.getTopArtists({
        accessToken,
        timeRange: "medium_term",
        limit: 30,
        signal: AbortSignal.timeout(TASTE_FETCH_TIMEOUT_MS),
      });
      if (artists.length === 0) {
        return undefined;
      }
      const profile = deriveTasteProfile(artists);
      this.store.saveCachedTasteProfile("local", profile);
      return profile;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: message }, "taste.load.failed");
      return undefined;
    }
  }

  async registerSpotifyDevice(
    journeyId: string,
    deviceId: string,
    status: PlaybackSession["status"] = "ready",
    options: { syncOnly?: boolean } = {},
  ): Promise<PlaybackSession> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.provider !== "spotify") {
      throw new Error("Cannot register a Spotify device for a TIDAL journey.");
    }

    this.store.updateJourneySpotifyDevice(journeyId, deviceId);
    const existing = this.store.getPlaybackSession(journeyId);
    this.saveSession({
      journeyId,
      provider: "spotify",
      deviceId,
      status,
      activeTrack: existing?.activeTrack,
      queuedTrackIds: existing?.queuedTrackIds ?? [],
      targetBufferSize: 5,
      lastHeartbeatAt: new Date().toISOString(),
    });
    this.store.audit(
      journeyId,
      "spotify.device_ready",
      "Spotify Web Playback device registered.",
      { deviceId, status },
    );

    const hasTracks = this.store
      .listResolvedTracks(journeyId)
      .some((track) => track.provider === "spotify");
    if (options.syncOnly && hasTracks) {
      return this.syncExistingSpotifyPlayback(journeyId, deviceId);
    }

    await this.analyzeJourney(journeyId, "device-ready");
    return this.store.getPlaybackSession(journeyId) as PlaybackSession;
  }

  async syncExistingSpotifyPlayback(
    journeyId: string,
    deviceId: string,
  ): Promise<PlaybackSession> {
    const accessToken = await this.spotifyAuth.getAccessToken();
    const stored = this.store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "spotify");
    const session = this.store.getPlaybackSession(journeyId);
    const { activeTrack, queueTracks, queuedTrackIds } =
      this.pickSpotifyPlaybackTracks(stored, session);

    const playbackApplied = await this.syncSpotifyPlayback({
      journeyId,
      accessToken,
      deviceId,
      activeTrack,
      queueTracks,
      shouldStart: true,
    });

    const playedActiveTrack = playbackApplied.deviceReachable
      ? activeTrack
      : (session?.activeTrack ?? activeTrack);
    const status = playbackApplied.deviceReachable
      ? playbackApplied.rateLimited
        ? "degraded"
        : "playing"
      : "degraded";

    this.saveSession({
      journeyId,
      provider: "spotify",
      deviceId,
      status,
      activeTrack: playedActiveTrack,
      queuedTrackIds,
      playedTrackIds: session?.playedTrackIds ?? [],
      targetBufferSize: 5,
      lastHeartbeatAt: new Date().toISOString(),
    });

    if (playbackApplied.rateLimited) {
      this.store.audit(
        journeyId,
        "spotify.rate_limited",
        "Spotify rate limit hit while syncing playback; try Play audio again in a few seconds.",
        { deviceId },
      );
    }

    return this.store.getPlaybackSession(journeyId) as PlaybackSession;
  }

  async skipSpotifyTrack(
    journeyId: string,
    direction: "next" | "previous",
    deviceId?: string,
  ): Promise<PlaybackSession> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.provider !== "spotify") {
      throw new Error("Track skip is only supported for Spotify journeys.");
    }
    if (journey.status !== "active") {
      throw new Error("Cannot skip tracks on a stopped journey.");
    }

    const session = this.store.getPlaybackSession(journeyId);
    const stored = this.store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "spotify");
    const playedIds = session?.playedTrackIds ?? [];
    const { activeTrack, queueTracks } = this.pickSpotifyPlaybackTracks(
      stored,
      session,
    );
    const effectiveDeviceId =
      deviceId ?? journey.spotifyDeviceId ?? session?.deviceId;
    const accessToken = await this.spotifyAuth.getAccessToken();

    if (direction === "next") {
      if (queueTracks.length === 0) {
        await this.analyzeJourney(journeyId, "skip-next");
        const refreshed = this.store.getPlaybackSession(journeyId);
        const refreshedStored = this.store
          .listResolvedTracks(journeyId)
          .filter((track) => track.provider === "spotify");
        const picked = this.pickSpotifyPlaybackTracks(
          refreshedStored,
          refreshed,
        );
        if (effectiveDeviceId && picked.activeTrack) {
          const resolvedDeviceId =
            await this.spotifyAdapter.resolvePlaybackDeviceId({
              accessToken,
              preferredDeviceId: effectiveDeviceId,
            });
          await this.syncSpotifyPlayback({
            journeyId,
            accessToken,
            deviceId: resolvedDeviceId,
            activeTrack: picked.activeTrack,
            queueTracks: picked.queueTracks,
            shouldStart: true,
          });
        }
        return this.store.getPlaybackSession(journeyId) as PlaybackSession;
      }

      const newActive = queueTracks[0];
      const newQueue = queueTracks.slice(1);
      const newPlayed = activeTrack?.id
        ? [...playedIds, activeTrack.id]
        : playedIds;

      if (effectiveDeviceId && newActive) {
        // Single source of truth: command Spotify to play THIS exact track and reset its context to
        // our queue, so the SDK can't drift onto its own stale queue. (The SDK only skips relatively,
        // which walks Spotify's own queue — that is what made played ≠ shown.)
        const applied = await this.playExact({
          journeyId,
          accessToken,
          deviceId: effectiveDeviceId,
          activeTrack: newActive,
          queueTracks: newQueue,
        });
        if (!applied.deviceReachable) {
          throw new Error("Could not skip to the next track on Spotify.");
        }
      }

      this.saveSession({
        journeyId,
        provider: "spotify",
        deviceId: effectiveDeviceId,
        status: effectiveDeviceId ? "playing" : "degraded",
        activeTrack: newActive,
        queuedTrackIds: newQueue.map((track) => track.id),
        playedTrackIds: newPlayed,
        targetBufferSize: 5,
        lastHeartbeatAt: new Date().toISOString(),
      });

      if (newQueue.length < 4) {
        void this.analyzeJourney(journeyId, "low-buffer").catch(
          () => undefined,
        );
      }
    } else {
      if (playedIds.length === 0) {
        throw new Error("No previous track in this journey yet.");
      }

      const previousId = playedIds[playedIds.length - 1];
      const newActive = stored.find((track) => track.id === previousId);
      if (!newActive) {
        throw new Error("Previous track is no longer available.");
      }

      const newPlayed = playedIds.slice(0, -1);
      const newQueueIds = [
        activeTrack?.id,
        ...queueTracks.map((track) => track.id),
      ].filter((id): id is string => Boolean(id));
      const newQueueTracks = newQueueIds
        .map((id) => stored.find((track) => track.id === id))
        .filter(
          (
            track,
          ): track is ResolvedTrack & {
            id: string;
            addedToPlaylist: boolean;
            savedToPlaylist: boolean;
          } => Boolean(track),
        );

      if (effectiveDeviceId) {
        // Single source of truth: play the exact previous track and reset Spotify's context to our
        // queue, so playback matches the web app instead of Spotify's own drifting queue.
        const applied = await this.playExact({
          journeyId,
          accessToken,
          deviceId: effectiveDeviceId,
          activeTrack: newActive,
          queueTracks: newQueueTracks,
        });
        if (!applied.deviceReachable) {
          throw new Error("Could not skip to the previous track on Spotify.");
        }
      }

      this.saveSession({
        journeyId,
        provider: "spotify",
        deviceId: effectiveDeviceId,
        status: effectiveDeviceId ? "playing" : "degraded",
        activeTrack: newActive,
        queuedTrackIds: newQueueIds.slice(0, 5),
        playedTrackIds: newPlayed,
        targetBufferSize: 5,
        lastHeartbeatAt: new Date().toISOString(),
      });
    }

    this.store.audit(journeyId, "spotify.skip", `Skipped ${direction} track.`, {
      direction,
    });
    return this.store.getPlaybackSession(journeyId) as PlaybackSession;
  }

  async listSpotifyDevices(): Promise<SpotifyDevice[]> {
    if (!this.spotifyAdapter.listDevices) return [];
    try {
      const accessToken = await this.spotifyAuth.getAccessToken();
      return await this.spotifyAdapter.listDevices({ accessToken });
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "spotify.devices.failed",
      );
      return [];
    }
  }

  async setSpotifyTransport(
    journeyId: string,
    action: "pause" | "resume",
    deviceId?: string,
  ): Promise<PlaybackSession> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.provider !== "spotify") {
      throw new Error(
        "Transport control is only supported for Spotify journeys.",
      );
    }
    const session = this.store.getPlaybackSession(journeyId);
    const effectiveDeviceId =
      deviceId ?? journey.spotifyDeviceId ?? session?.deviceId;
    if (effectiveDeviceId) {
      try {
        const accessToken = await this.spotifyAuth.getAccessToken();
        const resolved = await this.spotifyAdapter.resolvePlaybackDeviceId({
          accessToken,
          preferredDeviceId: effectiveDeviceId,
        });
        if (action === "pause") {
          await this.spotifyAdapter.pausePlayback?.({
            accessToken,
            deviceId: resolved,
          });
        } else {
          await this.spotifyAdapter.resumePlayback?.({
            accessToken,
            deviceId: resolved,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          { journeyId, action, err: message },
          "spotify.transport.degraded",
        );
        this.store.audit(
          journeyId,
          "spotify.playback_error",
          `Spotify ${action} command failed.`,
          { error: message },
        );
      }
    }
    return this.store.getPlaybackSession(journeyId) as PlaybackSession;
  }

  async switchToTidalFallback(journeyId: string): Promise<JourneyRecord> {
    const journey = this.getJourneyOrThrow(journeyId);
    await this.ensureTidalPlaylist(journeyId, journey.destination);
    this.store.updateJourneyProvider(journeyId, "tidal");
    this.saveSession({
      journeyId,
      provider: "tidal",
      status: "fallback",
      queuedTrackIds: [],
      targetBufferSize: 5,
      lastHeartbeatAt: new Date().toISOString(),
    });
    this.store.audit(
      journeyId,
      "tidal.fallback_enabled",
      "Journey switched to TIDAL fallback mode.",
    );
    await this.analyzeJourney(journeyId, "tidal-fallback");
    return this.getJourneyOrThrow(journeyId);
  }

  private async analyzeTidalJourney(
    journey: JourneyRecord,
    reason: string,
  ): Promise<PlaylistUpdate> {
    const journeyId = journey.id;
    const telemetry = this.store.latestTelemetry(journeyId);
    const context = contextFromJourney(
      journey,
      telemetry,
      this.store.recentTelemetry(journeyId),
    );
    // NOTE: Music wishes currently steer only Spotify journeys (the default
    // provider); TIDAL is a fallback path, so wishes are stored and surfaced but
    // intentionally not applied to curation or decayed here. See analyzeSpotifyJourney.
    const policy = buildRecommendationPolicy(context);
    const candidates = await this.generateAndStoreCandidateSet(
      journeyId,
      context,
      policy,
      12,
    );
    const accessToken = await this.tidalAuth.getAccessToken();
    const resolver = new TidalResolver(this.tidalAdapter, {
      accessToken,
      countryCode: this.config.TIDAL_COUNTRY_CODE,
    });
    const resolved = await resolver.resolveCandidates(candidates);
    const resolvedIds = this.storeResolved(journeyId, candidates, resolved);
    const stored = this.store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "tidal");
    const alreadyAdded = new Set(
      stored
        .filter((track) => track.addedToPlaylist)
        .map((track) => track.providerTrackId),
    );
    let selected = selectRollingBatch(stored, alreadyAdded, 5);

    if (selected.length < 5) {
      this.store.audit(
        journeyId,
        "recommendation.fallback",
        "Initial analysis resolved fewer than 5 tracks; running fallback.",
      );
      const fallbackCandidates = await this.generateAndStoreCandidateSet(
        journeyId,
        context,
        policy,
        8,
      );
      const fallbackResolved =
        await resolver.resolveCandidates(fallbackCandidates);
      this.storeResolved(journeyId, fallbackCandidates, fallbackResolved);
      selected = selectRollingBatch(
        this.store
          .listResolvedTracks(journeyId)
          .filter((track) => track.provider === "tidal"),
        alreadyAdded,
        5,
      );
    }

    const status =
      selected.length === 5
        ? "success"
        : selected.length > 0
          ? "degraded"
          : "failed";
    const update: PlaylistUpdate = {
      id: crypto.randomUUID(),
      journeyId,
      provider: "tidal",
      batchSize: selected.length,
      candidateIds: candidates
        .map((candidate) => candidate.id)
        .filter(Boolean) as string[],
      resolvedTrackIds: selected.map((track) => track.id),
      idempotencyKey: `journey-${journeyId}-${Date.now()}`,
      status,
      createdAtIso: new Date().toISOString(),
    };

    if (selected.length > 0 && journey.tidalPlaylistId) {
      await this.tidalAdapter.addTracks({
        accessToken,
        playlistId: journey.tidalPlaylistId,
        trackIds: selected.map((track) => track.providerTrackId),
        countryCode: this.config.TIDAL_COUNTRY_CODE,
        idempotencyKey: update.idempotencyKey,
      });
      this.store.markTracksAdded(selected.map((track) => track.id));
    }

    this.store.savePlaylistUpdate(update);
    this.store.audit(
      journeyId,
      "playlist.updated",
      `Playlist update ${status}: ${selected.length} tracks added.`,
      {
        reason,
        trackIds: selected.map((track) => track.providerTrackId),
        resolvedIds,
      },
    );
    return update;
  }

  private async analyzeSpotifyJourney(
    journey: JourneyRecord,
    reason: string,
  ): Promise<PlaylistUpdate> {
    const journeyId = journey.id;
    const telemetry = this.store.latestTelemetry(journeyId);
    const context = contextFromJourney(
      journey,
      telemetry,
      this.store.recentTelemetry(journeyId),
    );
    const activeMusicWishes = this.store.listActiveMusicWishes(journeyId);
    const contextWithWishes: JourneyContext = { ...context, activeMusicWishes };

    const variety = makeVarietyContext({
      journeyId,
      elapsedMinutes: context.elapsedMinutes,
      bucketMinutes: this.config.VARIETY_BUCKET_MINUTES,
      phase: context.phase,
      speedBucket: context.speedBucket,
      driveMode: context.driveState?.mode ?? journey.driveMode,
    });
    const recentPlays = this.config.RECENT_FATIGUE_ENABLED
      ? this.store.listRecentlyPlayed(
          this.config.RECENT_FATIGUE_HOURS * 60 * 60 * 1000,
        )
      : [];
    const recentArtistPenalty = new Map<string, number>();
    const recentSongPenalty = new Map<string, number>();
    const fatigueHorizonMs = Math.max(
      1,
      this.config.RECENT_FATIGUE_HOURS * 60 * 60 * 1000,
    );
    for (const play of recentPlays) {
      const decay = Math.max(0, 1 - play.ageMs / fatigueHorizonMs);
      const artistKey = normalizeText(play.artist);
      recentArtistPenalty.set(
        artistKey,
        Math.max(
          recentArtistPenalty.get(artistKey) ?? 0,
          this.config.RECENT_FATIGUE_ARTIST_PENALTY * decay,
        ),
      );
      recentSongPenalty.set(
        play.songKey,
        Math.max(
          recentSongPenalty.get(play.songKey) ?? 0,
          this.config.RECENT_FATIGUE_SONG_PENALTY * decay,
        ),
      );
    }
    const wishArtists = activeMusicWishes
      .flatMap((wish) => wish.intents)
      .flatMap((intent) =>
        intent.type === "artist"
          ? [intent.artist]
          : intent.type === "song" && intent.artist
            ? [intent.artist]
            : [],
      );
    const groundedContext: JourneyContext = {
      ...contextWithWishes,
      varietyAngle: seededExplorationAngle(variety.seed),
      recentlyPlayedArtists: [...recentArtistPenalty.keys()].slice(0, 12),
    };

    // Cost control: only the LLM lenses cost tokens. Run them when the vibe actually changes;
    // for routine top-ups, reuse the already-generated candidate pool if it can refill the buffer.
    const vibeChangingReasons = new Set([
      "initial",
      "phase-change",
      "phase-override",
      "taste-override",
      "manual",
      "recovery",
      "music-wish",
      "music-wish-undo",
    ]);
    const priorSession = this.store.getPlaybackSession(journeyId);
    const storedForGate = this.store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "spotify");

    // "Consumed" = every track already surfaced this journey (active, queued, played, or ever added
    // to the buffer). Selection and generation must never resurface these — neither the exact
    // recording (provider id) nor another version of the same song (song key).
    const consumedTrackIds = new Set<string>();
    for (const id of priorSession?.queuedTrackIds ?? [])
      consumedTrackIds.add(id);
    for (const id of priorSession?.playedTrackIds ?? [])
      consumedTrackIds.add(id);
    if (priorSession?.activeTrack?.id)
      consumedTrackIds.add(priorSession.activeTrack.id);
    for (const track of storedForGate) {
      if (track.addedToPlaylist) consumedTrackIds.add(track.id);
    }
    const consumedTracks = storedForGate.filter((track) =>
      consumedTrackIds.has(track.id),
    );
    const consumedProviderIds = new Set(
      consumedTracks.map((track) => track.providerTrackId),
    );
    const consumedSongKeys = new Set(
      consumedTracks.map((track) => songKey(track.artist, track.title)),
    );

    const unusedPool = storedForGate.filter(
      (track) =>
        track.providerUri &&
        track.isPlayable !== false &&
        !consumedTrackIds.has(track.id) &&
        !consumedSongKeys.has(songKey(track.artist, track.title)),
    );
    const neededNow = Math.max(
      0,
      5 - (priorSession?.queuedTrackIds?.length ?? 0),
    );
    const mustGenerate =
      vibeChangingReasons.has(reason) ||
      reason.startsWith("drive-state:") ||
      unusedPool.length < neededNow;

    const tokenStartedAt = Date.now();
    const accessToken = await this.spotifyAuth.getAccessToken();
    this.logger.info(
      { journeyId, ms: Date.now() - tokenStartedAt },
      "spotify.token.done",
    );

    // Personalize the brief with the listener's taste (cached ~24h). Built once and reused for any
    // fallback regeneration below so the whole drive shares one taste signal.
    let scoutContext: JourneyContext = groundedContext;
    let policy = applyMusicWishesToPolicy(
      buildRecommendationPolicy(groundedContext),
      activeMusicWishes,
    );
    let candidates: SongCandidate[] = [];
    if (mustGenerate) {
      const tasteProfile = await this.loadTasteProfile(accessToken);
      scoutContext = {
        ...groundedContext,
        tasteProfile,
        tasteWeight: journey.tasteWeight ?? DEFAULT_TASTE_WEIGHT,
      };
      policy = applyMusicWishesToPolicy(
        buildRecommendationPolicy(scoutContext),
        activeMusicWishes,
      );
      candidates = this.filterFreshCandidates(
        await this.generateAndStoreCandidateSet(
          journeyId,
          scoutContext,
          policy,
          8,
          variety.seed,
        ),
        consumedSongKeys,
      );
    } else {
      this.logger.info(
        { journeyId, reason, poolSize: unusedPool.length, needed: neededNow },
        "scout.pool_reuse",
      );
      this.store.audit(
        journeyId,
        "recommendation.pool_reuse",
        `Reused ${unusedPool.length} already-generated candidates; skipped AI generation.`,
        { reason },
      );
    }
    const resolver = new SpotifyResolver(this.spotifyAdapter, {
      accessToken,
      market: this.config.SPOTIFY_MARKET,
      searchTimeoutMs: 8_000,
      targetResolveCount: policy.cleanRequired ? 12 : 10,
      // Persistent cache: each song is searched on Spotify at most once across the whole drive.
      cache: {
        get: (key) => this.store.getCachedSpotifySearch(key),
        set: (key, value) => this.store.saveCachedSpotifySearch(key, value),
      },
    });
    const resolveStartedAt = Date.now();
    const resolved = await resolver.resolveCandidates(candidates);
    this.logger.info(
      {
        journeyId,
        candidates: candidates.length,
        resolved: resolved.length,
        ms: Date.now() - resolveStartedAt,
      },
      "spotify.resolve.done",
    );
    const resolvedIds = this.storeResolved(journeyId, candidates, resolved);

    let stored = this.store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "spotify");
    let session = this.store.getPlaybackSession(journeyId);
    const consumedArtistKeys = new Set(
      consumedTracks.map((track) => normalizeText(track.artist)),
    );
    const rankedStored = rankResolvedTracksForPolicy(
      stored,
      {
        ...policy,
        avoidArtists: [...consumedArtistKeys],
        avoidSongKeys: [...consumedSongKeys],
      },
      {
        consumedArtists: consumedTracks.map((track) => track.artist),
        seed: variety.seed,
        jitterStrength: this.config.RANK_JITTER_ENABLED
          ? this.config.RANK_JITTER_STRENGTH
          : 0,
        recentArtistPenalty,
        recentSongPenalty,
        fatigueExemptArtists: wishArtists,
      },
    );
    const immediateWishKeys = this.immediateWishSongKeys(activeMusicWishes);
    const immediateWishTrack = rankedStored.find((track) => {
      const exact = songKey(track.artist, track.title);
      const titleOnly = songKey("", track.title);
      return immediateWishKeys.has(exact) || immediateWishKeys.has(titleOnly);
    });
    const isWishApplicationPass =
      reason === "music-wish" || reason === "music-wish-undo";
    const shouldRebuildQueueForWish =
      isWishApplicationPass || (reason === "manual" && activeMusicWishes.length > 0);
    let activeTrack =
      immediateWishTrack ??
      (session?.activeTrack && session.activeTrack.provider === "spotify"
        ? stored.find((track) => track.id === session?.activeTrack?.id)
        : undefined);

    if (!activeTrack) {
      activeTrack = rankedStored.find(
        (track) => track.providerUri && track.isPlayable !== false,
      );
    }

    const currentQueued = (session?.queuedTrackIds ?? [])
      .map((id) => stored.find((track) => track.id === id))
      .filter(
        (
          track,
        ): track is ResolvedTrack & {
          id: string;
          addedToPlaylist: boolean;
          savedToPlaylist: boolean;
        } => Boolean(track),
      );
    const preservedQueued = shouldRebuildQueueForWish ? [] : currentQueued;
    const needed = Math.max(0, 5 - preservedQueued.length);
    const selected = queueTracksForBuffer(rankedStored, {
      activeProviderTrackId: activeTrack?.providerTrackId,
      alreadyQueuedProviderIds: new Set(
        preservedQueued.map((track) => track.providerTrackId),
      ),
      excludeProviderTrackIds: consumedProviderIds,
      excludeSongKeys: consumedSongKeys,
      excludeArtistKeys: consumedArtistKeys,
      preferDistinctArtists: policy.preferDistinctArtists,
      cleanRequired: policy.cleanRequired,
      targetBufferSize: needed,
    });

    if (preservedQueued.length + selected.length < 5) {
      this.store.audit(
        journeyId,
        "recommendation.fallback",
        "Spotify analysis resolved fewer than 5 future tracks; running fallback.",
      );
      const fallbackCandidates = this.filterFreshCandidates(
        await this.generateAndStoreCandidateSet(
          journeyId,
          scoutContext,
          policy,
          8,
          variety.seed,
        ),
        consumedSongKeys,
      );
      const fallbackResolved =
        await resolver.resolveCandidates(fallbackCandidates);
      this.storeResolved(journeyId, fallbackCandidates, fallbackResolved);
      stored = this.store
        .listResolvedTracks(journeyId)
        .filter((track) => track.provider === "spotify");
      const rankedFallbackStored = rankResolvedTracksForPolicy(
        stored,
        {
          ...policy,
          avoidArtists: [...consumedArtistKeys],
          avoidSongKeys: [...consumedSongKeys],
        },
        {
          consumedArtists: consumedTracks.map((track) => track.artist),
          seed: variety.seed,
          jitterStrength: this.config.RANK_JITTER_ENABLED
            ? this.config.RANK_JITTER_STRENGTH
            : 0,
          recentArtistPenalty,
          recentSongPenalty,
          fatigueExemptArtists: wishArtists,
        },
      );
      const alreadyQueued = new Set([
        ...preservedQueued.map((track) => track.providerTrackId),
        ...selected.map((track) => track.providerTrackId),
      ]);
      const additional = queueTracksForBuffer(rankedFallbackStored, {
        activeProviderTrackId: activeTrack?.providerTrackId,
        alreadyQueuedProviderIds: alreadyQueued,
        excludeProviderTrackIds: consumedProviderIds,
        excludeSongKeys: consumedSongKeys,
        excludeArtistKeys: consumedArtistKeys,
        preferDistinctArtists: policy.preferDistinctArtists,
        cleanRequired: policy.cleanRequired,
        targetBufferSize: Math.max(
          0,
          5 - preservedQueued.length - selected.length,
        ),
      });
      for (const track of additional) {
        if (
          !selected.some(
            (item) => item.providerTrackId === track.providerTrackId,
          )
        ) {
          selected.push(track);
        }
        if (preservedQueued.length + selected.length >= 5) {
          break;
        }
      }
    }

    const quotaSelected = this.enforceWishQuota({
      selected,
      rankedStored,
      wishes: activeMusicWishes,
      excludeProviderIds: consumedProviderIds,
    });
    selected.length = 0;
    selected.push(...quotaSelected);

    session = this.store.getPlaybackSession(journeyId);
    const deviceId = journey.spotifyDeviceId ?? session?.deviceId;
    // The visible model decides what reaches the device: Spotify must never be sent a
    // track the 5-slot model doesn't show, or the reconciler later flags our own queue
    // as "external". Compute the model first and sync exactly its delta.
    const queuedTracks = [...preservedQueued, ...selected].slice(0, 5);
    const preservedIds = new Set(preservedQueued.map((track) => track.id));
    const queueDelta = queuedTracks.filter(
      (track) => !preservedIds.has(track.id),
    );
    const playbackApplied = deviceId
      ? await this.syncSpotifyPlayback({
          journeyId,
          accessToken,
          deviceId,
          activeTrack,
          queueTracks: queueDelta,
          shouldStart: Boolean(
            activeTrack?.providerUri &&
            (!session?.activeTrack || session.status !== "playing"),
          ),
        })
      : { deviceReachable: false };

    const playedActiveTrack = playbackApplied.deviceReachable
      ? activeTrack
      : (session?.activeTrack ?? activeTrack);
    const status =
      queuedTracks.length === 5 &&
      playbackApplied.deviceReachable &&
      !playbackApplied.rateLimited
        ? "success"
        : queuedTracks.length > 0
          ? "degraded"
          : "failed";
    const update: PlaylistUpdate = {
      id: crypto.randomUUID(),
      journeyId,
      provider: "spotify",
      batchSize: selected.length,
      candidateIds: candidates
        .map((candidate) => candidate.id)
        .filter(Boolean) as string[],
      resolvedTrackIds: queuedTracks.map((track) => track.id),
      idempotencyKey: `journey-${journeyId}-${Date.now()}`,
      status,
      createdAtIso: new Date().toISOString(),
    };

    this.store.markTracksAdded(
      [activeTrack?.id, ...queuedTracks.map((track) => track.id)].filter(
        Boolean,
      ) as string[],
    );
    // Decay wishes only on passes driven by actual playback progression, by the tracks
    // the listener advanced through (the buffer deficit we just refilled, `needed`).
    // NEVER on a wish refresh pass: the listener has not advanced through a
    // track yet, so the wish must keep its budget instead of expiring during
    // re-curation.
    if (!shouldRebuildQueueForWish) {
      this.store.decayActiveMusicWishes(
        journeyId,
        needed + (immediateWishTrack ? 1 : 0),
      );
    }
    if (this.config.RECENT_FATIGUE_ENABLED) {
      const surfaced = [activeTrack, ...queuedTracks].filter(
        (track): track is NonNullable<typeof track> => Boolean(track),
      );
      this.store.recordRecentPlays(
        journeyId,
        surfaced.map((track) => ({ artist: track.artist, title: track.title })),
      );
    }
    this.store.savePlaylistUpdate(update);
    this.saveSession({
      journeyId,
      provider: "spotify",
      deviceId,
      status: status === "success" ? "playing" : deviceId ? "degraded" : "idle",
      activeTrack: playedActiveTrack,
      queuedTrackIds: queuedTracks.map((track) => track.id),
      // Preserve skip-back history across refreshes/refills (was dropped → wiped played on every analyze).
      playedTrackIds: session?.playedTrackIds ?? [],
      targetBufferSize: 5,
      lastHeartbeatAt: new Date().toISOString(),
    });
    this.store.audit(
      journeyId,
      "spotify.queue_updated",
      `Spotify queue update ${status}: ${queuedTracks.length}/5 future tracks.`,
      {
        reason,
        activeTrackId: activeTrack?.providerTrackId,
        queuedTrackIds: queuedTracks.map((track) => track.providerTrackId),
        resolvedIds,
      },
    );
    // Mirror the curated set into the saved journey playlist (best-effort; never blocks the journey).
    await this.syncJourneyPlaylist(journey, accessToken);
    return update;
  }

  private immediateWishSongKeys(wishes: MusicWish[]): Set<string> {
    const keys = new Set<string>();
    for (const wish of wishes) {
      if (wish.status !== "active" && wish.status !== "soft_applied") continue;
      for (const intent of wish.intents) {
        if (intent.type === "song" && intent.immediate) {
          keys.add(songKey(intent.artist ?? "", intent.title));
          keys.add(songKey("", intent.title));
        }
      }
    }
    return keys;
  }

  /**
   * Enforces the hard wish quota: ensures at least WISH_QUOTA_MIN tracks per active
   * artist wish are in the next queue, capped at WISH_QUOTA_MAX_SLOTS total wish slots,
   * by swapping the lowest-ranked non-wish, non-pinned selected tracks for the top-ranked
   * unused wish-artist tracks. Returns the (possibly modified) selected list.
   */
  private enforceWishQuota<T extends ResolvedTrack & { id: string }>(args: {
    selected: T[];
    rankedStored: T[];
    wishes: MusicWish[];
    excludeProviderIds: Set<string>;
  }): T[] {
    const min = this.config.WISH_QUOTA_MIN;
    const maxSlots = this.config.WISH_QUOTA_MAX_SLOTS;
    if (min <= 0 || maxSlots <= 0) return [...args.selected];

    const wishArtistKeys = new Set(
      args.wishes
        .filter(
          (wish) => wish.status === "active" || wish.status === "soft_applied",
        )
        .flatMap((wish) => wish.intents)
        .flatMap((intent) =>
          intent.type === "artist" ? [normalizeText(intent.artist)] : [],
        ),
    );
    if (wishArtistKeys.size === 0) return [...args.selected];

    const isWishTrack = (track: ResolvedTrack) =>
      wishArtistKeys.has(normalizeText(track.artist));

    const selected = [...args.selected];
    const inQueueIds = new Set(selected.map((track) => track.providerTrackId));
    let wishSlots = selected.filter(isWishTrack).length;

    const wishCandidates = args.rankedStored.filter(
      (track) =>
        isWishTrack(track) &&
        track.providerUri &&
        track.isPlayable !== false &&
        !inQueueIds.has(track.providerTrackId) &&
        !args.excludeProviderIds.has(track.providerTrackId),
    );

    const target = Math.min(maxSlots, Math.max(min, wishSlots));
    for (const candidate of wishCandidates) {
      if (wishSlots >= target) break;
      const victimIndex = [...selected]
        .map((track, index) => ({ track, index }))
        .reverse()
        .find(({ track }) => !isWishTrack(track))?.index;
      if (victimIndex === undefined) break;
      selected[victimIndex] = candidate;
      inQueueIds.add(candidate.providerTrackId);
      wishSlots += 1;
    }
    return selected;
  }

  private pickSpotifyPlaybackTracks(
    stored: Array<
      ResolvedTrack & {
        id: string;
        addedToPlaylist: boolean;
        savedToPlaylist: boolean;
      }
    >,
    session?: PlaybackSession,
  ): {
    activeTrack?: ResolvedTrack & {
      id: string;
      addedToPlaylist: boolean;
      savedToPlaylist: boolean;
    };
    queueTracks: Array<
      ResolvedTrack & {
        id: string;
        addedToPlaylist: boolean;
        savedToPlaylist: boolean;
      }
    >;
    queuedTrackIds: string[];
  } {
    const queued = (session?.queuedTrackIds ?? [])
      .map((id) => stored.find((track) => track.id === id))
      .filter(
        (
          track,
        ): track is ResolvedTrack & {
          id: string;
          addedToPlaylist: boolean;
          savedToPlaylist: boolean;
        } => Boolean(track),
      );

    if (session?.activeTrack) {
      const active = stored.find(
        (track) => track.id === session.activeTrack?.id,
      );
      if (active) {
        const queueTracks = queued.filter((track) => track.id !== active.id);
        return {
          activeTrack: active,
          queueTracks,
          // Convention everywhere else in this service: queuedTrackIds are the FUTURE
          // tracks only. Prepending the active here used to shift the real 5th queue
          // track out of the model while it stayed queued on the device.
          queuedTrackIds: queueTracks.map((track) => track.id).slice(0, 5),
        };
      }
    }

    if (queued.length > 0) {
      const [head, ...tail] = queued;
      return {
        activeTrack: head,
        queueTracks: tail,
        queuedTrackIds: queued.map((track) => track.id).slice(0, 5),
      };
    }

    const fallback = stored.find(
      (track) => track.providerUri && track.isPlayable !== false,
    );
    return {
      activeTrack: fallback,
      queueTracks: [],
      queuedTrackIds: fallback ? [fallback.id] : [],
    };
  }

  /**
   * Plays an EXACT track list on the already-active device via a single absolute `startPlayback`
   * (no transfer/pause dance), so Spotify's playback and "next" become identical to our model.
   * Falls back to the full transfer+start sync only if the device isn't active yet.
   */
  private async playExact(args: {
    journeyId: string;
    accessToken: string;
    deviceId: string;
    activeTrack?: ResolvedTrack;
    queueTracks: ResolvedTrack[];
  }): Promise<{ deviceReachable: boolean; rateLimited?: boolean }> {
    // Same single-ordering-source contract as syncSpotifyPlayback: play ONLY the exact
    // track as the context and keep the upcoming order in Spotify's queue. A multi-track
    // context would be preempted by previously queued items and drift from the model.
    const startUri =
      args.activeTrack?.providerUri ??
      args.queueTracks
        .map((track) => track.providerUri)
        .find((uri): uri is string => Boolean(uri));
    if (!startUri) {
      return { deviceReachable: false };
    }

    const deviceId = await this.spotifyAdapter.resolvePlaybackDeviceId({
      accessToken: args.accessToken,
      preferredDeviceId: args.deviceId,
    });

    try {
      await this.spotifyAdapter.startPlayback({
        accessToken: args.accessToken,
        deviceId,
        uris: [startUri],
      });
      if (args.activeTrack?.providerUri) {
        this.store.saveQueueOperation({
          id: crypto.randomUUID(),
          journeyId: args.journeyId,
          provider: "spotify",
          providerTrackId: args.activeTrack.providerTrackId,
          providerUri: args.activeTrack.providerUri,
          operation: "start",
          status: "success",
          deviceId,
          createdAtIso: new Date().toISOString(),
        });
      }
      // Top up the device queue with whatever part of the modeled queue it is missing
      // (no-ops for entries that are already queued — Spotify's queue is append-only).
      const queueOutcome = await this.queueMissingTracks({
        journeyId: args.journeyId,
        accessToken: args.accessToken,
        deviceId,
        tracks: args.queueTracks,
        excludeUri: startUri,
      });
      if (queueOutcome === "unreachable") {
        return { deviceReachable: false };
      }
      return {
        deviceReachable: true,
        rateLimited: queueOutcome === "rate-limited" || undefined,
      };
    } catch (error) {
      // Device not active yet (e.g. Webplayer just (re)connected): fall back to transfer + start.
      if (isSpotifyDeviceNotFoundError(error)) {
        return this.syncSpotifyPlayback({
          journeyId: args.journeyId,
          accessToken: args.accessToken,
          deviceId,
          activeTrack: args.activeTrack,
          queueTracks: args.queueTracks,
          shouldStart: true,
        });
      }
      if (isSpotifyRateLimitError(error)) {
        return { deviceReachable: true, rateLimited: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { journeyId: args.journeyId, deviceId, err: message },
        "spotify.play.degraded",
      );
      this.store.audit(
        args.journeyId,
        "spotify.playback_error",
        "Spotify play failed; queue saved, playback degraded.",
        {
          deviceId,
          error: message,
        },
      );
      return { deviceReachable: false };
    }
  }

  /**
   * Appends the given tracks to the device queue, skipping anything the device already has
   * queued. Spotify's queue is append-only (no remove/reorder API), so re-syncs MUST be
   * idempotent or every webplayer reload / device-ready pass would duplicate the queue.
   */
  private async queueMissingTracks(args: {
    journeyId: string;
    accessToken: string;
    deviceId: string;
    tracks: ResolvedTrack[];
    /** URI just started as the playback context — never re-queue it. */
    excludeUri?: string;
  }): Promise<"ok" | "rate-limited" | "unreachable"> {
    const candidates = args.tracks.filter(
      (track) => track.providerUri && track.providerUri !== args.excludeUri,
    );
    if (candidates.length === 0) return "ok";

    let deviceQueuedIds: ReadonlySet<string> = new Set<string>();
    try {
      const state = await this.spotifyAdapter.getPlaybackState({
        accessToken: args.accessToken,
        market: this.config.SPOTIFY_MARKET,
      });
      deviceQueuedIds = new Set(state.queuedProviderTrackIds);
    } catch {
      // Best-effort: without queue visibility we still add — a rare duplicate beats a gap.
    }

    for (const track of candidates) {
      if (deviceQueuedIds.has(track.providerTrackId)) continue;
      try {
        await this.spotifyAdapter.addToQueue({
          accessToken: args.accessToken,
          deviceId: args.deviceId,
          uri: track.providerUri as string,
        });
        this.store.saveQueueOperation({
          id: crypto.randomUUID(),
          journeyId: args.journeyId,
          provider: "spotify",
          providerTrackId: track.providerTrackId,
          providerUri: track.providerUri as string,
          operation: "queue",
          status: "success",
          deviceId: args.deviceId,
          createdAtIso: new Date().toISOString(),
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
      } catch (error) {
        if (isSpotifyDeviceNotFoundError(error)) {
          return "unreachable";
        }
        if (isSpotifyRateLimitError(error)) {
          return "rate-limited";
        }
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          { journeyId: args.journeyId, deviceId: args.deviceId, err: message },
          "spotify.queue.degraded",
        );
        this.store.audit(
          args.journeyId,
          "spotify.playback_error",
          "Spotify queue add failed; remaining tracks saved, playback degraded.",
          {
            deviceId: args.deviceId,
            error: message,
          },
        );
        return "unreachable";
      }
    }
    return "ok";
  }

  private async syncSpotifyPlayback(args: {
    journeyId: string;
    accessToken: string;
    deviceId: string;
    activeTrack?: ResolvedTrack;
    queueTracks: ResolvedTrack[];
    shouldStart: boolean;
  }): Promise<{ deviceReachable: boolean; rateLimited?: boolean }> {
    const deviceId = await this.spotifyAdapter.resolvePlaybackDeviceId({
      accessToken: args.accessToken,
      preferredDeviceId: args.deviceId,
    });

    let transferFailed = false;
    try {
      await this.spotifyAdapter.transferPlayback({
        accessToken: args.accessToken,
        deviceId,
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
    } catch (error) {
      if (isSpotifyDeviceNotFoundError(error)) {
        transferFailed = true;
        this.store.audit(
          args.journeyId,
          "spotify.device_missing",
          "Spotify Webplayer not active yet; will retry play.",
          {
            deviceId,
          },
        );
      } else if (isSpotifyRateLimitError(error)) {
        return { deviceReachable: true, rateLimited: true };
      } else {
        // Playback is best-effort: a transient Spotify error (e.g. 500) must not fail the
        // journey. The queue is already saved; degrade and let the user retry playback.
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          { journeyId: args.journeyId, deviceId, err: message },
          "spotify.transfer.degraded",
        );
        this.store.audit(
          args.journeyId,
          "spotify.playback_error",
          "Spotify transfer failed; queue saved, playback degraded.",
          {
            deviceId,
            error: message,
          },
        );
        return { deviceReachable: false };
      }
    }

    // Single ordering source: start ONLY the active track as the playback context and feed
    // every upcoming track through Spotify's queue. A multi-track context cannot be kept in
    // sync with later queue adds — Spotify plays manually queued items BEFORE the context
    // remainder — which made the device order diverge from the model on real drives until
    // the reconciler flagged our own curation as "external".
    const startUri =
      args.activeTrack?.providerUri ??
      args.queueTracks
        .map((track) => track.providerUri)
        .find((uri): uri is string => Boolean(uri));

    let startedActive = false;
    if (args.shouldStart && startUri) {
      try {
        await this.spotifyAdapter.startPlayback({
          accessToken: args.accessToken,
          deviceId,
          uris: [startUri],
        });
        startedActive = true;
        if (args.activeTrack?.providerUri) {
          this.store.saveQueueOperation({
            id: crypto.randomUUID(),
            journeyId: args.journeyId,
            provider: "spotify",
            providerTrackId: args.activeTrack.providerTrackId,
            providerUri: args.activeTrack.providerUri,
            operation: "start",
            status: "success",
            deviceId,
            createdAtIso: new Date().toISOString(),
          });
        }
      } catch (error) {
        if (isSpotifyDeviceNotFoundError(error)) {
          return { deviceReachable: false };
        }
        if (isSpotifyRateLimitError(error)) {
          return { deviceReachable: true, rateLimited: true };
        }
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          { journeyId: args.journeyId, deviceId, err: message },
          "spotify.start.degraded",
        );
        this.store.audit(
          args.journeyId,
          "spotify.playback_error",
          "Spotify start playback failed; queue saved, playback degraded.",
          {
            deviceId,
            error: message,
          },
        );
        return { deviceReachable: false };
      }
    }

    const queueOutcome = await this.queueMissingTracks({
      journeyId: args.journeyId,
      accessToken: args.accessToken,
      deviceId,
      tracks: args.queueTracks,
      excludeUri: startedActive ? startUri : undefined,
    });
    if (queueOutcome === "unreachable") {
      return { deviceReachable: false };
    }

    if (!startedActive && transferFailed) {
      return { deviceReachable: false };
    }
    return {
      deviceReachable: true,
      rateLimited: queueOutcome === "rate-limited" || undefined,
    };
  }

  async maybeRefreshActiveJourneys(): Promise<void> {
    if (this.analyzeByJourney.size > 0) {
      return;
    }

    for (const journey of this.store.listActiveJourneys()) {
      const latest = this.store.latestPlaylistUpdate(journey.id);
      if (!latest) {
        await this.analyzeJourney(journey.id, "recovery");
        continue;
      }

      const ageMs = Date.now() - new Date(latest.createdAtIso).getTime();
      const session = this.store.getPlaybackSession(journey.id);
      const unresolvedBuffer =
        journey.provider === "spotify"
          ? (session?.queuedTrackIds.length ?? 0)
          : this.store
              .listResolvedTracks(journey.id)
              .filter(
                (track) => track.provider === "tidal" && !track.addedToPlaylist,
              ).length;
      if (ageMs > this.config.journeyRefreshMs || unresolvedBuffer < 5) {
        await this.analyzeJourney(
          journey.id,
          ageMs > this.config.journeyRefreshMs ? "time-window" : "low-buffer",
        );
      }
    }
  }

  /**
   * Reconciles the backend playback model against the track Spotify reports as actually playing,
   * so skips made in the native Tesla Spotify miniplayer (which the server never sees otherwise)
   * advance our `played`/`active`/`queued` state and trigger curated refill. Best-effort: never throws.
   *
   * @returns the playback outcome, used by the poller to pick its next (adaptive) interval.
   */
  async reconcileSpotifyPlayback(
    journeyId: string,
  ): Promise<"playing" | "idle" | "external"> {
    const journey = this.store.getJourney(journeyId);
    if (
      !journey ||
      journey.provider !== "spotify" ||
      journey.status !== "active"
    ) {
      return "idle";
    }
    const session = this.store.getPlaybackSession(journeyId);
    if (!session) {
      return "idle";
    }

    let accessToken: string;
    let state: Awaited<ReturnType<SpotifyAdapter["getPlaybackState"]>>;
    try {
      accessToken = await this.spotifyAuth.getAccessToken();
      state = await this.spotifyAdapter.getPlaybackState({
        accessToken,
        market: this.config.SPOTIFY_MARKET,
      });
    } catch (error) {
      this.logger.warn(
        {
          journeyId,
          err: error instanceof Error ? error.message : String(error),
        },
        "spotify.reconcile_error",
      );
      return "idle";
    }

    const now = new Date().toISOString();

    // Nothing playing → leave the model untouched, just back the poller off. A session that
    // was playing is now truthfully "paused" so the UI doesn't show a stopped journey as live.
    if (!state.isPlaying || !state.activeProviderTrackId) {
      if (session.status === "playing") {
        this.saveSession({ ...session, status: "paused", lastHeartbeatAt: now });
      }
      return "idle";
    }

    const stored = this.store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "spotify");
    const { activeTrack, queueTracks } = this.pickSpotifyPlaybackTracks(
      stored,
      session,
    );
    const model = [activeTrack, ...queueTracks].filter(
      (
        track,
      ): track is ResolvedTrack & {
        id: string;
        addedToPlaylist: boolean;
        savedToPlaylist: boolean;
      } => Boolean(track),
    );
    const result = reconcilePlaybackModel(
      model.map((track) => track.providerTrackId),
      state.activeProviderTrackId,
      new Set(stored.map((track) => track.providerTrackId)),
    );

    if (result.kind === "drifted") {
      // One of OUR journey tracks is on air, just not at a position the 6-slot model shows.
      // Spotify's queue is append-only (no remove/reorder), so stale adds or a wish rebuild
      // can legitimately put such a track on air. Re-anchor the model on reality instead of
      // pausing curation as "external".
      const driftedTrack = stored.find(
        (track) => track.providerTrackId === state.activeProviderTrackId,
      );
      if (driftedTrack) {
        const remainingQueue = model
          .filter(
            (track) =>
              track.id !== driftedTrack.id && track.id !== activeTrack?.id,
          )
          .map((track) => track.id)
          .slice(0, 5);
        this.saveSession({
          journeyId,
          provider: "spotify",
          deviceId: session.deviceId,
          status: "playing",
          activeTrack: driftedTrack,
          queuedTrackIds: remainingQueue,
          playedTrackIds: [
            ...(session.playedTrackIds ?? []),
            ...(activeTrack?.id && activeTrack.id !== driftedTrack.id
              ? [activeTrack.id]
              : []),
          ],
          targetBufferSize: 5,
          lastHeartbeatAt: now,
        });
        this.store.audit(
          journeyId,
          "spotify.playback_reanchored",
          "Re-anchored curation on a journey track playing outside the model.",
          {
            activeProviderTrackId: state.activeProviderTrackId,
            remainingQueue: remainingQueue.length,
          },
        );
        return "playing";
      }
    }

    if (result.kind === "external") {
      // Heuristic: a foreign track right after our queue drained is Spotify AUTOPLAY taking
      // over, not a deliberate user choice — reclaim with the next unused curated track.
      const lastReclaim = this.reclaimAttemptAt.get(journeyId) ?? 0;
      const cooldownMs = this.config.PLAYBACK_RECLAIM_COOLDOWN_SECONDS * 1000;
      const queueDrained = session.queuedTrackIds.length <= 1;
      if (
        this.config.PLAYBACK_RECLAIM_ENABLED &&
        queueDrained &&
        session.deviceId &&
        Date.now() - lastReclaim > cooldownMs
      ) {
        const consumedIds = new Set<string>([
          ...(session.playedTrackIds ?? []),
          ...session.queuedTrackIds,
          ...(session.activeTrack?.id ? [session.activeTrack.id] : []),
        ]);
        const nextTrack = stored.find(
          (track) =>
            track.providerUri &&
            track.isPlayable !== false &&
            !consumedIds.has(track.id),
        );
        if (nextTrack) {
          this.reclaimAttemptAt.set(journeyId, Date.now());
          const applied = await this.playExact({
            journeyId,
            accessToken,
            deviceId: session.deviceId,
            activeTrack: nextTrack,
            queueTracks: [],
          });
          if (applied.deviceReachable) {
            this.saveSession({
              journeyId,
              provider: "spotify",
              deviceId: session.deviceId,
              status: "playing",
              activeTrack: nextTrack,
              queuedTrackIds: [],
              playedTrackIds: [
                ...(session.playedTrackIds ?? []),
                ...(session.activeTrack?.id ? [session.activeTrack.id] : []),
              ],
              targetBufferSize: 5,
              lastHeartbeatAt: now,
            });
            this.store.audit(
              journeyId,
              "spotify.playback_reclaimed",
              "Reclaimed playback after autoplay took over a drained queue.",
              { activeProviderTrackId: nextTrack.providerTrackId },
            );
            // Refill the now-empty queue in the background.
            void this.analyzeJourney(journeyId, "skip-refill").catch(() => undefined);
            return "playing";
          }
        }
      }
    }

    if (result.kind === "external" || result.kind === "drifted") {
      if (session.status !== "external") {
        this.saveSession({
          ...session,
          status: "external",
          lastHeartbeatAt: now,
        });
        this.store.audit(
          journeyId,
          "spotify.playback_external",
          "External track playing; DJ curation paused.",
          {
            activeProviderTrackId: state.activeProviderTrackId,
          },
        );
      }
      return "external";
    }

    if (result.kind === "empty" || result.kind === "same") {
      // Same curated track still playing (or nothing to reconcile). If we were paused for an external
      // track, this means we're back on a journey track → resume curation.
      if (session.status !== "playing") {
        this.saveSession({
          ...session,
          status: "playing",
          lastHeartbeatAt: now,
        });
      }
      return "playing";
    }

    // result.kind === "skipped": playback advanced `index` tracks into our queue.
    const idx = result.index;
    const newlyPlayed = model.slice(0, idx).map((track) => track.id);
    const newActive = model[idx];
    const newQueue = model.slice(idx + 1);

    this.saveSession({
      journeyId,
      provider: "spotify",
      deviceId: session.deviceId,
      status: "playing",
      activeTrack: newActive,
      queuedTrackIds: newQueue.map((track) => track.id),
      playedTrackIds: [...(session.playedTrackIds ?? []), ...newlyPlayed],
      targetBufferSize: 5,
      lastHeartbeatAt: now,
    });
    this.store.audit(
      journeyId,
      "spotify.playback_reconciled",
      `Reconciled external skip: advanced ${idx} track(s).`,
      {
        advanced: idx,
        activeTrackId: newActive?.providerTrackId,
        remainingQueue: newQueue.length,
      },
    );

    // Refill curated tracks when the buffer runs low — throttled to bound AI/overhead cost.
    if (newQueue.length < this.config.SPOTIFY_REFILL_THRESHOLD) {
      const last = this.store.latestPlaylistUpdate(journeyId);
      const minIntervalMs =
        this.config.SPOTIFY_REFILL_MIN_INTERVAL_SECONDS * 1000;
      if (shouldRegenerate(last?.createdAtIso, Date.now(), minIntervalMs)) {
        try {
          // "skip-refill" is not a vibe-changing reason → analyzeJourney recycles the existing
          // candidate pool (no LLM call) and appends to Spotify's up-next without interrupting.
          await this.analyzeJourney(journeyId, "skip-refill");
        } catch (error) {
          this.logger.warn(
            {
              journeyId,
              err: error instanceof Error ? error.message : String(error),
            },
            "spotify.reconcile_refill_error",
          );
        }
      }
    }

    return "playing";
  }

  /** Lazily creates the private per-journey Spotify playlist; returns its id (or existing/undefined). */
  private async ensureJourneySpotifyPlaylist(
    journey: JourneyRecord,
    accessToken: string,
  ): Promise<string | undefined> {
    if (journey.provider !== "spotify" || !this.spotifyAdapter.createPlaylist) {
      return journey.spotifyPlaylistId;
    }
    if (journey.spotifyPlaylistId) {
      return journey.spotifyPlaylistId;
    }
    const date = journey.createdAtIso.slice(0, 10);
    const playlist = await this.spotifyAdapter.createPlaylist({
      accessToken,
      name: `AI Journey DJ — ${journey.destination} · ${date}`,
      description: `Telemetry-aware soundtrack generated for ${journey.destination}.`,
    });
    this.store.updateJourneySpotifyPlaylist(
      journey.id,
      playlist.id,
      playlist.url,
    );
    this.store.audit(
      journey.id,
      "spotify.playlist_created",
      "Journey playlist created.",
      { playlistId: playlist.id },
    );
    return playlist.id;
  }

  /** Mirrors newly-curated tracks into the journey playlist. Best-effort: never throws. */
  private async syncJourneyPlaylist(
    journey: JourneyRecord,
    accessToken: string,
  ): Promise<void> {
    if (
      journey.provider !== "spotify" ||
      !this.spotifyAdapter.addTracksToPlaylist
    ) {
      return;
    }
    try {
      const pending = this.store
        .listResolvedTracks(journey.id)
        .filter(
          (track) =>
            track.provider === "spotify" &&
            track.addedToPlaylist &&
            !track.savedToPlaylist &&
            track.providerUri,
        );
      if (pending.length === 0) {
        return;
      }
      const playlistId = await this.ensureJourneySpotifyPlaylist(
        journey,
        accessToken,
      );
      if (!playlistId) {
        return;
      }
      const uris = pending.map((track) => track.providerUri as string);
      for (let i = 0; i < uris.length; i += 100) {
        await this.spotifyAdapter.addTracksToPlaylist({
          accessToken,
          playlistId,
          uris: uris.slice(i, i + 100),
        });
      }
      this.store.markTracksSavedToPlaylist(pending.map((track) => track.id));
      this.store.audit(
        journey.id,
        "spotify.playlist_extended",
        `Added ${pending.length} tracks to the journey playlist.`,
        {
          count: pending.length,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { journeyId: journey.id, err: message },
        "spotify.playlist.degraded",
      );
      this.store.audit(
        journey.id,
        "spotify.playlist_error",
        "Could not update the journey playlist; will retry next analysis.",
        {
          error: message,
        },
      );
    }
  }

  private async generateAndStoreCandidates(
    journeyId: string,
    context: Parameters<SongScout["generateCandidates"]>[0],
    targetCount: number,
    policy = buildRecommendationPolicy(context),
  ): Promise<SongCandidate[]> {
    let generated: SongCandidate[];
    const scoutStartedAt = Date.now();
    this.logger.info({ journeyId, targetCount }, "scout.generate.start");
    try {
      generated = await this.songScout.generateCandidates(
        context,
        targetCount,
        policy,
      );
    } catch (error) {
      if (!isRecoverableScoutError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { journeyId, ms: Date.now() - scoutStartedAt, err: message },
        "scout.generate.fallback",
      );
      this.store.audit(
        journeyId,
        "recommendation.scout_failed",
        "Song scout returned unusable output; using deterministic fallback candidates.",
        { error: message },
      );
      generated = fallbackCandidates(context, targetCount);
    }
    this.logger.info(
      {
        journeyId,
        count: generated.length,
        source: generated[0]?.source,
        ms: Date.now() - scoutStartedAt,
      },
      "scout.generate.done",
    );

    return this.enrichAndStoreCandidates(journeyId, generated);
  }

  private async generateAndStoreCandidateSet(
    journeyId: string,
    context: JourneyContext,
    policy: RecommendationPolicy,
    targetCount: number,
    seed = 0,
  ): Promise<SongCandidate[]> {
    const wishCandidates = await this.enrichAndStoreCandidates(
      journeyId,
      candidatesFromMusicWishes(context.activeMusicWishes ?? []),
    );
    const [chartCandidates, aiCandidates] = await Promise.all([
      this.generateAndStoreLastfmCandidates(
        journeyId,
        context,
        policy,
        targetCount + 8,
        seed,
      ),
      this.generateAndStoreCandidates(journeyId, context, targetCount, policy),
    ]);
    const seen = new Set<string>();
    return [...wishCandidates, ...chartCandidates, ...aiCandidates].filter((candidate) => {
      const key = songKey(candidate.artist, candidate.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private filterFreshCandidates(
    candidates: SongCandidate[],
    consumedSongKeys: Set<string>,
  ): SongCandidate[] {
    const seen = new Set(consumedSongKeys);
    return candidates.filter((candidate) => {
      const key = songKey(candidate.artist, candidate.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async generateAndStoreLastfmCandidates(
    journeyId: string,
    context: JourneyContext,
    policy: RecommendationPolicy,
    targetCount: number,
    seed = 0,
  ): Promise<SongCandidate[]> {
    if (!this.lastfmCharts) return [];
    const country = this.countryNameForCharts(context);
    const tags = policy.moodTags.slice(0, policy.familyMode ? 5 : 3);
    const rotation = this.config.LASTFM_CHART_ROTATION_ENABLED;
    const page = rotation ? (seed % this.config.LASTFM_CHART_PAGES) + 1 : 1;
    const window = rotation
      ? this.config.LASTFM_CHART_WINDOW
      : Math.max(targetCount, 30);
    const [geoTracks, tagTracks] = await Promise.all([
      this.lastfmCharts.getGeoTopTracks(country, window, page),
      Promise.all(tags.map((tag) => this.lastfmCharts!.getTagTopTracks(tag, 12, page))),
    ]);
    const pool = [...geoTracks, ...tagTracks.flat()];
    const rotated = rotation ? rotateWindow(pool, seed, pool.length) : pool;
    const candidates = lastfmTracksToCandidates(
      rotated,
      context,
      policy.moodTags,
    ).slice(0, targetCount);
    if (candidates.length === 0) return [];
    this.logger.info(
      { journeyId, country, tags, count: candidates.length },
      "lastfm.candidates.done",
    );
    this.store.audit(
      journeyId,
      "recommendation.lastfm",
      `Loaded ${candidates.length} Last.fm chart/tag candidates.`,
      {
        country,
        tags,
      },
    );
    return this.enrichAndStoreCandidates(journeyId, candidates);
  }

  private countryNameForCharts(context: JourneyContext): string | undefined {
    if (context.countryName) return context.countryName;
    if (
      context.countryCode &&
      COUNTRY_NAME_BY_CODE[context.countryCode.toUpperCase()]
    ) {
      return COUNTRY_NAME_BY_CODE[context.countryCode.toUpperCase()];
    }
    const regionCountry = context.coarseRegion
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1);
    if (regionCountry) return regionCountry;
    return (
      COUNTRY_NAME_BY_CODE[this.config.SPOTIFY_MARKET.toUpperCase()] ??
      COUNTRY_NAME_BY_CODE[this.config.TIDAL_COUNTRY_CODE.toUpperCase()]
    );
  }

  private async enrichAndStoreCandidates(
    journeyId: string,
    generated: SongCandidate[],
  ): Promise<SongCandidate[]> {
    const enrichStartedAt = Date.now();
    const enriched = await Promise.all(
      generated.map((candidate) => this.openMusic.enrichCandidate(candidate)),
    );
    this.logger.info(
      { journeyId, count: enriched.length, ms: Date.now() - enrichStartedAt },
      "scout.enrich.done",
    );
    return enriched.map((candidate) => {
      const id = this.store.saveCandidate(journeyId, candidate);
      return { ...candidate, id };
    });
  }

  private storeResolved(
    journeyId: string,
    candidates: SongCandidate[],
    resolved: ResolvedTrack[],
  ): string[] {
    return resolved.map((track) => {
      const candidate = candidates.find(
        (item) => item.artist === track.artist || item.title === track.title,
      );
      return this.store.saveResolvedTrack(journeyId, candidate?.id, track);
    });
  }

  private async ensureTidalPlaylist(
    journeyId: string,
    destination: string,
  ): Promise<void> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.tidalPlaylistId) {
      return;
    }

    const accessToken = await this.tidalAuth.getAccessToken();
    const playlist = await this.tidalAdapter.createPlaylist({
      accessToken,
      name: `AI Journey DJ - ${destination}`,
      description: `Generated for ${destination}. Updated in 5-track rolling batches.`,
      countryCode: this.config.TIDAL_COUNTRY_CODE,
      idempotencyKey: `playlist-${journeyId}`,
    });

    this.store.updateJourneyPlaylist(
      journeyId,
      playlist.id,
      playlist.url ?? undefined,
    );
    this.store.audit(
      journeyId,
      "tidal.playlist_created",
      "TIDAL playlist created.",
      { playlistId: playlist.id },
    );
  }

  private saveSession(session: PlaybackSession): void {
    this.store.savePlaybackSession({
      ...session,
      targetBufferSize: 5,
    });
  }
}

function isRecoverableScoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }

  if (error.message.startsWith("Prompt contains forbidden data hints")) {
    return false;
  }

  return true;
}
