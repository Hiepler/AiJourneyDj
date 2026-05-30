import type {
  JourneyContext,
  JourneyRecord,
  NormalizedTelemetryEvent,
  PlaybackSession,
  PlaylistUpdate,
  QueueOperation,
  ResolvedTrack,
  SongCandidate
} from "@ai-journey-dj/core";
import { speedBucket, temperatureBucket } from "@ai-journey-dj/telemetry";

import type { Db } from "./database.js";

const now = () => new Date().toISOString();

export interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAtIso?: string;
  userId?: string;
}

export class Store {
  constructor(private readonly db: Db) {}

  saveOauthState(state: string, codeVerifier: string): void {
    this.db.run("INSERT INTO oauth_states (state, code_verifier, created_at) VALUES (?, ?, ?)", [
      state,
      codeVerifier,
      now()
    ]);
  }

  consumeOauthState(state: string): string | undefined {
    const row = this.db.get<{ code_verifier: string }>("SELECT code_verifier FROM oauth_states WHERE state = ?", [
      state
    ]);
    this.db.run("DELETE FROM oauth_states WHERE state = ?", [state]);
    return row?.code_verifier;
  }

  saveCredentials(provider: string, encryptedPayload: string): void {
    this.db.run(
      `INSERT INTO provider_credentials (user_id, provider, encrypted_payload, updated_at)
       VALUES ('local', ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET encrypted_payload = excluded.encrypted_payload, updated_at = excluded.updated_at`,
      [provider, encryptedPayload, now()]
    );
  }

  getEncryptedCredentials(provider: string): string | undefined {
    return this.db.get<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM provider_credentials WHERE user_id = 'local' AND provider = ?",
      [provider]
    )?.encrypted_payload;
  }

  deleteCredentials(provider: string): void {
    this.db.run("DELETE FROM provider_credentials WHERE user_id = 'local' AND provider = ?", [provider]);
  }

  createJourney(record: JourneyRecord): void {
    this.db.run(
      `INSERT INTO journeys
       (id, user_id, provider, destination, user_prompt, passenger_mode, phase, status, spotify_device_id, tidal_playlist_id, tidal_playlist_url, created_at, stopped_at)
       VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.provider,
        record.destination,
        record.userPrompt,
        record.passengerMode,
        record.phase,
        record.status,
        record.spotifyDeviceId,
        record.tidalPlaylistId,
        record.tidalPlaylistUrl,
        record.createdAtIso,
        record.stoppedAtIso
      ]
    );
  }

  updateJourneyProvider(journeyId: string, provider: "spotify" | "tidal"): void {
    this.db.run("UPDATE journeys SET provider = ? WHERE id = ?", [provider, journeyId]);
  }

  updateJourneySpotifyDevice(journeyId: string, deviceId: string | undefined): void {
    this.db.run("UPDATE journeys SET spotify_device_id = ? WHERE id = ?", [deviceId, journeyId]);
  }

  updateJourneyPlaylist(journeyId: string, playlistId: string, playlistUrl?: string): void {
    this.db.run("UPDATE journeys SET tidal_playlist_id = ?, tidal_playlist_url = ? WHERE id = ?", [
      playlistId,
      playlistUrl ?? null,
      journeyId
    ]);
  }

  updateJourneyPhase(journeyId: string, phase: string): void {
    this.db.run("UPDATE journeys SET phase = ? WHERE id = ?", [phase, journeyId]);
  }

  stopJourney(journeyId: string): void {
    this.db.run("UPDATE journeys SET status = 'stopped', stopped_at = ? WHERE id = ?", [now(), journeyId]);
  }

  getJourney(journeyId: string): JourneyRecord | undefined {
    const row = this.db.get<any>("SELECT * FROM journeys WHERE id = ?", [journeyId]);
    return row ? mapJourney(row) : undefined;
  }

  listJourneys(limit = 30): JourneyRecord[] {
    return this.db
      .all<any>("SELECT * FROM journeys ORDER BY created_at DESC LIMIT ?", [limit])
      .map(mapJourney);
  }

  listActiveJourneys(): JourneyRecord[] {
    return this.db.all<any>("SELECT * FROM journeys WHERE status = 'active' ORDER BY created_at ASC").map(mapJourney);
  }

  saveTelemetry(journeyId: string | undefined, event: NormalizedTelemetryEvent, phase: string): void {
    this.db.run(
      `INSERT INTO telemetry_snapshots
       (journey_id, timestamp, coarse_region, destination, eta_minutes, speed_bucket, temperature_bucket, phase, autopilot_state, battery_percent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        journeyId,
        event.timestampIso,
        event.coarseRegion,
        event.destination,
        event.etaMinutes,
        speedBucket(event.speedKph),
        temperatureBucket(event.outsideTempC),
        phase,
        event.autopilotState,
        event.batteryPercent
      ]
    );
  }

  latestTelemetry(journeyId: string): NormalizedTelemetryEvent | undefined {
    const row = this.db.get<any>(
      "SELECT * FROM telemetry_snapshots WHERE journey_id = ? ORDER BY timestamp DESC LIMIT 1",
      [journeyId]
    );

    if (!row) return undefined;
    return {
      timestampIso: row.timestamp,
      coarseRegion: row.coarse_region,
      destination: row.destination,
      etaMinutes: row.eta_minutes,
      autopilotState: row.autopilot_state,
      batteryPercent: row.battery_percent
    };
  }

  saveCandidate(journeyId: string, candidate: SongCandidate): string {
    const id = candidate.id ?? crypto.randomUUID();
    this.db.run(
      `INSERT OR IGNORE INTO song_candidates
       (id, journey_id, artist, title, album, year, isrc, reason, source, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        journeyId,
        candidate.artist,
        candidate.title,
        candidate.album,
        candidate.year,
        candidate.isrc,
        candidate.reason,
        candidate.source,
        candidate.confidence,
        now()
      ]
    );
    return id;
  }

  saveResolvedTrack(journeyId: string, candidateId: string | undefined, track: ResolvedTrack): string {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT OR IGNORE INTO resolved_tracks
       (id, journey_id, candidate_id, provider, provider_track_id, provider_uri, external_url, is_playable, market, album_art_url, artist, title, isrc, match_confidence, match_reason, added_to_playlist, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        id,
        journeyId,
        candidateId,
        track.provider,
        track.providerTrackId,
        track.providerUri,
        track.externalUrl,
        track.isPlayable === undefined ? undefined : track.isPlayable ? 1 : 0,
        track.market,
        track.albumArtUrl,
        track.artist,
        track.title,
        track.isrc,
        track.matchConfidence,
        track.matchReason,
        now()
      ]
    );
    return (
      this.db.get<{ id: string }>(
        "SELECT id FROM resolved_tracks WHERE journey_id = ? AND provider = ? AND provider_track_id = ?",
        [journeyId, track.provider, track.providerTrackId]
      )?.id ?? id
    );
  }

  listResolvedTracks(journeyId: string): Array<ResolvedTrack & { id: string; addedToPlaylist: boolean }> {
    return this.db
      .all<any>("SELECT * FROM resolved_tracks WHERE journey_id = ? ORDER BY created_at ASC", [journeyId])
      .map((row) => ({
        id: row.id,
        provider: row.provider,
        providerTrackId: row.provider_track_id,
        providerUri: row.provider_uri ?? undefined,
        externalUrl: row.external_url ?? undefined,
        isPlayable: row.is_playable === null || row.is_playable === undefined ? undefined : row.is_playable === 1,
        market: row.market ?? undefined,
        albumArtUrl: row.album_art_url ?? undefined,
        artist: row.artist,
        title: row.title,
        isrc: row.isrc,
        matchConfidence: row.match_confidence,
        matchReason: row.match_reason,
        addedToPlaylist: row.added_to_playlist === 1
      }));
  }

  markTracksAdded(ids: string[]): void {
    for (const id of ids) {
      this.db.run("UPDATE resolved_tracks SET added_to_playlist = 1 WHERE id = ?", [id]);
    }
  }

  savePlaylistUpdate(update: PlaylistUpdate): void {
    this.db.run(
      `INSERT INTO playlist_updates
       (id, journey_id, provider, batch_size, candidate_ids, resolved_track_ids, idempotency_key, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        update.id,
        update.journeyId,
        update.provider,
        update.batchSize,
        JSON.stringify(update.candidateIds),
        JSON.stringify(update.resolvedTrackIds),
        update.idempotencyKey,
        update.status,
        update.createdAtIso
      ]
    );
  }

  latestPlaylistUpdate(journeyId: string): PlaylistUpdate | undefined {
    const row = this.db.get<any>(
      "SELECT * FROM playlist_updates WHERE journey_id = ? ORDER BY created_at DESC LIMIT 1",
      [journeyId]
    );
    return row
      ? {
          id: row.id,
          journeyId: row.journey_id,
          provider: row.provider ?? undefined,
          batchSize: row.batch_size,
          candidateIds: JSON.parse(row.candidate_ids),
          resolvedTrackIds: JSON.parse(row.resolved_track_ids),
          idempotencyKey: row.idempotency_key,
          status: row.status,
          createdAtIso: row.created_at
        }
      : undefined;
  }

  savePlaybackSession(session: PlaybackSession): void {
    this.db.run(
      `INSERT INTO playback_sessions
       (journey_id, provider, device_id, status, active_track_id, queued_track_ids, played_track_ids, target_buffer_size, last_heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(journey_id) DO UPDATE SET
         provider = excluded.provider,
         device_id = excluded.device_id,
         status = excluded.status,
         active_track_id = excluded.active_track_id,
         queued_track_ids = excluded.queued_track_ids,
         played_track_ids = excluded.played_track_ids,
         target_buffer_size = excluded.target_buffer_size,
         last_heartbeat_at = excluded.last_heartbeat_at`,
      [
        session.journeyId,
        session.provider,
        session.deviceId,
        session.status,
        session.activeTrack?.id,
        JSON.stringify(session.queuedTrackIds),
        JSON.stringify(session.playedTrackIds ?? []),
        session.targetBufferSize,
        session.lastHeartbeatAt
      ]
    );
  }

  getPlaybackSession(journeyId: string): PlaybackSession | undefined {
    const row = this.db.get<any>("SELECT * FROM playback_sessions WHERE journey_id = ?", [journeyId]);
    if (!row) return undefined;
    const activeTrack = row.active_track_id
      ? this.listResolvedTracks(journeyId).find((track) => track.id === row.active_track_id)
      : undefined;
    return {
      journeyId: row.journey_id,
      provider: row.provider,
      deviceId: row.device_id ?? undefined,
      status: row.status,
      activeTrack,
      queuedTrackIds: JSON.parse(row.queued_track_ids),
      playedTrackIds: JSON.parse(row.played_track_ids ?? "[]"),
      targetBufferSize: 5,
      lastHeartbeatAt: row.last_heartbeat_at
    };
  }

  saveQueueOperation(operation: QueueOperation): void {
    this.db.run(
      `INSERT INTO queue_operations
       (id, journey_id, provider, provider_track_id, provider_uri, operation, status, device_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        operation.id,
        operation.journeyId,
        operation.provider,
        operation.providerTrackId,
        operation.providerUri,
        operation.operation,
        operation.status,
        operation.deviceId,
        operation.createdAtIso
      ]
    );
  }

  listQueueOperations(journeyId: string): QueueOperation[] {
    return this.db
      .all<any>("SELECT * FROM queue_operations WHERE journey_id = ? ORDER BY created_at ASC", [journeyId])
      .map((row) => ({
        id: row.id,
        journeyId: row.journey_id,
        provider: row.provider,
        providerTrackId: row.provider_track_id,
        providerUri: row.provider_uri ?? undefined,
        operation: row.operation,
        status: row.status,
        deviceId: row.device_id ?? undefined,
        createdAtIso: row.created_at
      }));
  }

  audit(journeyId: string | undefined, type: string, message: string, payload?: unknown): void {
    this.db.run(
      "INSERT INTO audit_events (journey_id, type, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      [journeyId, type, message, payload ? JSON.stringify(payload) : undefined, now()]
    );
  }

  latestAuditEvent(journeyId: string, type: string): { message: string; createdAtIso: string } | undefined {
    const row = this.db.get<{ message: string; created_at: string }>(
      "SELECT message, created_at FROM audit_events WHERE journey_id = ? AND type = ? ORDER BY id DESC LIMIT 1",
      [journeyId, type]
    );
    return row ? { message: row.message, createdAtIso: row.created_at } : undefined;
  }

  clearAuditEvents(journeyId: string, type: string): void {
    this.db.run("DELETE FROM audit_events WHERE journey_id = ? AND type = ?", [journeyId, type]);
  }

  auditEvents(journeyId: string, sinceId = 0): Array<{ id: number; type: string; message: string; createdAtIso: string }> {
    return this.db.all<any>(
      "SELECT id, type, message, created_at FROM audit_events WHERE journey_id = ? AND id > ? ORDER BY id ASC LIMIT 50",
      [journeyId, sinceId]
    ).map((row) => ({
      id: row.id,
      type: row.type,
      message: row.message,
      createdAtIso: row.created_at
    }));
  }
}

function mapJourney(row: any): JourneyRecord {
  return {
    id: row.id,
    provider: row.provider ?? "tidal",
    destination: row.destination,
    userPrompt: row.user_prompt,
    passengerMode: row.passenger_mode,
    phase: row.phase,
    status: row.status,
    spotifyDeviceId: row.spotify_device_id ?? undefined,
    tidalPlaylistId: row.tidal_playlist_id ?? undefined,
    tidalPlaylistUrl: row.tidal_playlist_url ?? undefined,
    createdAtIso: row.created_at,
    stoppedAtIso: row.stopped_at
  };
}

export function contextFromJourney(journey: JourneyRecord, telemetry?: NormalizedTelemetryEvent): JourneyContext {
  return {
    destination: telemetry?.destination ?? journey.destination,
    coarseRegion: telemetry?.coarseRegion,
    localTimeIso: telemetry?.timestampIso ?? new Date().toISOString(),
    etaMinutes: telemetry?.etaMinutes,
    speedBucket: speedBucket(telemetry?.speedKph),
    temperatureBucket: temperatureBucket(telemetry?.outsideTempC),
    phase: journey.phase,
    userPrompt: journey.userPrompt,
    passengerMode: journey.passengerMode
  };
}
