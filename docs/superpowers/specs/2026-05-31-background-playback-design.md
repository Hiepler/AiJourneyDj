# Background Playback Survival (Tesla) — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** `apps/web` only (frontend). No backend/API changes.

## Problem

In the Tesla in-car browser, playback works while the browser is foregrounded. When the browser is
minimized, audio stops after ~1–2 minutes — the embedded Chromium freezes/throttles the backgrounded
page, and the Spotify Web Playback SDK (whose audio lives in a cross-origin iframe) can no longer
advance/keep playing. Separately, the Tesla **Miniplayer** can pause our playback but its **skip**
buttons do nothing, because we never registered MediaSession `nexttrack`/`previoustrack` handlers.

## Research (known facts)

- The Spotify Web Playback SDK stalls in backgrounded/minimized tabs (browser tab suspension); it
  resumes when foregrounded.
- Tesla supports background browser audio **via the Miniplayer**, provided the browser recognizes the
  page as actively playing media.
- Documented workaround: a silent looping `<audio>` element tied to the player + the **MediaSession
  API** (metadata + action handlers) to keep the page treated as active media and to power OS/Miniplayer
  controls.
- Controlling Tesla's native Spotify as a Connect device is unreliable → rejected.

## Section 1 — Silent keepalive audio

New module `apps/web/src/backgroundAudio.ts` exposes a keepalive controller around a hidden, looping,
**silent** `<audio>` element (tiny embedded data-URI source). It is started inside the same user
gesture that starts Spotify playback (so autoplay is permitted) and mirrors the player state
(`play()` when playing, `pause()` when paused). Keeping a same-origin media element actively playing
makes the browser/Tesla treat the page as "playing media", reducing background freezing and feeding
the Miniplayer. The controller takes an injectable element factory so it is unit-testable.

## Section 2 — MediaSession (also fixes Miniplayer skip)

A `applyMediaSession(nav, { track, playbackState, handlers })` helper sets, when
`navigator.mediaSession` exists:
- `metadata = new MediaMetadata(buildMediaMetadata(track))` where `buildMediaMetadata` maps our
  resolved track → `{ title, artist, album?, artwork: [{ src: albumArtUrl }] }` (pure function).
- `playbackState` = `"playing" | "paused"`.
- action handlers: `play`, `pause` → our `togglePlayPause`; `nexttrack` → `skipTrack("next")`;
  `previoustrack` → `skipTrack("previous")`. This makes the Tesla Miniplayer's skip buttons work.

`MediaMetadata` is referenced via the global; the helper guards on its presence so it is a no-op in
unsupported environments (and testable with a fake `navigator.mediaSession` + `MediaMetadata`).

## Section 3 — Resume-recovery

On `document.visibilitychange` → visible (and via the existing periodic journey poll as a heartbeat),
if playback appears stalled, re-assert it: ensure the SDK device is connected and re-sync through the
backend (which already commands the exact track via `startPlayback`). Best-effort; never throws.
Implemented as a small `resumePlaybackIfStalled()` path reusing existing `ensureSpotifyDevice` +
`api.registerSpotifyDevice({ syncOnly: true })` + `startSpotifyBrowserPlayback`.

## Section 4 — Wiring & boundaries

- `backgroundAudio.ts`: `createSilentKeepAlive(makeElement?)`, `buildMediaMetadata(track)`,
  `applyMediaSession(nav, opts)` — focused, injectable, unit-testable.
- `App.tsx`: when `activeTrack` / play-state changes (existing `onPlaybackChange`, `isPaused`,
  `detail.playbackSession.activeTrack`), update MediaSession + drive the keepalive; register the
  action handlers once the player exists; add the `visibilitychange` listener.
- No backend changes; no change to the no-repeat engine, skip authority, or playlist features.

## Section 5 — Error handling, limits & testing

- All of it is best-effort and guarded: missing `mediaSession`/`MediaMetadata`, blocked silent-audio
  autoplay, and stalled-state recovery failures are swallowed (logged), never breaking the app.
- **Honest limitation:** Section 2 (Miniplayer skip) is verifiable in any Chromium and is a reliable
  fix. Sections 1+3 (preventing the freeze) are the established community workarounds but are **not a
  100% guarantee** on Tesla's embedded browser — requires on-device verification.
- **Tests (TDD):** `buildMediaMetadata` (pure mapping incl. missing artwork); `applyMediaSession`
  against a fake `navigator.mediaSession` (asserts metadata, `playbackState`, and that
  `nexttrack`/`previoustrack`/`play`/`pause` handlers are registered and invoke the wired callbacks);
  `createSilentKeepAlive` with a fake element (play/pause/dispose delegate correctly).

## Out of scope

- Backend/API changes; Spotify Connect / native-Tesla-Spotify control; Wake Lock (low value here);
  iOS background playback (unsupported by the SDK).
