import { DatabaseSync } from "node:sqlite";

export interface Db {
  execute(sql: string): void;
  get<T>(sql: string, params?: any[]): T | undefined;
  all<T>(sql: string, params?: any[]): T[];
  run(
    sql: string,
    params?: any[],
  ): { lastInsertRowid: number | bigint; changes: number | bigint };
}

export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const bind = (params: any[]) =>
    params.map((value) => (value === undefined ? null : value));

  return {
    execute: (sql) => db.exec(sql),
    get: <T>(sql: string, params: any[] = []) =>
      db.prepare(sql).get(...bind(params)) as T | undefined,
    all: <T>(sql: string, params: any[] = []) =>
      db.prepare(sql).all(...bind(params)) as T[],
    run: (sql: string, params: any[] = []) =>
      db.prepare(sql).run(...bind(params)),
  };
}

export function migrate(db: Db): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_credentials (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, provider)
    );

    CREATE TABLE IF NOT EXISTS journeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'tidal',
      destination TEXT NOT NULL,
      user_prompt TEXT NOT NULL,
      passenger_mode TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      taste_weight REAL,
      spotify_device_id TEXT,
      spotify_playlist_id TEXT,
      spotify_playlist_url TEXT,
      tidal_playlist_id TEXT,
      tidal_playlist_url TEXT,
      created_at TEXT NOT NULL,
      stopped_at TEXT
    );

    CREATE TABLE IF NOT EXISTS telemetry_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journey_id TEXT,
	      timestamp TEXT NOT NULL,
	      coarse_region TEXT,
	      country_name TEXT,
	      country_code TEXT,
	      geo_source TEXT,
	      destination TEXT,
      eta_minutes INTEGER,
      speed_kph REAL,
      outside_temp_c REAL,
      speed_bucket TEXT,
      temperature_bucket TEXT,
      phase TEXT,
      autopilot_state TEXT,
      battery_percent INTEGER,
      longitudinal_accel_mps2 REAL,
      brake_pedal INTEGER,
      hazards_active INTEGER,
      received_at TEXT
    );

    CREATE TABLE IF NOT EXISTS song_candidates (
      id TEXT PRIMARY KEY,
      journey_id TEXT NOT NULL,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      album TEXT,
      year INTEGER,
      isrc TEXT,
      genre TEXT,
      lens TEXT,
	      role TEXT,
	      scores_json TEXT,
	      popularity INTEGER,
	      explicit INTEGER,
	      release_date TEXT,
	      chart_rank INTEGER,
	      chart_playcount INTEGER,
	      chart_country TEXT,
	      chart_source TEXT,
	      mood_tags_json TEXT,
	      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resolved_tracks (
      id TEXT PRIMARY KEY,
      journey_id TEXT NOT NULL,
      candidate_id TEXT,
      provider TEXT NOT NULL,
      provider_track_id TEXT NOT NULL,
      provider_uri TEXT,
      external_url TEXT,
      is_playable INTEGER,
      market TEXT,
      album_art_url TEXT,
      artist TEXT NOT NULL,
	      title TEXT NOT NULL,
	      isrc TEXT,
	      popularity INTEGER,
	      explicit INTEGER,
	      release_date TEXT,
	      chart_rank INTEGER,
	      chart_playcount INTEGER,
	      chart_country TEXT,
	      chart_source TEXT,
	      mood_tags_json TEXT,
	      match_confidence REAL NOT NULL,
      match_reason TEXT NOT NULL,
      added_to_playlist INTEGER NOT NULL DEFAULT 0,
      saved_to_playlist INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (journey_id, provider, provider_track_id)
    );

    CREATE TABLE IF NOT EXISTS playlist_updates (
      id TEXT PRIMARY KEY,
      journey_id TEXT NOT NULL,
      provider TEXT,
      batch_size INTEGER NOT NULL,
      candidate_ids TEXT NOT NULL,
      resolved_track_ids TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playback_sessions (
      journey_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      device_id TEXT,
      status TEXT NOT NULL,
      active_track_id TEXT,
      queued_track_ids TEXT NOT NULL,
      target_buffer_size INTEGER NOT NULL DEFAULT 5,
      last_heartbeat_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_operations (
      id TEXT PRIMARY KEY,
      journey_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_track_id TEXT NOT NULL,
      provider_uri TEXT,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      device_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journey_id TEXT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS spotify_search_cache (
      cache_key TEXT PRIMARY KEY,
      track_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS taste_profile_cache (
      user_id TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS music_wishes (
      id TEXT PRIMARY KEY,
      journey_id TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      source TEXT NOT NULL,
      parsed_intents_json TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      summary TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      expires_after_tracks INTEGER NOT NULL,
      remaining_tracks INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_plays (
      id TEXT PRIMARY KEY,
      journey_id TEXT NOT NULL,
      artist TEXT NOT NULL,
      song_key TEXT NOT NULL,
      surfaced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recent_plays_surfaced_at
      ON recent_plays (surfaced_at);
  `);

  tryAddColumn(db, "journeys", "provider", "TEXT NOT NULL DEFAULT 'tidal'");
  tryAddColumn(db, "journeys", "spotify_device_id", "TEXT");
  tryAddColumn(db, "journeys", "taste_weight", "REAL");
  tryAddColumn(db, "journeys", "spotify_playlist_id", "TEXT");
  tryAddColumn(db, "journeys", "spotify_playlist_url", "TEXT");
  tryAddColumn(
    db,
    "resolved_tracks",
    "saved_to_playlist",
    "INTEGER NOT NULL DEFAULT 0",
  );
  tryAddColumn(db, "resolved_tracks", "provider_uri", "TEXT");
  tryAddColumn(db, "resolved_tracks", "external_url", "TEXT");
  tryAddColumn(db, "resolved_tracks", "is_playable", "INTEGER");
  tryAddColumn(db, "resolved_tracks", "market", "TEXT");
  tryAddColumn(db, "resolved_tracks", "album_art_url", "TEXT");
  tryAddColumn(db, "playlist_updates", "provider", "TEXT");
  tryAddColumn(
    db,
    "playback_sessions",
    "played_track_ids",
    "TEXT NOT NULL DEFAULT '[]'",
  );
  tryAddColumn(db, "telemetry_snapshots", "received_at", "TEXT");
  tryAddColumn(db, "telemetry_snapshots", "country_name", "TEXT");
  tryAddColumn(db, "telemetry_snapshots", "country_code", "TEXT");
  tryAddColumn(db, "telemetry_snapshots", "geo_source", "TEXT");
  tryAddColumn(db, "telemetry_snapshots", "speed_kph", "REAL");
  tryAddColumn(db, "telemetry_snapshots", "outside_temp_c", "REAL");
  tryAddColumn(db, "telemetry_snapshots", "traffic_delay_minutes", "REAL");
  tryAddColumn(db, "telemetry_snapshots", "energy_percent_at_arrival", "REAL");
  tryAddColumn(db, "telemetry_snapshots", "audio_volume", "REAL");
  tryAddColumn(db, "telemetry_snapshots", "longitudinal_accel_mps2", "REAL");
  tryAddColumn(db, "telemetry_snapshots", "brake_pedal", "INTEGER");
  tryAddColumn(db, "telemetry_snapshots", "hazards_active", "INTEGER");
  tryAddColumn(db, "journeys", "drive_mode", "TEXT");
  tryAddColumn(
    db,
    "journeys",
    "adaptive_mode_enabled",
    "INTEGER NOT NULL DEFAULT 1",
  );
  tryAddColumn(db, "journeys", "planned_duration_minutes", "INTEGER");
  tryAddColumn(db, "journeys", "planned_duration_set_at", "TEXT");
  tryAddColumn(db, "journeys", "kids_mode", "INTEGER NOT NULL DEFAULT 0");
  tryAddColumn(db, "song_candidates", "genre", "TEXT");
  tryAddColumn(db, "song_candidates", "lens", "TEXT");
  tryAddColumn(db, "song_candidates", "role", "TEXT");
  tryAddColumn(db, "song_candidates", "scores_json", "TEXT");
  tryAddColumn(db, "song_candidates", "popularity", "INTEGER");
  tryAddColumn(db, "song_candidates", "explicit", "INTEGER");
  tryAddColumn(db, "song_candidates", "release_date", "TEXT");
  tryAddColumn(db, "song_candidates", "chart_rank", "INTEGER");
  tryAddColumn(db, "song_candidates", "chart_playcount", "INTEGER");
  tryAddColumn(db, "song_candidates", "chart_country", "TEXT");
  tryAddColumn(db, "song_candidates", "chart_source", "TEXT");
  tryAddColumn(db, "song_candidates", "mood_tags_json", "TEXT");
  tryAddColumn(db, "resolved_tracks", "popularity", "INTEGER");
  tryAddColumn(db, "resolved_tracks", "explicit", "INTEGER");
  tryAddColumn(db, "resolved_tracks", "release_date", "TEXT");
  tryAddColumn(db, "resolved_tracks", "chart_rank", "INTEGER");
  tryAddColumn(db, "resolved_tracks", "chart_playcount", "INTEGER");
  tryAddColumn(db, "resolved_tracks", "chart_country", "TEXT");
  tryAddColumn(db, "resolved_tracks", "chart_source", "TEXT");
  tryAddColumn(db, "resolved_tracks", "mood_tags_json", "TEXT");

  db.run("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)", [
    "local",
    new Date().toISOString(),
  ]);
}

function tryAddColumn(
  db: Db,
  table: string,
  column: string,
  definition: string,
): void {
  try {
    db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("duplicate column")
    ) {
      return;
    }
    throw error;
  }
}
