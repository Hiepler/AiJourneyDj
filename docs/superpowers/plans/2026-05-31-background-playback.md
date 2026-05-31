# Background Playback Survival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Spotify playback alive when the Tesla browser is minimized, and make the Tesla Miniplayer's skip buttons work, via a silent keepalive audio element + the MediaSession API + a resume-on-visible recovery.

**Architecture:** A new focused, injectable, unit-tested `apps/web/src/backgroundAudio.ts` module (metadata builder, MediaSession applier, silent keepalive controller). `App.tsx` wires it to existing playback signals using refs to avoid stale closures. Frontend-only; no backend changes.

**Tech Stack:** React + Vite + Vitest, Spotify Web Playback SDK, Web MediaSession API.

---

## File Structure

- **Create** `apps/web/src/backgroundAudio.ts` — `buildMediaMetadata`, `applyMediaSession`, `createSilentKeepAlive`.
- **Create** `apps/web/src/backgroundAudio.test.ts` — unit tests.
- **Modify** `apps/web/src/App.tsx` — keepalive arming, MediaSession effect, visibility-resume.

All commands run from repo root `/Users/benedikthiepler/projects/priv/tidal`.

---

## Task 1: `backgroundAudio.ts` module

**Files:**
- Create: `apps/web/src/backgroundAudio.ts`
- Test: `apps/web/src/backgroundAudio.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/backgroundAudio.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { applyMediaSession, buildMediaMetadata, createSilentKeepAlive } from "./backgroundAudio.js";

describe("buildMediaMetadata", () => {
  it("maps a track to MediaMetadata init fields", () => {
    expect(buildMediaMetadata({ title: "Wait", artist: "M83", albumArtUrl: "https://img/x" })).toEqual({
      title: "Wait",
      artist: "M83",
      album: undefined,
      artwork: [{ src: "https://img/x" }]
    });
  });

  it("falls back gracefully with no track / no artwork", () => {
    const meta = buildMediaMetadata(undefined);
    expect(meta.title).toBe("AI Journey DJ");
    expect(meta.artwork).toEqual([]);
  });
});

describe("applyMediaSession", () => {
  it("sets metadata, playbackState and skip handlers", () => {
    const setActionHandler = vi.fn();
    const session: Record<string, unknown> & { setActionHandler: typeof setActionHandler } = {
      metadata: null,
      playbackState: "none",
      setActionHandler
    };
    const next = vi.fn();
    const prev = vi.fn();

    applyMediaSession(
      { mediaSession: session },
      { metadata: { title: "Wait" }, playbackState: "playing", handlers: { nexttrack: next, previoustrack: prev } }
    );

    expect(session.metadata).toEqual({ title: "Wait" });
    expect(session.playbackState).toBe("playing");
    const actions = setActionHandler.mock.calls.map((call) => call[0]);
    expect(actions).toContain("nexttrack");
    expect(actions).toContain("previoustrack");
    // The registered nexttrack handler invokes our callback (this is what the Miniplayer skip calls).
    const nextHandler = setActionHandler.mock.calls.find((call) => call[0] === "nexttrack")?.[1];
    nextHandler?.();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when mediaSession is unavailable", () => {
    expect(() => applyMediaSession({}, { metadata: {}, playbackState: "paused", handlers: {} })).not.toThrow();
  });
});

describe("createSilentKeepAlive", () => {
  it("plays, pauses and disposes the injected element", () => {
    const el = { loop: false, play: vi.fn(), pause: vi.fn(), remove: vi.fn() };
    const keepAlive = createSilentKeepAlive(() => el);
    expect(el.loop).toBe(true);

    keepAlive.play();
    expect(el.play).toHaveBeenCalled();
    keepAlive.pause();
    expect(el.pause).toHaveBeenCalled();
    keepAlive.dispose();
    expect(el.remove).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/web/src/backgroundAudio.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `apps/web/src/backgroundAudio.ts`:

```ts
export interface MediaMetadataInit {
  title: string;
  artist: string;
  album?: string;
  artwork: { src: string }[];
}

/** Pure mapping from a resolved track to MediaMetadata init fields. */
export function buildMediaMetadata(
  track: { title: string; artist: string; albumArtUrl?: string } | undefined
): MediaMetadataInit {
  return {
    title: track?.title ?? "AI Journey DJ",
    artist: track?.artist ?? "",
    album: undefined,
    artwork: track?.albumArtUrl ? [{ src: track.albumArtUrl }] : []
  };
}

export interface MediaSessionHandlers {
  play?: () => void;
  pause?: () => void;
  nexttrack?: () => void;
  previoustrack?: () => void;
}

interface MediaSessionLike {
  metadata: unknown;
  playbackState: string;
  setActionHandler(action: string, handler: (() => void) | null): void;
}

interface NavigatorLike {
  mediaSession?: MediaSessionLike;
}

/** Sets MediaSession metadata + state + handlers. No-op (and never throws) when unsupported. */
export function applyMediaSession(
  nav: NavigatorLike,
  opts: { metadata: unknown; playbackState: "playing" | "paused"; handlers: MediaSessionHandlers }
): void {
  const session = nav.mediaSession;
  if (!session) return;
  try {
    session.metadata = opts.metadata;
    session.playbackState = opts.playbackState;
    (["play", "pause", "nexttrack", "previoustrack"] as const).forEach((action) => {
      try {
        session.setActionHandler(action, opts.handlers[action] ?? null);
      } catch {
        // Some browsers throw for unsupported actions — ignore that action.
      }
    });
  } catch {
    // mediaSession property assignment unsupported — ignore.
  }
}

export interface KeepAliveElement {
  loop: boolean;
  play(): Promise<void> | void;
  pause(): void;
  remove?(): void;
}

export interface SilentKeepAlive {
  play: () => void;
  pause: () => void;
  dispose: () => void;
}

/**
 * Keeps a same-origin, silent, looping audio element "playing" so the embedded browser treats the
 * page as active media (less background freezing; feeds the Tesla Miniplayer). Element is injectable
 * for tests; the default builds a generated silent WAV (valid + inaudible).
 */
export function createSilentKeepAlive(makeElement: () => KeepAliveElement = defaultSilentElement): SilentKeepAlive {
  const element = makeElement();
  element.loop = true;
  return {
    play: () => {
      void Promise.resolve(element.play()).catch(() => undefined);
    },
    pause: () => element.pause(),
    dispose: () => {
      element.pause();
      element.remove?.();
    }
  };
}

function defaultSilentElement(): KeepAliveElement {
  const audio = new Audio(silentWavUrl());
  audio.loop = true;
  audio.volume = 0;
  return audio;
}

/** Builds a 1s mono 8-bit silent WAV object URL (valid + reliably playable). */
function silentWavUrl(): string {
  const sampleRate = 8000;
  const numSamples = sampleRate; // 1 second
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);
  const writeStr = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate (1 byte/sample)
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits/sample
  writeStr(36, "data");
  view.setUint32(40, numSamples, true);
  for (let i = 0; i < numSamples; i += 1) view.setUint8(44 + i, 128); // 8-bit silence
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run apps/web/src/backgroundAudio.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/backgroundAudio.ts apps/web/src/backgroundAudio.test.ts
git commit -m "feat(web): background-audio module (keepalive + MediaSession)"
```

---

## Task 2: Wire keepalive + MediaSession + resume into `App.tsx`

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Add the import**

In `apps/web/src/App.tsx`, after the `./spotifyPlayer.js` import block (where `MOOD_PRESETS`/`buildContextPills` are imported), add:

```ts
import { applyMediaSession, buildMediaMetadata, createSilentKeepAlive, type SilentKeepAlive } from "./backgroundAudio.js";
```

- [ ] **Step 2: Add refs for the keepalive and live playback actions**

Find the existing refs block:

```ts
  const playerRef = useRef<SpotifyPlayerInstance | null>(null);
  const recoveryAttemptedFor = useRef<string | undefined>(undefined);
```

Add right after it:

```ts
  const keepAliveRef = useRef<SilentKeepAlive | null>(null);
  // Holds the latest playback actions so MediaSession / visibility handlers never call stale closures.
  const playbackActionsRef = useRef({
    next: () => {},
    prev: () => {},
    toggle: () => {},
    resume: () => {}
  });

  function armKeepAlive() {
    // Must be created inside a user gesture (button click) so autoplay permits the silent element.
    if (!keepAliveRef.current) {
      keepAliveRef.current = createSilentKeepAlive();
    }
    keepAliveRef.current.play();
  }
```

- [ ] **Step 3: Arm the keepalive when playback starts (within user gestures)**

In `startJourney`, find:

```ts
      if (playerRef.current) {
        await startSpotifyBrowserPlayback(playerRef.current);
      }
      await refreshShell();
```

Replace with:

```ts
      if (playerRef.current) {
        await startSpotifyBrowserPlayback(playerRef.current);
        armKeepAlive();
      }
      await refreshShell();
```

In `playAudio`, find:

```ts
      if (playerRef.current) {
        await startSpotifyBrowserPlayback(playerRef.current);
        setSpotifyStatus("ready");
      }
```

Replace with:

```ts
      if (playerRef.current) {
        await startSpotifyBrowserPlayback(playerRef.current);
        armKeepAlive();
        setSpotifyStatus("ready");
      }
```

In `togglePlayPause`, find:

```ts
    setIsPaused((previous) => (previous === undefined ? false : !previous));
    try {
      await player.togglePlay();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
```

Replace with:

```ts
    setIsPaused((previous) => (previous === undefined ? false : !previous));
    armKeepAlive();
    try {
      await player.togglePlay();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
```

- [ ] **Step 4: Mirror keepalive play/pause to the player state + keep actions ref current**

Add these effects near the other `useEffect`s (e.g. directly after the `useEffect` that polls `api.journey` every 6000ms). `playing`, `skipTrack`, `togglePlayPause`, `playAudio` are already defined above in the component:

```ts
  useEffect(() => {
    const keepAlive = keepAliveRef.current;
    if (!keepAlive) return;
    if (playing) keepAlive.play();
    else keepAlive.pause();
  }, [playing]);

  useEffect(() => {
    playbackActionsRef.current = {
      next: () => void skipTrack("next"),
      prev: () => void skipTrack("previous"),
      toggle: () => void togglePlayPause(),
      resume: () => void playAudio()
    };
  });
```

- [ ] **Step 5: Update MediaSession when the track or play-state changes**

Add this effect after the effects from Step 4:

```ts
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const metadata =
      typeof MediaMetadata !== "undefined" ? new MediaMetadata(buildMediaMetadata(heroTrack)) : buildMediaMetadata(heroTrack);
    applyMediaSession(navigator as never, {
      metadata,
      playbackState: playing ? "playing" : "paused",
      handlers: {
        play: () => playbackActionsRef.current.toggle(),
        pause: () => playbackActionsRef.current.toggle(),
        nexttrack: () => playbackActionsRef.current.next(),
        previoustrack: () => playbackActionsRef.current.prev()
      }
    });
  }, [heroTrack?.id, heroTrack?.title, playing]);
```

- [ ] **Step 6: Resume playback when the page becomes visible again**

Add this effect after Step 5's effect:

```ts
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (!activeJourneyId || !isSpotifyJourney || health?.spotifyMock) return;
      // After the embedded browser un-freezes a backgrounded page, re-assert playback.
      playbackActionsRef.current.resume();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [activeJourneyId, isSpotifyJourney, health?.spotifyMock]);
```

- [ ] **Step 7: Dispose the keepalive when the journey stops**

In `stop`, find:

```ts
      playerRef.current?.disconnect();
      playerRef.current = null;
```

Replace with:

```ts
      playerRef.current?.disconnect();
      playerRef.current = null;
      keepAliveRef.current?.dispose();
      keepAliveRef.current = null;
```

- [ ] **Step 8: Verify it typechecks**

Run: `npm run typecheck -w @ai-journey-dj/web`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): keep playback alive in background + MediaSession skip controls"
```

---

## Task 3: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck all workspaces**

Run: `npm run typecheck --workspaces`
Expected: exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `./node_modules/.bin/vitest run`
Expected: all files pass (previous total + 5 new = 106), 0 failures.

- [ ] **Step 3: Lint the changed files**

Run: `npx eslint apps/web/src/backgroundAudio.ts apps/web/src/App.tsx`
Expected: `No issues found`.

- [ ] **Step 4: Commit any lint fixes (only if Step 3 required changes)**

```bash
git add -A
git commit -m "chore(web): lint cleanup for background playback"
```

---

## Self-Review Notes

- **Spec coverage:** §1 keepalive (Task 1 `createSilentKeepAlive` + Task 2 arming/mirroring), §2 MediaSession incl. skip handlers (Task 1 `applyMediaSession`/`buildMediaMetadata` + Task 2 Step 5), §3 resume (Task 2 Step 6), §4 wiring/boundaries (Task 2), §5 tests (Task 1 + Task 3). Covered.
- **Type consistency:** `buildMediaMetadata`, `applyMediaSession`, `createSilentKeepAlive`, `SilentKeepAlive` defined in Task 1 and used identically in Task 2. `playbackActionsRef` shape (next/prev/toggle/resume) consistent between Steps 2, 4, 5, 6.
- **Stale-closure safety:** MediaSession/visibility handlers call through `playbackActionsRef.current`, refreshed every render (Step 4), so they always invoke the current `skipTrack`/`togglePlayPause`/`playAudio`.
- **Gesture safety:** keepalive is created only inside click handlers (`armKeepAlive` from startJourney/playAudio/togglePlayPause); the `[playing]` effect only play/pauses an already-created element.
- **Honest limit:** Section 2 (Miniplayer skip) is reliably fixed and unit-tested; Sections 1+3 are best-effort against embedded-browser freezing and need on-device confirmation.
- **No placeholders.**
```
