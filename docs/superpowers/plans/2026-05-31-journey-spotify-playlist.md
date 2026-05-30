# Journey Spotify Playlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-create a private Spotify playlist per journey and extend it with every curated track, so the trip's music can be replayed later.

**Architecture:** A new `addTracksToPlaylist` adapter method + existing `createPlaylist`. The journey service lazily creates the playlist and, at the end of each `analyzeSpotifyJourney`, mirrors newly-curated tracks (`addedToPlaylist && !savedToPlaylist`) into it. Best-effort; never affects playback. A new `saved_to_playlist` flag makes adds idempotent.

**Tech Stack:** TypeScript monorepo, Vitest, node:sqlite, Fastify, Spotify Web API, React.

---

## File Structure

- **Modify** `packages/core/src/index.ts` — `JourneyRecord` gains `spotifyPlaylistId?`/`spotifyPlaylistUrl?`.
- **Modify** `packages/spotify/src/index.ts` — `SpotifyAdapter.addTracksToPlaylist` (Official + Mock).
- **Modify** `packages/spotify/src/index.test.ts` — adapter test.
- **Modify** `apps/api/src/auth/spotifyAuth.ts` — add `playlist-modify-private` scope.
- **Modify** `apps/api/test/spotify.test.ts` — scope assertion.
- **Modify** `apps/api/src/db/database.ts` — journeys + resolved_tracks columns.
- **Modify** `apps/api/src/db/store.ts` — playlist fields + `saved_to_playlist` helpers.
- **Modify** `apps/api/src/journeys/journeyService.ts` — `ensureJourneySpotifyPlaylist` + `syncJourneyPlaylist` + call in analyze.
- **Create** `apps/api/test/journeyPlaylist.test.ts` — store + integration tests.
- **Modify** `apps/web/src/lib/api.ts` — `Journey` playlist fields.
- **Modify** `apps/web/src/App.tsx` — "Playlist" link.

All commands run from repo root `/Users/benedikthiepler/projects/priv/tidal`.

---

## Task 1: Spotify adapter `addTracksToPlaylist` + scope

**Files:**
- Modify: `packages/spotify/src/index.ts`
- Test: `packages/spotify/src/index.test.ts`
- Modify: `apps/api/src/auth/spotifyAuth.ts`
- Test: `apps/api/test/spotify.test.ts`

- [ ] **Step 1: Write the failing adapter test**

Append inside `describe("spotify playback helpers", ...)` in `packages/spotify/src/index.test.ts` (before its closing `});`):

```ts
  it("adds tracks to a playlist via POST /playlists/{id}/tracks", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      return new Response(JSON.stringify({ snapshot_id: "snap" }), { status: 201 });
    };
    const adapter = new OfficialSpotifyAdapter({ baseUrl: "https://api.spotify.test/v1", fetchImpl, wait: async () => undefined });

    await adapter.addTracksToPlaylist!({ accessToken: "tok", playlistId: "pl1", uris: ["spotify:track:a", "spotify:track:b"] });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.spotify.test/v1/playlists/pl1/tracks");
    expect(calls[0].body).toEqual({ uris: ["spotify:track:a", "spotify:track:b"] });
  });

  it("does not call the API when there are no uris to add", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    const adapter = new OfficialSpotifyAdapter({ baseUrl: "https://api.spotify.test/v1", fetchImpl, wait: async () => undefined });
    await adapter.addTracksToPlaylist!({ accessToken: "t", playlistId: "pl1", uris: [] });
    expect(called).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run packages/spotify/src/index.test.ts -t "playlist"`
Expected: FAIL — `addTracksToPlaylist` is undefined.

- [ ] **Step 3: Add `addTracksToPlaylist` to the interface**

In `packages/spotify/src/index.ts`, inside `export interface SpotifyAdapter {`, add after the `createPlaylist?(...)` member:

```ts
  addTracksToPlaylist?(args: {
    accessToken: string;
    playlistId: string;
    uris: string[];
  }): Promise<void>;
```

- [ ] **Step 4: Implement it on `OfficialSpotifyAdapter`**

In `packages/spotify/src/index.ts`, add this method to `OfficialSpotifyAdapter` immediately after its `createPlaylist` method:

```ts
  async addTracksToPlaylist(args: { accessToken: string; playlistId: string; uris: string[] }): Promise<void> {
    if (args.uris.length === 0) return;
    const url = new URL(`${this.baseUrl}/playlists/${args.playlistId}/tracks`);
    await this.request(
      url,
      args.accessToken,
      { method: "POST", body: JSON.stringify({ uris: args.uris }) },
      { parseJson: false }
    );
  }
```

- [ ] **Step 5: Implement it on `MockSpotifyAdapter`**

In `packages/spotify/src/index.ts`, add a recording field + method to `MockSpotifyAdapter`. Add the field near its other private fields (e.g. after `private active = new Map<string, string>();`):

```ts
  addTracksToPlaylistCalls: { playlistId: string; uris: string[] }[] = [];
```

And add the method right after the mock's `createPlaylist`:

```ts
  async addTracksToPlaylist(args: { accessToken: string; playlistId: string; uris: string[] }): Promise<void> {
    if (args.uris.length === 0) return;
    this.addTracksToPlaylistCalls.push({ playlistId: args.playlistId, uris: args.uris });
  }
```

- [ ] **Step 6: Run the adapter test to verify it passes**

Run: `./node_modules/.bin/vitest run packages/spotify/src/index.test.ts`
Expected: PASS (all, including the two new tests).

- [ ] **Step 7: Add the scope + update the scope test**

In `apps/api/src/auth/spotifyAuth.ts`, change `SPOTIFY_SCOPES` to add the new scope:

```ts
export const SPOTIFY_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  // Reads the listener's top artists to personalize the soundtrack (familiarity↔discovery mix).
  "user-top-read",
  // Creates + extends the saved per-journey playlist.
  "playlist-modify-private"
] as const;
```

In `apps/api/test/spotify.test.ts`, update the scope assertion:

```ts
    expect(url.searchParams.get("scope")).toBe(
      "streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state user-top-read playlist-modify-private"
    );
```

- [ ] **Step 8: Run the api scope test**

Run: `./node_modules/.bin/vitest run apps/api/test/spotify.test.ts -t "PKCE"`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/spotify/src/index.ts packages/spotify/src/index.test.ts apps/api/src/auth/spotifyAuth.ts apps/api/test/spotify.test.ts
git commit -m "feat(spotify): addTracksToPlaylist adapter + playlist-modify-private scope"
```

---

## Task 2: Journey playlist fields + saved_to_playlist (core + db + store)

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `apps/api/src/db/database.ts`
- Modify: `apps/api/src/db/store.ts`
- Test: `apps/api/test/journeyPlaylist.test.ts` (create)

- [ ] **Step 1: Write the failing store test**

Create `apps/api/test/journeyPlaylist.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JourneyRecord, ResolvedTrack } from "@ai-journey-dj/core";
import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/db/database.js";
import { Store } from "../src/db/store.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-playlist-"));
  tmpDirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return new Store(db);
}

function makeJourney(overrides: Partial<JourneyRecord> = {}): JourneyRecord {
  return {
    id: "j1",
    provider: "spotify",
    destination: "Lago di Garda",
    userPrompt: "golden hour",
    passengerMode: "couple",
    phase: "departure",
    status: "active",
    createdAtIso: new Date().toISOString(),
    ...overrides
  };
}

const track: ResolvedTrack = {
  provider: "spotify",
  providerTrackId: "t1",
  providerUri: "spotify:track:t1",
  artist: "M83",
  title: "Wait",
  matchConfidence: 0.94,
  matchReason: "x"
};

describe("journey playlist (store)", () => {
  it("persists and updates the spotify playlist id/url", () => {
    const store = freshStore();
    store.createJourney(makeJourney());
    expect(store.getJourney("j1")?.spotifyPlaylistId).toBeUndefined();

    store.updateJourneySpotifyPlaylist("j1", "pl1", "https://open.spotify.com/playlist/pl1");
    const journey = store.getJourney("j1");
    expect(journey?.spotifyPlaylistId).toBe("pl1");
    expect(journey?.spotifyPlaylistUrl).toBe("https://open.spotify.com/playlist/pl1");
  });

  it("tracks saved_to_playlist separately from addedToPlaylist", () => {
    const store = freshStore();
    store.createJourney(makeJourney());
    const id = store.saveResolvedTrack("j1", undefined, track);
    expect(store.listResolvedTracks("j1")[0].savedToPlaylist).toBe(false);

    store.markTracksSavedToPlaylist([id]);
    expect(store.listResolvedTracks("j1")[0].savedToPlaylist).toBe(true);
    // addedToPlaylist (buffer membership) is untouched by the playlist flag.
    expect(store.listResolvedTracks("j1")[0].addedToPlaylist).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/api/test/journeyPlaylist.test.ts`
Expected: FAIL — `spotifyPlaylistId`/`updateJourneySpotifyPlaylist`/`savedToPlaylist`/`markTracksSavedToPlaylist` missing.

- [ ] **Step 3: Add fields to `JourneyRecord`**

In `packages/core/src/index.ts`, inside `JourneyRecord`, add after `tasteWeight?: number;`:

```ts
  spotifyPlaylistId?: string;
  spotifyPlaylistUrl?: string;
```

- [ ] **Step 4: Add DB columns**

In `apps/api/src/db/database.ts`, in the `journeys` CREATE TABLE, add after the `taste_weight REAL,` line:

```ts
      spotify_playlist_id TEXT,
      spotify_playlist_url TEXT,
```

In the `resolved_tracks` CREATE TABLE, add after `added_to_playlist INTEGER NOT NULL DEFAULT 0,`:

```ts
      saved_to_playlist INTEGER NOT NULL DEFAULT 0,
```

In the `tryAddColumn` block, add:

```ts
  tryAddColumn(db, "journeys", "spotify_playlist_id", "TEXT");
  tryAddColumn(db, "journeys", "spotify_playlist_url", "TEXT");
  tryAddColumn(db, "resolved_tracks", "saved_to_playlist", "INTEGER NOT NULL DEFAULT 0");
```

- [ ] **Step 5: Update `createJourney` + `mapJourney` + add helpers**

In `apps/api/src/db/store.ts`, replace the `createJourney` SQL + params to include the two columns:

```ts
  createJourney(record: JourneyRecord): void {
    this.db.run(
      `INSERT INTO journeys
       (id, user_id, provider, destination, user_prompt, passenger_mode, phase, status, taste_weight, spotify_device_id, spotify_playlist_id, spotify_playlist_url, tidal_playlist_id, tidal_playlist_url, created_at, stopped_at)
       VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.provider,
        record.destination,
        record.userPrompt,
        record.passengerMode,
        record.phase,
        record.status,
        record.tasteWeight ?? null,
        record.spotifyDeviceId,
        record.spotifyPlaylistId ?? null,
        record.spotifyPlaylistUrl ?? null,
        record.tidalPlaylistId,
        record.tidalPlaylistUrl,
        record.createdAtIso,
        record.stoppedAtIso
      ]
    );
  }

  updateJourneySpotifyPlaylist(journeyId: string, playlistId: string, playlistUrl?: string): void {
    this.db.run("UPDATE journeys SET spotify_playlist_id = ?, spotify_playlist_url = ? WHERE id = ?", [
      playlistId,
      playlistUrl ?? null,
      journeyId
    ]);
  }
```

In `mapJourney`, add after `tasteWeight: row.taste_weight ?? undefined,`:

```ts
    spotifyPlaylistId: row.spotify_playlist_id ?? undefined,
    spotifyPlaylistUrl: row.spotify_playlist_url ?? undefined,
```

In `listResolvedTracks`'s mapped object, add after `addedToPlaylist: row.added_to_playlist === 1`:

```ts
,
        savedToPlaylist: row.saved_to_playlist === 1
```

(The mapped row keeps `addedToPlaylist` as the last property today; add a comma and the new line.)

Update the `listResolvedTracks` return type from
`Array<ResolvedTrack & { id: string; addedToPlaylist: boolean }>` to
`Array<ResolvedTrack & { id: string; addedToPlaylist: boolean; savedToPlaylist: boolean }>`.

Add the marker method (next to `markTracksAdded`):

```ts
  markTracksSavedToPlaylist(ids: string[]): void {
    for (const id of ids) {
      this.db.run("UPDATE resolved_tracks SET saved_to_playlist = 1 WHERE id = ?", [id]);
    }
  }
```

- [ ] **Step 6: Run the store test to verify it passes**

Run: `./node_modules/.bin/vitest run apps/api/test/journeyPlaylist.test.ts`
Expected: PASS (2 store tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts apps/api/src/db/database.ts apps/api/src/db/store.ts apps/api/test/journeyPlaylist.test.ts
git commit -m "feat: journey spotify playlist fields + saved_to_playlist tracking"
```

---

## Task 3: Service create + extend playlist

**Files:**
- Modify: `apps/api/src/journeys/journeyService.ts`
- Test: `apps/api/test/journeyPlaylist.test.ts`

- [ ] **Step 1: Write the failing integration test**

Append to `apps/api/test/journeyPlaylist.test.ts` these imports at the top (after the existing imports):

```ts
import { NoopOpenMusicClient } from "@ai-journey-dj/open-music";
import { XaiSongScout } from "@ai-journey-dj/recommendation";
import type { SpotifyAdapter, SpotifyPlaybackState, SpotifyPlaylist, SpotifyTrackSearchResult } from "@ai-journey-dj/spotify";
import { MockTidalAdapter } from "@ai-journey-dj/tidal";

import { SpotifyAuthService } from "../src/auth/spotifyAuth.js";
import { TidalAuthService } from "../src/auth/tidalAuth.js";
import { loadConfig } from "../src/config/env.js";
import { JourneyService } from "../src/journeys/journeyService.js";
```

Then append this describe block:

```ts
class PlaylistSpotifyAdapter implements SpotifyAdapter {
  createCalls: { name: string }[] = [];
  addCalls: { playlistId: string; uris: string[] }[] = [];

  async searchTracks(args: { query: string; market: string }): Promise<SpotifyTrackSearchResult[]> {
    const [artist, ...rest] = args.query.split(" - ");
    const title = rest.join(" - ") || artist;
    const id = `${artist}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return [{ id, uri: `spotify:track:${id}`, title, artist, isPlayable: true, market: args.market }];
  }
  async transferPlayback(): Promise<void> {}
  async resolvePlaybackDeviceId(args: { preferredDeviceId: string }): Promise<string> {
    return args.preferredDeviceId;
  }
  async skipToNext(): Promise<void> {}
  async skipToPrevious(): Promise<void> {}
  async startPlayback(): Promise<void> {}
  async addToQueue(): Promise<void> {}
  async getPlaybackState(): Promise<SpotifyPlaybackState> {
    return { isPlaying: false, queuedProviderTrackIds: [] };
  }
  async createPlaylist(args: { name: string; description: string }): Promise<SpotifyPlaylist> {
    this.createCalls.push({ name: args.name });
    const id = `pl-${this.createCalls.length}`;
    return { id, name: args.name, url: `https://open.spotify.com/playlist/${id}` };
  }
  async addTracksToPlaylist(args: { playlistId: string; uris: string[] }): Promise<void> {
    this.addCalls.push({ playlistId: args.playlistId, uris: args.uris });
  }
}

function buildPlaylistService(adapter: SpotifyAdapter) {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-playlist-svc-"));
  tmpDirs.push(dir);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "true",
    CORS_ORIGIN: "http://localhost:5173"
  });
  const db = openDatabase(config.DATABASE_PATH);
  migrate(db);
  const store = new Store(db);
  const service = new JourneyService(
    config,
    store,
    new TidalAuthService(config, store),
    new MockTidalAdapter(),
    new SpotifyAuthService(config, store),
    adapter,
    new XaiSongScout({ apiKey: config.XAI_API_KEY, baseUrl: config.XAI_BASE_URL, model: config.XAI_MODEL, mock: true }),
    new NoopOpenMusicClient()
  );
  return { service, store };
}

describe("journey playlist (service)", () => {
  it("creates a playlist and mirrors the curated tracks, without duplicating on re-analysis", async () => {
    const adapter = new PlaylistSpotifyAdapter();
    const { service, store } = buildPlaylistService(adapter);

    const journey = await service.startJourney({
      destination: "Dijon",
      userPrompt: "road trip",
      passengerMode: "solo",
      provider: "spotify"
    });

    // A private playlist was created, named for the destination, and stored on the journey.
    expect(adapter.createCalls.length).toBe(1);
    expect(adapter.createCalls[0].name).toContain("Dijon");
    expect(store.getJourney(journey.id)?.spotifyPlaylistId).toBe("pl-1");

    // The curated tracks were mirrored into the playlist.
    const addedUris = adapter.addCalls.flatMap((call) => call.uris);
    const curated = store.listResolvedTracks(journey.id).filter((track) => track.addedToPlaylist);
    expect(curated.length).toBeGreaterThan(0);
    expect(addedUris.length).toBe(curated.length);

    // Re-analysis must not re-add already-saved tracks.
    const addCountBefore = adapter.addCalls.flatMap((call) => call.uris).length;
    await service.analyzeJourney(journey.id, "manual");
    const addCountAfter = adapter.addCalls.flatMap((call) => call.uris).length;
    // Only brand-new curated tracks (if any) may be added; previously-saved ones never again.
    expect(addCountAfter).toBeGreaterThanOrEqual(addCountBefore);
    const allSavedUris = adapter.addCalls.flatMap((call) => call.uris);
    expect(new Set(allSavedUris).size).toBe(allSavedUris.length); // no duplicate uri ever added
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/api/test/journeyPlaylist.test.ts -t "creates a playlist"`
Expected: FAIL — no playlist created (`createCalls` empty).

- [ ] **Step 3: Add `ensureJourneySpotifyPlaylist` + `syncJourneyPlaylist`**

In `apps/api/src/journeys/journeyService.ts`, add these two private methods immediately before `private async generateAndStoreCandidates(`:

```ts
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
        .filter((track) => track.provider === "spotify" && track.addedToPlaylist && !track.savedToPlaylist && track.providerUri);
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
```

- [ ] **Step 4: Call `syncJourneyPlaylist` at the end of `analyzeSpotifyJourney`**

In `apps/api/src/journeys/journeyService.ts`, find (near the end of `analyzeSpotifyJourney`):

```ts
    this.store.audit(journeyId, "spotify.queue_updated", `Spotify queue update ${status}: ${queuedTracks.length}/5 future tracks.`, {
      reason,
      activeTrackId: activeTrack?.providerTrackId,
      queuedTrackIds: queuedTracks.map((track) => track.providerTrackId),
      resolvedIds
    });
    return update;
```

Replace with (insert the sync call before `return update;`):

```ts
    this.store.audit(journeyId, "spotify.queue_updated", `Spotify queue update ${status}: ${queuedTracks.length}/5 future tracks.`, {
      reason,
      activeTrackId: activeTrack?.providerTrackId,
      queuedTrackIds: queuedTracks.map((track) => track.providerTrackId),
      resolvedIds
    });
    // Mirror the curated set into the saved journey playlist (best-effort; never blocks the journey).
    await this.syncJourneyPlaylist(journey, accessToken);
    return update;
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `./node_modules/.bin/vitest run apps/api/test/journeyPlaylist.test.ts`
Expected: PASS (store + service tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/journeys/journeyService.ts apps/api/test/journeyPlaylist.test.ts
git commit -m "feat(api): create + dynamically extend the journey spotify playlist"
```

---

## Task 4: Web UI — playlist link

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Add playlist fields to the `Journey` type**

In `apps/web/src/lib/api.ts`, inside the `Journey` interface, add after `tasteWeight?: number;`:

```ts
  spotifyPlaylistId?: string;
  spotifyPlaylistUrl?: string;
```

- [ ] **Step 2: Add the `ListMusic` icon import**

In `apps/web/src/App.tsx`, add `ListMusic,` to the `lucide-react` import block (keep alphabetical order, e.g. after `Loader2,`):

```ts
  ListMusic,
```

- [ ] **Step 3: Render the playlist link in the transport row**

In `apps/web/src/App.tsx`, find the Refresh button in the cockpit transport:

```tsx
                <button className="ctrl" disabled={loading} onClick={refreshQueue} title="Refresh queue" type="button">
                  <RefreshCw className={loading ? "spin" : undefined} size={20} />
                  <span>Refresh</span>
                </button>
```

Add this directly after it:

```tsx
                {detail?.journey.spotifyPlaylistUrl ? (
                  <a
                    className="ctrl"
                    href={detail.journey.spotifyPlaylistUrl}
                    rel="noreferrer"
                    target="_blank"
                    title="Open this journey's playlist on Spotify"
                  >
                    <ListMusic size={20} />
                    <span>Playlist</span>
                  </a>
                ) : null}
```

- [ ] **Step 4: Verify it typechecks**

Run: `npm run typecheck -w @ai-journey-dj/web`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/App.tsx
git commit -m "feat(web): open-journey-playlist link in the cockpit"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck all workspaces**

Run: `npm run typecheck --workspaces`
Expected: exit 0, no `error TS...` lines.

- [ ] **Step 2: Run the full test suite**

Run: `./node_modules/.bin/vitest run`
Expected: all files pass (existing 82 + 2 adapter + 2 store + 1 service = 87), 0 failures.

- [ ] **Step 3: Lint the changed files**

Run:
```bash
npx eslint packages/spotify/src/index.ts apps/api/src/journeys/journeyService.ts apps/api/src/db/store.ts apps/web/src/App.tsx apps/web/src/lib/api.ts
```
Expected: `No issues found`.

- [ ] **Step 4: Commit any lint fixes (only if Step 3 required changes)**

```bash
git add -A
git commit -m "chore: lint cleanup for journey spotify playlist"
```

---

## Self-Review Notes

- **Spec coverage:** §1 scope+adapter (Task 1), data model (Task 2), §2 service create+extend (Task 3), §3 UI (Task 4), §4 error handling (Task 3 try/catch + best-effort call), testing (Tasks 1-3 + Task 5). Covered.
- **Type consistency:** `addTracksToPlaylist`, `updateJourneySpotifyPlaylist`, `markTracksSavedToPlaylist`, `savedToPlaylist`, `spotifyPlaylistId/Url` used identically across tasks. `listResolvedTracks` return type updated in Task 2 and consumed in Task 3's filter (`track.savedToPlaylist`).
- **Idempotency:** `saved_to_playlist` gate + `markTracksSavedToPlaylist` prevents duplicate adds; verified by the no-duplicate-uri assertion in Task 3.
- **Best-effort:** `syncJourneyPlaylist` catches everything and audits `spotify.playlist_error`; the analyze call site is after queue/session are saved, so playback is never affected.
- **No placeholders.**
