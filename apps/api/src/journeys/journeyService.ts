import type {
  JourneyContext,
  JourneyPhase,
  JourneyRecord,
  NormalizedTelemetryEvent,
  PlaybackSession,
  PlaylistUpdate,
  ResolvedTrack,
  SongCandidate,
  StreamingProvider,
  TasteProfile
} from "@ai-journey-dj/core";
import { songKey } from "@ai-journey-dj/core";
import { derivePhase } from "@ai-journey-dj/telemetry";
import { reconcilePlaybackModel, shouldRegenerate } from "../playback/reconcile.js";
import { TidalResolver, type TidalAdapter } from "@ai-journey-dj/tidal";
import {
  SpotifyResolver,
  isSpotifyDeviceNotFoundError,
  isSpotifyRateLimitError,
  queueTracksForBuffer,
  type SpotifyAdapter,
  type SpotifyDevice
} from "@ai-journey-dj/spotify";
import type { OpenMusicClient, NoopOpenMusicClient } from "@ai-journey-dj/open-music";
import type { SongScout } from "@ai-journey-dj/recommendation";
import { deriveTasteProfile, fallbackCandidates, selectRollingBatch } from "@ai-journey-dj/recommendation";

/** Default familiarity↔discovery mix for a new drive — between "light" and "balanced". */
export const DEFAULT_TASTE_WEIGHT = 0.4;
/** Hard cap on the top-artists fetch so taste loading can never block a journey. */
const TASTE_FETCH_TIMEOUT_MS = 8_000;

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
  error() {}
};

export class JourneyService {
  /** One in-flight analyze per journey; global chain avoids Spotify 429 dogpiles. */
  private readonly analyzeByJourney = new Map<string, Promise<PlaylistUpdate>>();
  private analyzeGlobalChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly tidalAuth: TidalAuthService,
    private readonly tidalAdapter: TidalAdapter,
    private readonly spotifyAuth: SpotifyAuthService,
    private readonly spotifyAdapter: SpotifyAdapter,
    private readonly songScout: SongScout,
    private readonly openMusic: OpenMusicClient | NoopOpenMusicClient,
    private readonly logger: JourneyLogger = noopLogger
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
      createdAtIso
    };

    this.store.createJourney(journey);
    this.store.audit(id, "journey.created", "Journey started.", { destination: input.destination, provider });

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
        lastHeartbeatAt: new Date().toISOString()
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
      this.store.saveTelemetry(journey.id, event, phase);
      if (phase !== journey.phase) {
        this.store.updateJourneyPhase(journey.id, phase);
        this.store.audit(journey.id, "telemetry.phase_changed", `Journey phase changed to ${phase}.`);
        await this.analyzeJourney(journey.id, "phase-change");
      }
    }
  }

  async analyzeJourney(journeyId: string, reason = "manual"): Promise<PlaylistUpdate> {
    const inFlight = this.analyzeByJourney.get(journeyId);
    if (inFlight) {
      return inFlight;
    }

    const run = this.analyzeGlobalChain
      .catch(() => undefined)
      .then(() => this.analyzeJourneyBody(journeyId, reason));
    this.analyzeGlobalChain = run.then(
      () => undefined,
      () => undefined
    );

    const tracked = run.finally(() => {
      if (this.analyzeByJourney.get(journeyId) === tracked) {
        this.analyzeByJourney.delete(journeyId);
      }
    });
    this.analyzeByJourney.set(journeyId, tracked);
    return tracked;
  }

  private async analyzeJourneyBody(journeyId: string, reason: string): Promise<PlaylistUpdate> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot analyze a stopped journey.");
    }

    const startedAt = Date.now();
    this.logger.info({ journeyId, reason, provider: journey.provider }, "journey.analyze.start");
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
        { journeyId, reason, status: update.status, batchSize: update.batchSize, trackCount, ms: Date.now() - startedAt },
        "journey.analyze.done"
      );
      return update;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ journeyId, reason, ms: Date.now() - startedAt, err: message }, "journey.analyze.failed");
      this.store.audit(journeyId, "analysis.failed", message, { reason });
      throw error;
    }
  }

  async setPhase(journeyId: string, phase: JourneyPhase): Promise<JourneyRecord> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot change the phase of a stopped journey.");
    }
    this.store.updateJourneyPhase(journeyId, phase);
    this.store.audit(journeyId, "phase.manual_override", `Drive phase manually set to ${phase}.`, { phase });
    await this.analyzeJourney(journeyId, "phase-override");
    return this.getJourneyOrThrow(journeyId);
  }

  /** Sets the familiarity↔discovery mix (0..1) and re-curates the queue around it. */
  async setTasteWeight(journeyId: string, weight: number): Promise<JourneyRecord> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot change the taste mix of a stopped journey.");
    }
    const clamped = Math.max(0, Math.min(1, weight));
    this.store.updateJourneyTasteWeight(journeyId, clamped);
    this.store.audit(journeyId, "taste.weight_set", `Vibe mix set to ${Math.round(clamped * 100)}% familiar.`, {
      tasteWeight: clamped
    });
    await this.analyzeJourney(journeyId, "taste-override");
    return this.getJourneyOrThrow(journeyId);
  }

  /**
   * Loads the listener's taste profile (top artists → favored genres) for personalization.
   * Cached ~24h so the Spotify API is touched at most once/day; any failure degrades to no taste.
   */
  private async loadTasteProfile(accessToken: string): Promise<TasteProfile | undefined> {
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
        signal: AbortSignal.timeout(TASTE_FETCH_TIMEOUT_MS)
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
    options: { syncOnly?: boolean } = {}
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
      lastHeartbeatAt: new Date().toISOString()
    });
    this.store.audit(journeyId, "spotify.device_ready", "Spotify Web Playback device registered.", { deviceId, status });

    const hasTracks = this.store.listResolvedTracks(journeyId).some((track) => track.provider === "spotify");
    if (options.syncOnly && hasTracks) {
      return this.syncExistingSpotifyPlayback(journeyId, deviceId);
    }

    await this.analyzeJourney(journeyId, "device-ready");
    return this.store.getPlaybackSession(journeyId) as PlaybackSession;
  }

  async syncExistingSpotifyPlayback(journeyId: string, deviceId: string): Promise<PlaybackSession> {
    const accessToken = await this.spotifyAuth.getAccessToken();
    const stored = this.store.listResolvedTracks(journeyId).filter((track) => track.provider === "spotify");
    const session = this.store.getPlaybackSession(journeyId);
    const { activeTrack, queueTracks, queuedTrackIds } = this.pickSpotifyPlaybackTracks(stored, session);

    const playbackApplied = await this.syncSpotifyPlayback({
      journeyId,
      accessToken,
      deviceId,
      activeTrack,
      queueTracks,
      shouldStart: true
    });

    const playedActiveTrack = playbackApplied.deviceReachable ? activeTrack : (session?.activeTrack ?? activeTrack);
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
      lastHeartbeatAt: new Date().toISOString()
    });

    if (playbackApplied.rateLimited) {
      this.store.audit(
        journeyId,
        "spotify.rate_limited",
        "Spotify rate limit hit while syncing playback; try Play audio again in a few seconds.",
        { deviceId }
      );
    }

    return this.store.getPlaybackSession(journeyId) as PlaybackSession;
  }

  async skipSpotifyTrack(
    journeyId: string,
    direction: "next" | "previous",
    deviceId?: string
  ): Promise<PlaybackSession> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.provider !== "spotify") {
      throw new Error("Track skip is only supported for Spotify journeys.");
    }
    if (journey.status !== "active") {
      throw new Error("Cannot skip tracks on a stopped journey.");
    }

    const session = this.store.getPlaybackSession(journeyId);
    const stored = this.store.listResolvedTracks(journeyId).filter((track) => track.provider === "spotify");
    const playedIds = session?.playedTrackIds ?? [];
    const { activeTrack, queueTracks } = this.pickSpotifyPlaybackTracks(stored, session);
    const effectiveDeviceId = deviceId ?? journey.spotifyDeviceId ?? session?.deviceId;
    const accessToken = await this.spotifyAuth.getAccessToken();

    if (direction === "next") {
      if (queueTracks.length === 0) {
        await this.analyzeJourney(journeyId, "skip-next");
        const refreshed = this.store.getPlaybackSession(journeyId);
        const refreshedStored = this.store.listResolvedTracks(journeyId).filter((track) => track.provider === "spotify");
        const picked = this.pickSpotifyPlaybackTracks(refreshedStored, refreshed);
        if (effectiveDeviceId && picked.activeTrack) {
          const resolvedDeviceId = await this.spotifyAdapter.resolvePlaybackDeviceId({
            accessToken,
            preferredDeviceId: effectiveDeviceId
          });
          await this.syncSpotifyPlayback({
            journeyId,
            accessToken,
            deviceId: resolvedDeviceId,
            activeTrack: picked.activeTrack,
            queueTracks: picked.queueTracks,
            shouldStart: true
          });
        }
        return this.store.getPlaybackSession(journeyId) as PlaybackSession;
      }

      const newActive = queueTracks[0];
      const newQueue = queueTracks.slice(1);
      const newPlayed = activeTrack?.id ? [...playedIds, activeTrack.id] : playedIds;

      if (effectiveDeviceId && newActive) {
        // Single source of truth: command Spotify to play THIS exact track and reset its context to
        // our queue, so the SDK can't drift onto its own stale queue. (The SDK only skips relatively,
        // which walks Spotify's own queue — that is what made played ≠ shown.)
        const applied = await this.playExact({
          journeyId,
          accessToken,
          deviceId: effectiveDeviceId,
          activeTrack: newActive,
          queueTracks: newQueue
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
        lastHeartbeatAt: new Date().toISOString()
      });

      if (newQueue.length < 4) {
        void this.analyzeJourney(journeyId, "low-buffer").catch(() => undefined);
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
      const newQueueIds = [activeTrack?.id, ...queueTracks.map((track) => track.id)].filter(
        (id): id is string => Boolean(id)
      );
      const newQueueTracks = newQueueIds
        .map((id) => stored.find((track) => track.id === id))
        .filter((track): track is ResolvedTrack & { id: string; addedToPlaylist: boolean; savedToPlaylist: boolean } => Boolean(track));

      if (effectiveDeviceId) {
        // Single source of truth: play the exact previous track and reset Spotify's context to our
        // queue, so playback matches the web app instead of Spotify's own drifting queue.
        const applied = await this.playExact({
          journeyId,
          accessToken,
          deviceId: effectiveDeviceId,
          activeTrack: newActive,
          queueTracks: newQueueTracks
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
        lastHeartbeatAt: new Date().toISOString()
      });
    }

    this.store.audit(journeyId, "spotify.skip", `Skipped ${direction} track.`, { direction });
    return this.store.getPlaybackSession(journeyId) as PlaybackSession;
  }

  async listSpotifyDevices(): Promise<SpotifyDevice[]> {
    if (!this.spotifyAdapter.listDevices) return [];
    try {
      const accessToken = await this.spotifyAuth.getAccessToken();
      return await this.spotifyAdapter.listDevices({ accessToken });
    } catch (error) {
      this.logger.warn({ err: error instanceof Error ? error.message : String(error) }, "spotify.devices.failed");
      return [];
    }
  }

  async setSpotifyTransport(
    journeyId: string,
    action: "pause" | "resume",
    deviceId?: string
  ): Promise<PlaybackSession> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.provider !== "spotify") {
      throw new Error("Transport control is only supported for Spotify journeys.");
    }
    const session = this.store.getPlaybackSession(journeyId);
    const effectiveDeviceId = deviceId ?? journey.spotifyDeviceId ?? session?.deviceId;
    if (effectiveDeviceId) {
      try {
        const accessToken = await this.spotifyAuth.getAccessToken();
        const resolved = await this.spotifyAdapter.resolvePlaybackDeviceId({
          accessToken,
          preferredDeviceId: effectiveDeviceId
        });
        if (action === "pause") {
          await this.spotifyAdapter.pausePlayback?.({ accessToken, deviceId: resolved });
        } else {
          await this.spotifyAdapter.resumePlayback?.({ accessToken, deviceId: resolved });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn({ journeyId, action, err: message }, "spotify.transport.degraded");
        this.store.audit(journeyId, "spotify.playback_error", `Spotify ${action} command failed.`, { error: message });
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
      lastHeartbeatAt: new Date().toISOString()
    });
    this.store.audit(journeyId, "tidal.fallback_enabled", "Journey switched to TIDAL fallback mode.");
    await this.analyzeJourney(journeyId, "tidal-fallback");
    return this.getJourneyOrThrow(journeyId);
  }

  private async analyzeTidalJourney(journey: JourneyRecord, reason: string): Promise<PlaylistUpdate> {
    const journeyId = journey.id;
    const telemetry = this.store.latestTelemetry(journeyId);
    const context = contextFromJourney(journey, telemetry, this.store.recentTelemetry(journeyId));
    const candidates = await this.generateAndStoreCandidates(journeyId, context, 12);
    const accessToken = await this.tidalAuth.getAccessToken();
    const resolver = new TidalResolver(this.tidalAdapter, {
      accessToken,
      countryCode: this.config.TIDAL_COUNTRY_CODE
    });
    const resolved = await resolver.resolveCandidates(candidates);
    const resolvedIds = this.storeResolved(journeyId, candidates, resolved);
    const stored = this.store.listResolvedTracks(journeyId).filter((track) => track.provider === "tidal");
    const alreadyAdded = new Set(stored.filter((track) => track.addedToPlaylist).map((track) => track.providerTrackId));
    let selected = selectRollingBatch(stored, alreadyAdded, 5);

    if (selected.length < 5) {
      this.store.audit(journeyId, "recommendation.fallback", "Initial analysis resolved fewer than 5 tracks; running fallback.");
      const fallbackCandidates = await this.generateAndStoreCandidates(journeyId, context, 8);
      const fallbackResolved = await resolver.resolveCandidates(fallbackCandidates);
      this.storeResolved(journeyId, fallbackCandidates, fallbackResolved);
      selected = selectRollingBatch(this.store.listResolvedTracks(journeyId).filter((track) => track.provider === "tidal"), alreadyAdded, 5);
    }

    const status = selected.length === 5 ? "success" : selected.length > 0 ? "degraded" : "failed";
    const update: PlaylistUpdate = {
      id: crypto.randomUUID(),
      journeyId,
      provider: "tidal",
      batchSize: selected.length,
      candidateIds: candidates.map((candidate) => candidate.id).filter(Boolean) as string[],
      resolvedTrackIds: selected.map((track) => track.id),
      idempotencyKey: `journey-${journeyId}-${Date.now()}`,
      status,
      createdAtIso: new Date().toISOString()
    };

    if (selected.length > 0 && journey.tidalPlaylistId) {
      await this.tidalAdapter.addTracks({
        accessToken,
        playlistId: journey.tidalPlaylistId,
        trackIds: selected.map((track) => track.providerTrackId),
        countryCode: this.config.TIDAL_COUNTRY_CODE,
        idempotencyKey: update.idempotencyKey
      });
      this.store.markTracksAdded(selected.map((track) => track.id));
    }

    this.store.savePlaylistUpdate(update);
    this.store.audit(journeyId, "playlist.updated", `Playlist update ${status}: ${selected.length} tracks added.`, {
      reason,
      trackIds: selected.map((track) => track.providerTrackId),
      resolvedIds
    });
    return update;
  }

  private async analyzeSpotifyJourney(journey: JourneyRecord, reason: string): Promise<PlaylistUpdate> {
    const journeyId = journey.id;
    const telemetry = this.store.latestTelemetry(journeyId);
    const context = contextFromJourney(journey, telemetry, this.store.recentTelemetry(journeyId));

    // Cost control: only the LLM lenses cost tokens. Run them when the vibe actually changes;
    // for routine top-ups, reuse the already-generated candidate pool if it can refill the buffer.
    const vibeChangingReasons = new Set([
      "initial",
      "phase-change",
      "phase-override",
      "taste-override",
      "manual",
      "recovery"
    ]);
    const priorSession = this.store.getPlaybackSession(journeyId);
    const storedForGate = this.store.listResolvedTracks(journeyId).filter((track) => track.provider === "spotify");

    // "Consumed" = every track already surfaced this journey (active, queued, played, or ever added
    // to the buffer). Selection and generation must never resurface these — neither the exact
    // recording (provider id) nor another version of the same song (song key).
    const consumedTrackIds = new Set<string>();
    for (const id of priorSession?.queuedTrackIds ?? []) consumedTrackIds.add(id);
    for (const id of priorSession?.playedTrackIds ?? []) consumedTrackIds.add(id);
    if (priorSession?.activeTrack?.id) consumedTrackIds.add(priorSession.activeTrack.id);
    for (const track of storedForGate) {
      if (track.addedToPlaylist) consumedTrackIds.add(track.id);
    }
    const consumedTracks = storedForGate.filter((track) => consumedTrackIds.has(track.id));
    const consumedProviderIds = new Set(consumedTracks.map((track) => track.providerTrackId));
    const consumedSongKeys = new Set(consumedTracks.map((track) => songKey(track.artist, track.title)));

    const unusedPool = storedForGate.filter(
      (track) =>
        track.providerUri &&
        track.isPlayable !== false &&
        !consumedTrackIds.has(track.id) &&
        !consumedSongKeys.has(songKey(track.artist, track.title))
    );
    const neededNow = Math.max(0, 5 - (priorSession?.queuedTrackIds?.length ?? 0));
    const mustGenerate = vibeChangingReasons.has(reason) || unusedPool.length < neededNow;

    const tokenStartedAt = Date.now();
    const accessToken = await this.spotifyAuth.getAccessToken();
    this.logger.info({ journeyId, ms: Date.now() - tokenStartedAt }, "spotify.token.done");

    // Personalize the brief with the listener's taste (cached ~24h). Built once and reused for any
    // fallback regeneration below so the whole drive shares one taste signal.
    let scoutContext: JourneyContext = context;
    let candidates: SongCandidate[] = [];
    if (mustGenerate) {
      const tasteProfile = await this.loadTasteProfile(accessToken);
      scoutContext = {
        ...context,
        tasteProfile,
        tasteWeight: journey.tasteWeight ?? DEFAULT_TASTE_WEIGHT
      };
      candidates = (await this.generateAndStoreCandidates(journeyId, scoutContext, 8)).filter(
        (candidate) => !consumedSongKeys.has(songKey(candidate.artist, candidate.title))
      );
    } else {
      this.logger.info({ journeyId, reason, poolSize: unusedPool.length, needed: neededNow }, "scout.pool_reuse");
      this.store.audit(
        journeyId,
        "recommendation.pool_reuse",
        `Reused ${unusedPool.length} already-generated candidates; skipped AI generation.`,
        { reason }
      );
    }
    const resolver = new SpotifyResolver(this.spotifyAdapter, {
      accessToken,
      market: this.config.SPOTIFY_MARKET,
      searchTimeoutMs: 8_000,
      targetResolveCount: 5,
      // Persistent cache: each song is searched on Spotify at most once across the whole drive.
      cache: {
        get: (key) => this.store.getCachedSpotifySearch(key),
        set: (key, value) => this.store.saveCachedSpotifySearch(key, value)
      }
    });
    const resolveStartedAt = Date.now();
    const resolved = await resolver.resolveCandidates(candidates);
    this.logger.info(
      { journeyId, candidates: candidates.length, resolved: resolved.length, ms: Date.now() - resolveStartedAt },
      "spotify.resolve.done"
    );
    const resolvedIds = this.storeResolved(journeyId, candidates, resolved);

    let stored = this.store.listResolvedTracks(journeyId).filter((track) => track.provider === "spotify");
    let session = this.store.getPlaybackSession(journeyId);
    let activeTrack =
      session?.activeTrack && session.activeTrack.provider === "spotify"
        ? stored.find((track) => track.id === session?.activeTrack?.id)
        : undefined;

    if (!activeTrack) {
      activeTrack = stored.find((track) => track.providerUri && track.isPlayable !== false);
    }

    const currentQueued = (session?.queuedTrackIds ?? [])
      .map((id) => stored.find((track) => track.id === id))
      .filter((track): track is ResolvedTrack & { id: string; addedToPlaylist: boolean; savedToPlaylist: boolean } => Boolean(track));
    const needed = Math.max(0, 5 - currentQueued.length);
    const selected = queueTracksForBuffer(stored, {
      activeProviderTrackId: activeTrack?.providerTrackId,
      alreadyQueuedProviderIds: new Set(currentQueued.map((track) => track.providerTrackId)),
      excludeProviderTrackIds: consumedProviderIds,
      excludeSongKeys: consumedSongKeys,
      targetBufferSize: needed
    });

    if (currentQueued.length + selected.length < 5) {
      this.store.audit(journeyId, "recommendation.fallback", "Spotify analysis resolved fewer than 5 future tracks; running fallback.");
      const fallbackCandidates = (await this.generateAndStoreCandidates(journeyId, scoutContext, 8)).filter(
        (candidate) => !consumedSongKeys.has(songKey(candidate.artist, candidate.title))
      );
      const fallbackResolved = await resolver.resolveCandidates(fallbackCandidates);
      this.storeResolved(journeyId, fallbackCandidates, fallbackResolved);
      stored = this.store.listResolvedTracks(journeyId).filter((track) => track.provider === "spotify");
      const alreadyQueued = new Set([
        ...currentQueued.map((track) => track.providerTrackId),
        ...selected.map((track) => track.providerTrackId)
      ]);
      const additional = queueTracksForBuffer(stored, {
        activeProviderTrackId: activeTrack?.providerTrackId,
        alreadyQueuedProviderIds: alreadyQueued,
        excludeProviderTrackIds: consumedProviderIds,
        excludeSongKeys: consumedSongKeys,
        targetBufferSize: Math.max(0, 5 - currentQueued.length - selected.length)
      });
      for (const track of additional) {
        if (!selected.some((item) => item.providerTrackId === track.providerTrackId)) {
          selected.push(track);
        }
        if (currentQueued.length + selected.length >= 5) {
          break;
        }
      }
    }

    session = this.store.getPlaybackSession(journeyId);
    const deviceId = journey.spotifyDeviceId ?? session?.deviceId;
    const playbackApplied = deviceId
      ? await this.syncSpotifyPlayback({
          journeyId,
          accessToken,
          deviceId,
          activeTrack,
          queueTracks: selected,
          shouldStart: Boolean(
            activeTrack?.providerUri && (!session?.activeTrack || session.status !== "playing")
          )
        })
      : { deviceReachable: false };

    const playedActiveTrack = playbackApplied.deviceReachable ? activeTrack : (session?.activeTrack ?? activeTrack);
    const queuedTracks = [...currentQueued, ...selected].slice(0, 5);
    const status =
      queuedTracks.length === 5 && playbackApplied.deviceReachable && !playbackApplied.rateLimited
        ? "success"
        : queuedTracks.length > 0
          ? "degraded"
          : "failed";
    const update: PlaylistUpdate = {
      id: crypto.randomUUID(),
      journeyId,
      provider: "spotify",
      batchSize: selected.length,
      candidateIds: candidates.map((candidate) => candidate.id).filter(Boolean) as string[],
      resolvedTrackIds: queuedTracks.map((track) => track.id),
      idempotencyKey: `journey-${journeyId}-${Date.now()}`,
      status,
      createdAtIso: new Date().toISOString()
    };

    this.store.markTracksAdded([activeTrack?.id, ...queuedTracks.map((track) => track.id)].filter(Boolean) as string[]);
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
      lastHeartbeatAt: new Date().toISOString()
    });
    this.store.audit(journeyId, "spotify.queue_updated", `Spotify queue update ${status}: ${queuedTracks.length}/5 future tracks.`, {
      reason,
      activeTrackId: activeTrack?.providerTrackId,
      queuedTrackIds: queuedTracks.map((track) => track.providerTrackId),
      resolvedIds
    });
    // Mirror the curated set into the saved journey playlist (best-effort; never blocks the journey).
    await this.syncJourneyPlaylist(journey, accessToken);
    return update;
  }

  private pickSpotifyPlaybackTracks(
    stored: Array<ResolvedTrack & { id: string; addedToPlaylist: boolean; savedToPlaylist: boolean }>,
    session?: PlaybackSession
  ): {
    activeTrack?: ResolvedTrack & { id: string; addedToPlaylist: boolean; savedToPlaylist: boolean };
    queueTracks: Array<ResolvedTrack & { id: string; addedToPlaylist: boolean; savedToPlaylist: boolean }>;
    queuedTrackIds: string[];
  } {
    const queued = (session?.queuedTrackIds ?? [])
      .map((id) => stored.find((track) => track.id === id))
      .filter((track): track is ResolvedTrack & { id: string; addedToPlaylist: boolean; savedToPlaylist: boolean } => Boolean(track));

    if (session?.activeTrack) {
      const active = stored.find((track) => track.id === session.activeTrack?.id);
      if (active) {
        const queueTracks = queued.filter((track) => track.id !== active.id);
        return {
          activeTrack: active,
          queueTracks,
          queuedTrackIds: [active.id, ...queueTracks.map((track) => track.id)].slice(0, 5)
        };
      }
    }

    if (queued.length > 0) {
      const [head, ...tail] = queued;
      return {
        activeTrack: head,
        queueTracks: tail,
        queuedTrackIds: queued.map((track) => track.id).slice(0, 5)
      };
    }

    const fallback = stored.find((track) => track.providerUri && track.isPlayable !== false);
    return {
      activeTrack: fallback,
      queueTracks: [],
      queuedTrackIds: fallback ? [fallback.id] : []
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
    const uris = [
      ...(args.activeTrack?.providerUri ? [args.activeTrack.providerUri] : []),
      ...args.queueTracks.map((track) => track.providerUri).filter((uri): uri is string => Boolean(uri))
    ];
    const uniqueUris = [...new Set(uris)];
    if (uniqueUris.length === 0) {
      return { deviceReachable: false };
    }

    const deviceId = await this.spotifyAdapter.resolvePlaybackDeviceId({
      accessToken: args.accessToken,
      preferredDeviceId: args.deviceId
    });

    try {
      await this.spotifyAdapter.startPlayback({ accessToken: args.accessToken, deviceId, uris: uniqueUris });
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
          createdAtIso: new Date().toISOString()
        });
      }
      return { deviceReachable: true };
    } catch (error) {
      // Device not active yet (e.g. Webplayer just (re)connected): fall back to transfer + start.
      if (isSpotifyDeviceNotFoundError(error)) {
        return this.syncSpotifyPlayback({
          journeyId: args.journeyId,
          accessToken: args.accessToken,
          deviceId,
          activeTrack: args.activeTrack,
          queueTracks: args.queueTracks,
          shouldStart: true
        });
      }
      if (isSpotifyRateLimitError(error)) {
        return { deviceReachable: true, rateLimited: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ journeyId: args.journeyId, deviceId, err: message }, "spotify.play.degraded");
      this.store.audit(args.journeyId, "spotify.playback_error", "Spotify play failed; queue saved, playback degraded.", {
        deviceId,
        error: message
      });
      return { deviceReachable: false };
    }
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
      preferredDeviceId: args.deviceId
    });

    let transferFailed = false;
    try {
      await this.spotifyAdapter.transferPlayback({
        accessToken: args.accessToken,
        deviceId
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
    } catch (error) {
      if (isSpotifyDeviceNotFoundError(error)) {
        transferFailed = true;
        this.store.audit(args.journeyId, "spotify.device_missing", "Spotify Webplayer not active yet; will retry play.", {
          deviceId
        });
      } else if (isSpotifyRateLimitError(error)) {
        return { deviceReachable: true, rateLimited: true };
      } else {
        // Playback is best-effort: a transient Spotify error (e.g. 500) must not fail the
        // journey. The queue is already saved; degrade and let the user retry playback.
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn({ journeyId: args.journeyId, deviceId, err: message }, "spotify.transfer.degraded");
        this.store.audit(args.journeyId, "spotify.playback_error", "Spotify transfer failed; queue saved, playback degraded.", {
          deviceId,
          error: message
        });
        return { deviceReachable: false };
      }
    }

    const playUris = [
      ...(args.shouldStart && args.activeTrack?.providerUri ? [args.activeTrack.providerUri] : []),
      ...args.queueTracks.map((track) => track.providerUri).filter((uri): uri is string => Boolean(uri))
    ];
    const uniquePlayUris = [...new Set(playUris)];

    if (args.shouldStart && uniquePlayUris.length > 0) {
      try {
        await this.spotifyAdapter.startPlayback({
          accessToken: args.accessToken,
          deviceId,
          uris: uniquePlayUris
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
            createdAtIso: new Date().toISOString()
          });
        }
        return { deviceReachable: true };
      } catch (error) {
        if (isSpotifyDeviceNotFoundError(error)) {
          return { deviceReachable: false };
        }
        if (isSpotifyRateLimitError(error)) {
          return { deviceReachable: true, rateLimited: true };
        }
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn({ journeyId: args.journeyId, deviceId, err: message }, "spotify.start.degraded");
        this.store.audit(args.journeyId, "spotify.playback_error", "Spotify start playback failed; queue saved, playback degraded.", {
          deviceId,
          error: message
        });
        return { deviceReachable: false };
      }
    }

    let rateLimited = false;
    for (const track of args.queueTracks) {
      if (!track.providerUri) continue;
      try {
        await this.spotifyAdapter.addToQueue({
          accessToken: args.accessToken,
          deviceId,
          uri: track.providerUri
        });
        this.store.saveQueueOperation({
          id: crypto.randomUUID(),
          journeyId: args.journeyId,
          provider: "spotify",
          providerTrackId: track.providerTrackId,
          providerUri: track.providerUri,
          operation: "queue",
          status: "success",
          deviceId,
          createdAtIso: new Date().toISOString()
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
      } catch (error) {
        if (isSpotifyDeviceNotFoundError(error)) {
          return { deviceReachable: false };
        }
        if (isSpotifyRateLimitError(error)) {
          rateLimited = true;
          break;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn({ journeyId: args.journeyId, deviceId, err: message }, "spotify.queue.degraded");
        this.store.audit(args.journeyId, "spotify.playback_error", "Spotify queue add failed; remaining tracks saved, playback degraded.", {
          deviceId,
          error: message
        });
        return { deviceReachable: false };
      }
    }

    if (transferFailed) {
      return { deviceReachable: false };
    }
    return { deviceReachable: true, rateLimited: rateLimited || undefined };
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
      const unresolvedBuffer = journey.provider === "spotify"
        ? session?.queuedTrackIds.length ?? 0
        : this.store.listResolvedTracks(journey.id).filter((track) => track.provider === "tidal" && !track.addedToPlaylist).length;
      if (ageMs > this.config.journeyRefreshMs || unresolvedBuffer < 5) {
        await this.analyzeJourney(journey.id, ageMs > this.config.journeyRefreshMs ? "time-window" : "low-buffer");
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
  async reconcileSpotifyPlayback(journeyId: string): Promise<"playing" | "idle" | "external"> {
    const journey = this.store.getJourney(journeyId);
    if (!journey || journey.provider !== "spotify" || journey.status !== "active") {
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
      state = await this.spotifyAdapter.getPlaybackState({ accessToken, market: this.config.SPOTIFY_MARKET });
    } catch (error) {
      this.logger.warn(
        { journeyId, err: error instanceof Error ? error.message : String(error) },
        "spotify.reconcile_error"
      );
      return "idle";
    }

    const now = new Date().toISOString();

    // Nothing playing → leave the model untouched, just back the poller off.
    if (!state.isPlaying || !state.activeProviderTrackId) {
      return "idle";
    }

    const stored = this.store.listResolvedTracks(journeyId).filter((track) => track.provider === "spotify");
    const { activeTrack, queueTracks } = this.pickSpotifyPlaybackTracks(stored, session);
    const model = [activeTrack, ...queueTracks].filter(
      (track): track is ResolvedTrack & { id: string; addedToPlaylist: boolean; savedToPlaylist: boolean } =>
        Boolean(track)
    );
    const result = reconcilePlaybackModel(
      model.map((track) => track.providerTrackId),
      state.activeProviderTrackId
    );

    if (result.kind === "external") {
      if (session.status !== "external") {
        this.saveSession({ ...session, status: "external", lastHeartbeatAt: now });
        this.store.audit(journeyId, "spotify.playback_external", "External track playing; DJ curation paused.", {
          activeProviderTrackId: state.activeProviderTrackId
        });
      }
      return "external";
    }

    if (result.kind === "empty" || result.kind === "same") {
      // Same curated track still playing (or nothing to reconcile). If we were paused for an external
      // track, this means we're back on a journey track → resume curation.
      if (session.status !== "playing") {
        this.saveSession({ ...session, status: "playing", lastHeartbeatAt: now });
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
      lastHeartbeatAt: now
    });
    this.store.audit(journeyId, "spotify.playback_reconciled", `Reconciled external skip: advanced ${idx} track(s).`, {
      advanced: idx,
      activeTrackId: newActive?.providerTrackId,
      remainingQueue: newQueue.length
    });

    // Refill curated tracks when the buffer runs low — throttled to bound AI/overhead cost.
    if (newQueue.length < this.config.SPOTIFY_REFILL_THRESHOLD) {
      const last = this.store.latestPlaylistUpdate(journeyId);
      const minIntervalMs = this.config.SPOTIFY_REFILL_MIN_INTERVAL_SECONDS * 1000;
      if (shouldRegenerate(last?.createdAtIso, Date.now(), minIntervalMs)) {
        try {
          // "skip-refill" is not a vibe-changing reason → analyzeJourney recycles the existing
          // candidate pool (no LLM call) and appends to Spotify's up-next without interrupting.
          await this.analyzeJourney(journeyId, "skip-refill");
        } catch (error) {
          this.logger.warn(
            { journeyId, err: error instanceof Error ? error.message : String(error) },
            "spotify.reconcile_refill_error"
          );
        }
      }
    }

    return "playing";
  }

  /** Lazily creates the private per-journey Spotify playlist; returns its id (or existing/undefined). */
  private async ensureJourneySpotifyPlaylist(journey: JourneyRecord, accessToken: string): Promise<string | undefined> {
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
      description: `Telemetry-aware soundtrack generated for ${journey.destination}.`
    });
    this.store.updateJourneySpotifyPlaylist(journey.id, playlist.id, playlist.url);
    this.store.audit(journey.id, "spotify.playlist_created", "Journey playlist created.", { playlistId: playlist.id });
    return playlist.id;
  }

  /** Mirrors newly-curated tracks into the journey playlist. Best-effort: never throws. */
  private async syncJourneyPlaylist(journey: JourneyRecord, accessToken: string): Promise<void> {
    if (journey.provider !== "spotify" || !this.spotifyAdapter.addTracksToPlaylist) {
      return;
    }
    try {
      const pending = this.store
        .listResolvedTracks(journey.id)
        .filter(
          (track) => track.provider === "spotify" && track.addedToPlaylist && !track.savedToPlaylist && track.providerUri
        );
      if (pending.length === 0) {
        return;
      }
      const playlistId = await this.ensureJourneySpotifyPlaylist(journey, accessToken);
      if (!playlistId) {
        return;
      }
      const uris = pending.map((track) => track.providerUri as string);
      for (let i = 0; i < uris.length; i += 100) {
        await this.spotifyAdapter.addTracksToPlaylist({ accessToken, playlistId, uris: uris.slice(i, i + 100) });
      }
      this.store.markTracksSavedToPlaylist(pending.map((track) => track.id));
      this.store.audit(journey.id, "spotify.playlist_extended", `Added ${pending.length} tracks to the journey playlist.`, {
        count: pending.length
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ journeyId: journey.id, err: message }, "spotify.playlist.degraded");
      this.store.audit(journey.id, "spotify.playlist_error", "Could not update the journey playlist; will retry next analysis.", {
        error: message
      });
    }
  }

  private async generateAndStoreCandidates(
    journeyId: string,
    context: Parameters<SongScout["generateCandidates"]>[0],
    targetCount: number
  ): Promise<SongCandidate[]> {
    let generated: SongCandidate[];
    const scoutStartedAt = Date.now();
    this.logger.info({ journeyId, targetCount }, "scout.generate.start");
    try {
      generated = await this.songScout.generateCandidates(context, targetCount);
    } catch (error) {
      if (!isRecoverableScoutError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { journeyId, ms: Date.now() - scoutStartedAt, err: message },
        "scout.generate.fallback"
      );
      this.store.audit(
        journeyId,
        "recommendation.scout_failed",
        "Song scout returned unusable output; using deterministic fallback candidates.",
        { error: message }
      );
      generated = fallbackCandidates(context, targetCount);
    }
    this.logger.info(
      { journeyId, count: generated.length, source: generated[0]?.source, ms: Date.now() - scoutStartedAt },
      "scout.generate.done"
    );

    const enrichStartedAt = Date.now();
    const enriched = await Promise.all(generated.map((candidate) => this.openMusic.enrichCandidate(candidate)));
    this.logger.info({ journeyId, count: enriched.length, ms: Date.now() - enrichStartedAt }, "scout.enrich.done");
    return enriched.map((candidate) => {
      const id = this.store.saveCandidate(journeyId, candidate);
      return { ...candidate, id };
    });
  }

  private storeResolved(journeyId: string, candidates: SongCandidate[], resolved: ResolvedTrack[]): string[] {
    return resolved.map((track) => {
      const candidate = candidates.find((item) => item.artist === track.artist || item.title === track.title);
      return this.store.saveResolvedTrack(journeyId, candidate?.id, track);
    });
  }

  private async ensureTidalPlaylist(journeyId: string, destination: string): Promise<void> {
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
      idempotencyKey: `playlist-${journeyId}`
    });

    this.store.updateJourneyPlaylist(journeyId, playlist.id, playlist.url ?? undefined);
    this.store.audit(journeyId, "tidal.playlist_created", "TIDAL playlist created.", { playlistId: playlist.id });
  }

  private saveSession(session: PlaybackSession): void {
    this.store.savePlaybackSession({
      ...session,
      targetBufferSize: 5
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
