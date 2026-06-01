# Spotify Playback Reconciliation (External-Skip Sync)

**Date:** 2026-06-01
**Status:** Approved (design) — pending implementation plan

## Problem

When the user skips tracks in the **native Tesla Spotify miniplayer** (Spotify
Connect), playback advances on Spotify's side, but the backend never learns
about it. The web app shows the backend's own `playback_sessions` model, which
does not change on external skips — so after 5 native skips the web app still
lists the same 5 tracks, and no skip-driven refill happens.

### Root cause

The playback pipeline is fire-and-forget:
1. Web "Play" sets a queue on Spotify and stores the backend's *model* of it
   (`playback_sessions.queued_track_ids` / `played_track_ids`).
2. The web app renders that backend model, **not** the real Spotify state.
3. The backend **never polls** Spotify's real playback state.
   `SpotifyAdapter.getPlaybackState()` exists but has **zero callers** in
   `apps/api`.
4. The 60s worker (`maybeRefreshActiveJourneys`) only refills when
   `queuedTrackIds.length < 5` or the ~12-min time window elapses — and that
   counter does not shrink on native skips.

Result: backend model drifts from reality; display is stale; refill is not
skip-responsive.

## Goal

Detect external (Spotify Connect / native miniplayer) skips server-side,
reconcile the backend session to reality, and refill curated tracks so the
journey runs continuously — independent of whether the web app is in the
foreground. (User-selected goal: "display sync + automatic refill".)

## Non-goals

- No Spotify push/webhooks (they don't exist for playback) — detection is via
  polling `GET /me/player`.
- No fighting the user when they deliberately play something off-journey
  (see Off-journey behavior).
- No change to the Tesla telemetry pipeline.

## Approach (chosen: A, with B's "keep N ahead" refill)

A server-side `spotifyPlaybackPoller` (twin of `teslaFleetPoller`) polls the
real playback state on an adaptive cadence and calls a new
`JourneyService.reconcileSpotifyPlayback(journeyId)` that reconciles the session
and refills via the existing `addToQueue` append path. The web app's existing
4s detail poll then renders the corrected session — no new web endpoint needed.

Rejected:
- **B alone** ("only keep N ahead"): still needs current-track sync, so it's
  half of A anyway, with a less accurate history.
- **C** (web-driven polling): doesn't run when the web app is backgrounded —
  which is exactly the native-miniplayer case.

## Components & data flow

New file `apps/api/src/playback/spotifyPlaybackPoller.ts`:
- `startSpotifyPlaybackPoller(config, store, spotifyAuth, journeyService, logger)`
- Self-scheduling `setTimeout` loop (not `setInterval`) so each tick picks the
  next interval. Active (`is_playing`) → 5s; paused/idle/off-journey → 30s.
- Runs only when `SPOTIFY_PLAYBACK_POLL_ENABLED` and an active Spotify journey
  exists; otherwise an empty 30s idle tick.

New method `JourneyService.reconcileSpotifyPlayback(journeyId)` — the core.
Reuses `spotifyAdapter.getPlaybackState()`, `pickSpotifyPlaybackTracks`,
`queueTracksForBuffer`, and `syncSpotifyPlayback({ shouldStart: false })`
(its `addToQueue` append path, confirmed at journeyService.ts ~L976).

```
Poller (5/30s) ─► reconcileSpotifyPlayback(journeyId)
   1. getPlaybackState()  → real current track URI + is_playing
   2. compare with session model [activeTrack, ...queued]
   3. correct session (played/active/queued)
   4. refill if needed → addToQueue on Spotify
   5. saveSession + audit
        │ web 4s detail poll
        ▼
   web app renders corrected session (display self-heals)
```

## Reconciliation algorithm

```
reconcileSpotifyPlayback(journeyId):
  1. session = getPlaybackSession(journeyId)
     – not an active Spotify journey / no device → return
  2. state = getPlaybackState()
     – nothing playing (empty / is_playing=false) → status="idle", return (poller idles 30s)
  3. currentUri = state.item.uri
     model = [session.activeTrack, ...session.queuedTrackIds → tracks]   // ordered
     idx = model.findIndex(t => t.providerUri === currentUri)
  4. cases:
     a) idx === 0   → same track still playing → update lastHeartbeat, return (idempotent)
     b) idx > 0     → SKIP detected:
          played += model[0 .. idx-1]
          active  = model[idx]
          queued  = model[idx+1 ..]
     c) idx === -1  → OFF-JOURNEY (foreign track):
          status = "external"
          display active = real track (title/artist from state.item)
          NO refill. Poller idles 30s.
          resumes automatically when currentUri matches a journey track again,
          or when the user presses "Play" in the web app.
  5. if case (b) and queued.length < SPOTIFY_REFILL_THRESHOLD → refill (below)
  6. saveSession(played, active, queued, status) + audit("spotify.playback_reconciled", …)
```

Properties:
- `playedTrackIds` grows correctly → web "skip back" keeps working.
- Idempotent: same track playing (case a) → no double refill.
- Off-journey resumes with no manual reset (case b fires again on re-match).
- Robust to an empty model (fresh journey, no device) → return.

## Refill + cost throttle

On a detected skip with `queued.length < SPOTIFY_REFILL_THRESHOLD` (default 3):

```
refillSpotifyQueue(journey, session):
  1. pool = already-generated resolved tracks not in played/queued/active
  2. enough in pool (≥ need up to target 5)?
       YES → fill from pool, NO Gemini call
       NO  → only if (now - lastGeneratedAt) ≥ SPOTIFY_REFILL_MIN_INTERVAL:
                analyzeJourney(journeyId, "skip-refill")   // generates via Gemini
             else: fill with whatever is available (throttle holds)
  3. push new tracks via syncSpotifyPlayback({ shouldStart:false })
     → addToQueue append path → appears in Spotify up-next (native miniplayer)
```

Cost protection (the key constraint is Gemini cost, not Spotify rate limits):

| Mechanism | Effect |
|---|---|
| Pool recycling | routine top-up without an LLM call |
| `SPOTIFY_REFILL_MIN_INTERVAL` (60s) | ≤ 1 generation/min regardless of skip rate |
| Adaptive poll | paused/idle → 30s, fewer reconcile cycles |
| Threshold 3 (not 5) | refill triggered less often |

Spotify rate limits are a non-issue: 5s polling = 12 calls/min vs Spotify's
~180/min rolling window. 10h drive ≤ 60 Gemini generations worst case,
realistically far fewer due to the pool buffer.

## Config (env.ts, all defaulted)

```
SPOTIFY_PLAYBACK_POLL_ENABLED=true
SPOTIFY_PLAYBACK_POLL_ACTIVE_SECONDS=5
SPOTIFY_PLAYBACK_POLL_IDLE_SECONDS=30
SPOTIFY_REFILL_THRESHOLD=3
SPOTIFY_REFILL_MIN_INTERVAL_SECONDS=60
```

## Lifecycle

- Bootstrap in `index.ts`: start the poller alongside the Tesla poller; clean
  up in `SIGTERM`.
- Coexists with the existing 60s worker (baseline time-window refresh). Both
  write the same session via `saveSession` + `pickSpotifyPlaybackTracks`; the
  reconciler is the finer, skip-driven layer. No conflict.

## Web display

- No new endpoint — the corrected session flows through the existing 4s detail
  poll. The list / "now playing" / "skip back" self-heal.
- Small addition: when `status === "external"`, a subtle "Externe Wiedergabe"
  chip (DJ paused curation). Reuses the existing chip pattern.

## Error handling (best-effort, never crash a journey)

- `getPlaybackState` 401 / token → silent refresh via existing `getAccessToken`,
  else skip the tick.
- 429 rate limit → skip this tick, next in 30s.
- No device / Spotify 5xx → degrade, no throw (matches existing code).
- All via `logger.warn({...}, "spotify.reconcile_error")`, no stack spam.

## Testing (Vitest, pure logic with fakes — no real Spotify calls)

1. Skip by 1: played +1, active/queued shifted.
2. Skip by 3: three to played, refilled correctly.
3. Same track still playing → no change (idempotent).
4. Off-journey (foreign URI) → status "external", NO refill.
5. Off-journey → journey URI again → resumes.
6. Refill throttle: two fast skips → only ONE Gemini call (pool/interval holds).
7. Adaptive cadence: playing → 5s, idle/external → 30s.
8. Poller smoke: no device / no journey → no throw.

## Affected files

- New: `apps/api/src/playback/spotifyPlaybackPoller.ts` + test
- Extended: `apps/api/src/journeys/journeyService.ts` (reconcile + refill),
  `apps/api/src/config/env.ts`, `apps/api/src/index.ts`,
  `apps/api/src/db/store.ts` (allow `status="external"` if needed),
  web `apps/web/src/App.tsx` + `apps/web/src/lib/api.ts` (external chip).
