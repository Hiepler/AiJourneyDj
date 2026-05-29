import type {
  JourneyRecord,
  NormalizedTelemetryEvent,
  PlaybackSession,
  PlaylistUpdate,
  ResolvedTrack,
  SongCandidate,
  StreamingProvider
} from "@ai-journey-dj/core";
import { derivePhase } from "@ai-journey-dj/telemetry";
import { TidalResolver, type TidalAdapter } from "@ai-journey-dj/tidal";
import {
  SpotifyResolver,
  isSpotifyDeviceNotFoundError,
  isSpotifyRateLimitError,
  queueTracksForBuffer,
  type SpotifyAdapter
} from "@ai-journey-dj/spotify";
import type { OpenMusicClient, NoopOpenMusicClient } from "@ai-journey-dj/open-music";
import type { SongScout } from "@ai-journey-dj/recommendation";
import { selectRollingBatch } from "@ai-journey-dj/recommendation";

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

export class JourneyService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly tidalAuth: TidalAuthService,
    private readonly tidalAdapter: TidalAdapter,
    private readonly spotifyAuth: SpotifyAuthService,
    private readonly spotifyAdapter: SpotifyAdapter,
    private readonly songScout: SongScout,
    private readonly openMusic: OpenMusicClient | NoopOpenMusicClient
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
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot analyze a stopped journey.");
    }

    try {
      if (journey.provider === "tidal") {
        return await this.analyzeTidalJourney(journey, reason);
      }
      return await this.analyzeSpotifyJourney(journey, reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.audit(journeyId, "analysis.failed", message, { reason });
      throw error;
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
    const context = contextFromJourney(journey, telemetry);
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
    const context = contextFromJourney(journey, telemetry);
    const candidates = await this.generateAndStoreCandidates(journeyId, context, 12);
    const accessToken = await this.spotifyAuth.getAccessToken();
    const resolver = new SpotifyResolver(this.spotifyAdapter, {
      accessToken,
      market: this.config.SPOTIFY_MARKET
    });
    const resolved = await resolver.resolveCandidates(candidates);
    const resolvedIds = this.storeResolved(journeyId, candidates, resolved);

    let stored = this.store.listResolvedTracks(journeyId).filter((track) => track.provider === "spotify");
    let session = this.store.getPlaybackSession(journeyId);
    let activeTrack = session?.activeTrack && session.activeTrack.provider === "spotify"
      ? stored.find((track) => track.id === session?.activeTrack?.id)
      : undefined;

    if (!activeTrack) {
      activeTrack = stored.find((track) => track.providerUri && track.isPlayable !== false);
    }

    const currentQueued = (session?.queuedTrackIds ?? [])
      .map((id) => stored.find((track) => track.id === id))
      .filter((track): track is ResolvedTrack & { id: string; addedToPlaylist: boolean } => Boolean(track));
    const needed = Math.max(0, 5 - currentQueued.length);
    let selected = queueTracksForBuffer(stored, {
      activeProviderTrackId: activeTrack?.providerTrackId,
      alreadyQueuedProviderIds: new Set(currentQueued.map((track) => track.providerTrackId)),
      targetBufferSize: needed
    });

    if (currentQueued.length + selected.length < 5) {
      this.store.audit(journeyId, "recommendation.fallback", "Spotify analysis resolved fewer than 5 future tracks; running fallback.");
      const fallbackCandidates = await this.generateAndStoreCandidates(journeyId, context, 8);
      const fallbackResolved = await resolver.resolveCandidates(fallbackCandidates);
      this.storeResolved(journeyId, fallbackCandidates, fallbackResolved);
      stored = this.store.listResolvedTracks(journeyId).filter((track) => track.provider === "spotify");
      activeTrack = activeTrack ?? stored.find((track) => track.providerUri && track.isPlayable !== false);
      selected = queueTracksForBuffer(stored, {
        activeProviderTrackId: activeTrack?.providerTrackId,
        alreadyQueuedProviderIds: new Set([...currentQueued.map((track) => track.providerTrackId), ...selected.map((track) => track.providerTrackId)]),
        targetBufferSize: Math.max(0, 5 - currentQueued.length - selected.length)
      });
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
      targetBufferSize: 5,
      lastHeartbeatAt: new Date().toISOString()
    });
    this.store.audit(journeyId, "spotify.queue_updated", `Spotify queue update ${status}: ${queuedTracks.length}/5 future tracks.`, {
      reason,
      activeTrackId: activeTrack?.providerTrackId,
      queuedTrackIds: queuedTracks.map((track) => track.providerTrackId),
      resolvedIds
    });
    return update;
  }

  private pickSpotifyPlaybackTracks(
    stored: Array<ResolvedTrack & { id: string; addedToPlaylist: boolean }>,
    session?: PlaybackSession
  ): {
    activeTrack?: ResolvedTrack & { id: string; addedToPlaylist: boolean };
    queueTracks: Array<ResolvedTrack & { id: string; addedToPlaylist: boolean }>;
    queuedTrackIds: string[];
  } {
    const queued = (session?.queuedTrackIds ?? [])
      .map((id) => stored.find((track) => track.id === id))
      .filter((track): track is ResolvedTrack & { id: string; addedToPlaylist: boolean } => Boolean(track));

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
        throw error;
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
        throw error;
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
        throw error;
      }
    }

    if (transferFailed) {
      return { deviceReachable: false };
    }
    return { deviceReachable: true, rateLimited: rateLimited || undefined };
  }

  async maybeRefreshActiveJourneys(): Promise<void> {
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

  private async generateAndStoreCandidates(
    journeyId: string,
    context: Parameters<SongScout["generateCandidates"]>[0],
    targetCount: number
  ): Promise<SongCandidate[]> {
    const generated = await this.songScout.generateCandidates(context, targetCount);
    const enriched = await Promise.all(generated.map((candidate) => this.openMusic.enrichCandidate(candidate)));
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
