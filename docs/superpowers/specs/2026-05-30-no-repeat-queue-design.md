# No-Repeat Queue Engine — Design

**Date:** 2026-05-30
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** `packages/core`, `packages/spotify`, `apps/api` (journey service). Backend only.

## Problem

On a Spotify journey the "Up next" buffer keeps surfacing the same songs, and after
skipping forward the newly added tracks are ones that were just played. Verified root cause
(three interacting defects in the Spotify path):

1. **Selection ignores play history.** `queueTracksForBuffer` (packages/spotify) excludes only
   the active track + currently-queued tracks — not `playedTrackIds` and not `addedToPlaylist`.
   It iterates stored tracks in creation order (oldest first), so each refill re-picks the
   earliest tracks, which are exactly the ones already played.
2. **Deterministic oldest-first order** → the buffer is the same set every refill.
3. **Pool reuse at a stable phase** recycles the same small resolved set, combined with (1) the
   already-played ones.

The cost gate computes `inUseIds = played ∪ queued` to decide *whether* to generate, but the
actual selection (`queueTracksForBuffer`) does not honor that set — the inconsistency is the bug.
(The TIDAL path uses `selectRollingBatch` with an `addedToPlaylist` exclusion, so it is unaffected.)

## Policy (decided)

Each song plays **at most once per journey**. When the unused pool can no longer fill the
buffer, generate fresh AI candidates so a long drive stays fresh without repeats. Per-journey
scope only (a new journey may replay songs from a previous one).

## Section 1 — Shared song key (`packages/core`)

Add two pure functions:

- `normalizeBaseTitle(title: string): string` — lowercases, removes bracketed segments
  (`(...)`, `[...]`), strips a trailing version qualifier after ` - ` or ` / ` when it matches a
  conservative word list (`live`, `remaster`, `remastered`, `extended`, `radio edit`, `mono`,
  `stereo`, `deluxe`, `acoustic`, `version`, `intro`/`extended intro`), then applies
  `normalizeText`. Qualifiers like `remix` are intentionally **not** stripped (a remix is a
  distinct track).
- `songKey(artist: string, title: string): string` → `` `${normalizeText(artist)}::${normalizeBaseTitle(title)}` ``.

This makes "Rein Me In" and "Rein Me In - Live At London Stadium / Extended Intro Version"
collapse to the same key.

## Section 2 — Selection excludes consumed tracks (`packages/spotify`)

Extend `queueTracksForBuffer` args with:

- `excludeProviderTrackIds?: Set<string>` (consumed provider track ids), and
- `excludeSongKeys?: Set<string>` (consumed song keys), with the function computing each
  candidate's key via `songKey(track.artist, track.title)`.

A track is skipped when its provider id is in `excludeProviderTrackIds` **or** its song key is in
`excludeSongKeys` (in addition to the existing active/already-queued and playable/uri checks).
The existing `alreadyQueuedProviderIds`/`activeProviderTrackId` behavior is preserved.

In `analyzeSpotifyJourney`, build the **consumed set** once:
`consumed = stored.filter(t => t.addedToPlaylist || playedIds.has(t.id) || queuedIds.has(t.id) || t.id === activeTrack?.id)`.
Derive `consumedProviderIds = Set(consumed.providerTrackId)` and
`consumedSongKeys = Set(consumed.map(t => songKey(t.artist, t.title)))`, and pass both into every
`queueTracksForBuffer` call (initial fill and the fallback top-up).

## Section 3 — Generation-side dedup (`apps/api`)

When generating candidates (`generateAndStoreCandidates` / the analyze flow), filter freshly
generated candidates whose `songKey` is already in `consumedSongKeys` **before** resolving them on
Spotify (on top of the existing within-batch dedup in `balanceCandidates`). This saves Spotify
search calls and guarantees the AI never re-surfaces a consumed song. The consumed keys are passed
into the generation step.

## Section 4 — Fresh pool growth

Update the cost gate's `unusedPool` to use the same consumed set (currently `inUseIds = played ∪
queued`; extend to include `addedToPlaylist` and song-key equivalence). When every generated song
is consumed, `mustGenerate` becomes true and the existing AI generation runs, refilling with new
songs. No change to generation cadence otherwise (cost stays controlled — generate only when the
unused pool cannot fill the buffer).

## Section 5 — Error handling & edge cases

- If generation cannot find anything new (finite catalog / mock), the buffer may hold fewer than 5
  tracks and the session status is `degraded`. This is acceptable — never repeat is preferred over
  filling with a played song.
- Pure DB reads + in-memory filtering; no new external calls, no schema changes (`addedToPlaylist`
  already marks every track that entered the buffer).
- Playback/skip contracts (including the `clientControlled` skip path) are unchanged.

## Testing (TDD)

- **core:** `normalizeBaseTitle` strips brackets + version qualifiers but keeps remixes distinct;
  `songKey` collapses version variants of the same song and separates genuinely different songs.
- **spotify:** `queueTracksForBuffer` skips tracks whose provider id is in `excludeProviderTrackIds`
  or whose song key is in `excludeSongKeys`, while still returning fresh tracks up to the target.
- **api integration:** start a journey, skip forward several times; assert the sequence of active
  tracks contains no duplicate — neither by provider track id nor by song key.
- Full existing suite stays green.

## Out of scope

- Cross-journey de-duplication (history across separate drives).
- Improving Spotify search match quality (why a live/extended version was matched in the first place).
- The TIDAL path (already de-duplicates via `selectRollingBatch`).
