# Journey Spotify Playlist — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** `packages/core`, `packages/spotify`, `apps/api` (auth, db, journey service, routes), `apps/web`.

## Goal

Automatically create a private Spotify playlist for each Spotify journey and extend it
dynamically as the curated soundtrack grows, so the trip's music can be replayed later.

## Decisions

- **Content:** every curated track the engine surfaces for the journey (the tracks already
  marked `addedToPlaylist`), not only the ones actually heard.
- **Approach A:** mirror the curated set into a per-journey playlist, extended on every analyze.
- **Visibility:** private playlist.
- **Re-auth:** requires the new `playlist-modify-private` scope — the user reconnects Spotify once.
- **Additive only:** does not change playback, skip, or the no-repeat selection logic.

## Section 1 — Data model & scope

- **Scope:** add `playlist-modify-private` to `SPOTIFY_SCOPES` in `apps/api/src/auth/spotifyAuth.ts`.
  Update the exact-scope assertion in `apps/api/test/spotify.test.ts`.
- **Adapter** (`packages/spotify/src/index.ts`): add to `SpotifyAdapter`
  `addTracksToPlaylist?(args: { accessToken: string; playlistId: string; uris: string[] }): Promise<void>`.
  - `OfficialSpotifyAdapter`: `POST {baseUrl}/playlists/{playlistId}/tracks` with body `{ uris }`,
    using the existing `request(..., { parseJson: false })` (response snapshot is ignored). No-op
    when `uris` is empty.
  - `MockSpotifyAdapter`: records calls (for tests), returns void. `createPlaylist` already exists
    on both adapters.
- **JourneyRecord** (`packages/core`): add `spotifyPlaylistId?: string`, `spotifyPlaylistUrl?: string`.
- **DB** (`apps/api/src/db/database.ts`): add `spotify_playlist_id TEXT`, `spotify_playlist_url TEXT`
  to the `journeys` CREATE TABLE and via `tryAddColumn`; add
  `saved_to_playlist INTEGER NOT NULL DEFAULT 0` to `resolved_tracks` (CREATE TABLE + `tryAddColumn`).
- **Store** (`apps/api/src/db/store.ts`):
  - `createJourney` inserts the two playlist columns (nullable); `mapJourney` reads them.
  - `updateJourneySpotifyPlaylist(journeyId, playlistId, playlistUrl?)`.
  - `listResolvedTracks` returns `savedToPlaylist: boolean` (from `saved_to_playlist`).
  - `markTracksSavedToPlaylist(ids: string[])` sets `saved_to_playlist = 1`.

`saved_to_playlist` is deliberately separate from `addedToPlaylist` (which only means "entered the
playback buffer" and drives no-repeat). Conflating them would break either feature.

## Section 2 — Service flow (lazy create + dynamic extend)

In `apps/api/src/journeys/journeyService.ts`:

- `ensureJourneySpotifyPlaylist(journey): Promise<string | undefined>` — only for `provider === "spotify"`.
  If the adapter lacks `createPlaylist` or the journey already has `spotifyPlaylistId`, returns the
  existing id. Otherwise creates a **private** playlist named
  `` `AI Journey DJ — ${destination} · ${date}` `` (date = `journey.createdAtIso` sliced to `YYYY-MM-DD`),
  description `` `Telemetry-aware soundtrack generated for ${destination}.` ``, stores id + url via
  `updateJourneySpotifyPlaylist`, audits `spotify.playlist_created`, and returns the id.
- `syncJourneyPlaylist(journey, accessToken): Promise<void>` — collects resolved Spotify tracks where
  `addedToPlaylist && !savedToPlaylist && providerUri`, in `created_at` order. If none, returns. Else
  ensures the playlist exists, calls `addTracksToPlaylist` in batches of ≤100 uris, then
  `markTracksSavedToPlaylist` for the added track ids. Wrapped in try/catch: on any error it audits
  `spotify.playlist_error` and returns (never throws; tracks stay unmarked and retry next analyze).
- Call `syncJourneyPlaylist(journey, accessToken)` near the end of `analyzeSpotifyJourney`, after the
  existing `markTracksAdded(...)` + `saveSession(...)`, reusing the already-fetched `accessToken`.
- Mock mode (`SPOTIFY_MOCK`): the mock adapter's `createPlaylist`/`addTracksToPlaylist` make this work
  end-to-end (mock ids), so the playlist link appears in demo and the flow is fully testable.

## Section 3 — UI

- `apps/web/src/lib/api.ts`: add `spotifyPlaylistId?: string`, `spotifyPlaylistUrl?: string` to the
  `Journey` interface.
- `apps/web/src/App.tsx`: in the cockpit transport row, when `detail.journey.spotifyPlaylistUrl` is
  set, render a discreet link button (lucide `ListMusic` icon, label "Playlist") that opens the URL in
  a new tab (`target="_blank" rel="noreferrer"`). No layout disruption when absent.

## Section 4 — Error handling & edge cases

- All playlist operations are best-effort and isolated from playback: a failed create/add audits
  `spotify.playlist_error` and never breaks the journey, queue, or skip.
- Idempotent: `saved_to_playlist` prevents duplicate adds across repeated analyses; a failed add
  leaves tracks unmarked so the next analyze retries them.
- Rate limit (429) on add → caught, tracks stay unmarked, retried next analyze.
- No new external calls beyond create-once + incremental adds; no change to generation, resolution,
  selection, or skip.

## Testing (TDD)

- **spotify:** `addTracksToPlaylist` (Official) posts to `/playlists/{id}/tracks` with the uris body;
  Mock records the call. Empty uris → no request.
- **store:** journey playlist fields round-trip via `createJourney`/`updateJourneySpotifyPlaylist`;
  `saved_to_playlist` toggled by `markTracksSavedToPlaylist` and surfaced by `listResolvedTracks`.
- **api integration:** starting a Spotify journey sets `journey.spotifyPlaylistId`/`Url` and the mock
  adapter receives `addTracksToPlaylist` with the resolved track uris; a second analyze adds **no**
  duplicates (all already `saved_to_playlist`).
- **scope:** the login-URL scope assertion includes `playlist-modify-private`.
- Full existing suite stays green.

## Out of scope

- Public/collaborative playlists; playlist cover art; cross-journey "all trips" playlist.
- Removing tracks; reordering; syncing playlist edits back from Spotify.
- The TIDAL path (already has its own playlist mechanism).
