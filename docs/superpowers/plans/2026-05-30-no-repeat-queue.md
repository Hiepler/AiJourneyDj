# No-Repeat Queue Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Spotify "Up next" buffer from re-surfacing already-played songs (and version variants), so each song plays at most once per journey.

**Architecture:** A shared `songKey` (normalized artist + base title) in core. The Spotify buffer selector excludes a "consumed" set (provider ids + song keys). The journey service builds that consumed set from play history + `addedToPlaylist`, uses it for selection, candidate-generation dedup, and the cost gate. No schema changes, no external calls.

**Tech Stack:** TypeScript monorepo, Vitest, node:sqlite, Fastify.

---

## File Structure

- **Modify** `packages/core/src/index.ts` — add `normalizeBaseTitle` + `songKey`.
- **Modify** `packages/core/src/index.test.ts` — unit tests (create file if absent; see Task 1 Step 1).
- **Modify** `packages/spotify/src/index.ts` — `queueTracksForBuffer` gains `excludeProviderTrackIds` + `excludeSongKeys` and de-dupes within the buffer by song key.
- **Modify** `packages/spotify/src/index.test.ts` — unit tests.
- **Modify** `apps/api/src/journeys/journeyService.ts` — build consumed set; wire into gate, generation dedup, selection.
- **Modify** `apps/api/test/journeySkip.test.ts` — integration test (no song surfaces twice).

All commands run from repo root `/Users/benedikthiepler/projects/priv/tidal`.

---

## Task 1: Shared song key in core

**Files:**
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

If `packages/core/src/index.test.ts` does not exist, create it with this content. If it exists, append the `describe` block.

```ts
import { describe, expect, it } from "vitest";

import { normalizeBaseTitle, songKey } from "./index.js";

describe("songKey", () => {
  it("collapses version variants of the same song", () => {
    const studio = songKey("Sam Fender", "Rein Me In");
    const live = songKey("Sam Fender", "Rein Me In (with Olivia Dean) - Live At London Stadium / Extended Intro Version");
    expect(live).toBe(studio);
  });

  it("strips bracketed segments and trailing version qualifiers", () => {
    expect(normalizeBaseTitle("September (Remastered 2014)")).toBe("september");
    expect(normalizeBaseTitle("Wouldn't It Be Nice - Stereo Mix")).toBe("wouldnt it be nice");
    expect(normalizeBaseTitle("Beautiful Day - Acoustic")).toBe("beautiful day");
  });

  it("keeps genuinely different songs and remixes distinct", () => {
    expect(songKey("A", "Song One")).not.toBe(songKey("A", "Song Two"));
    // A remix is a distinct track — must NOT collapse into the original.
    expect(normalizeBaseTitle("Around the World - Acid Remix")).not.toBe(normalizeBaseTitle("Around the World"));
    // Numbered parts are distinct.
    expect(normalizeBaseTitle("Song - Part 2")).not.toBe(normalizeBaseTitle("Song"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run packages/core/src/index.test.ts`
Expected: FAIL — `normalizeBaseTitle`/`songKey` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/index.ts` (after `clampConfidence`):

```ts
const VERSION_QUALIFIER = /\b(live|remaster(?:ed)?|extended|radio edit|mono|stereo|deluxe|acoustic|version|intro)\b/i;

/**
 * Reduces a track title to its "base song" form for de-duplication: drops bracketed segments
 * ((...) / [...]) and a trailing version qualifier after " - " or " / " (Live, Remaster, Extended,
 * Acoustic, …). Remixes and numbered parts are intentionally preserved as distinct songs.
 */
export function normalizeBaseTitle(title: string): string {
  let base = title.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  const separator = base.match(/\s[-/]\s/);
  if (separator && separator.index !== undefined) {
    const tail = base.slice(separator.index);
    if (VERSION_QUALIFIER.test(tail)) {
      base = base.slice(0, separator.index);
    }
  }
  return normalizeText(base);
}

/** Journey-scoped identity for a song: normalized artist + base title. Used to prevent repeats. */
export function songKey(artist: string, title: string): string {
  return `${normalizeText(artist)}::${normalizeBaseTitle(title)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run packages/core/src/index.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/index.test.ts
git commit -m "feat(core): add songKey/normalizeBaseTitle for journey de-duplication"
```

---

## Task 2: Exclude consumed tracks in the buffer selector

**Files:**
- Modify: `packages/spotify/src/index.ts`
- Test: `packages/spotify/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/spotify/src/index.test.ts` inside the existing `describe("spotify playback helpers", ...)` block (before its closing `});`):

```ts
  it("excludes consumed provider ids and song keys, and de-dupes by song key within the buffer", () => {
    const tracks: ResolvedTrack[] = [
      { provider: "spotify", providerTrackId: "played", providerUri: "spotify:track:played", artist: "A", title: "Played Song", matchConfidence: 0.9, matchReason: "x" },
      { provider: "spotify", providerTrackId: "live", providerUri: "spotify:track:live", artist: "A", title: "Played Song - Live", matchConfidence: 0.9, matchReason: "x" },
      { provider: "spotify", providerTrackId: "fresh1", providerUri: "spotify:track:fresh1", artist: "B", title: "Fresh One", matchConfidence: 0.9, matchReason: "x" },
      { provider: "spotify", providerTrackId: "fresh1-dup", providerUri: "spotify:track:fresh1dup", artist: "B", title: "Fresh One (Radio Edit)", matchConfidence: 0.9, matchReason: "x" },
      { provider: "spotify", providerTrackId: "fresh2", providerUri: "spotify:track:fresh2", artist: "C", title: "Fresh Two", matchConfidence: 0.9, matchReason: "x" }
    ];

    const selected = queueTracksForBuffer(tracks, {
      alreadyQueuedProviderIds: new Set<string>(),
      excludeProviderTrackIds: new Set(["played"]),
      excludeSongKeys: new Set([songKey("A", "Played Song")]),
      targetBufferSize: 5
    });

    const ids = selected.map((track) => track.providerTrackId);
    expect(ids).not.toContain("played"); // excluded by provider id
    expect(ids).not.toContain("live"); // excluded by song key (version of a consumed song)
    expect(ids).toContain("fresh1");
    expect(ids).not.toContain("fresh1-dup"); // same song key as fresh1 already picked
    expect(ids).toContain("fresh2");
  });
```

Add `songKey` to the test's import from `@ai-journey-dj/core` (top of file):

```ts
import type { ResolvedTrack, SongCandidate } from "@ai-journey-dj/core";
import { songKey } from "@ai-journey-dj/core";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run packages/spotify/src/index.test.ts`
Expected: FAIL — excluded tracks still returned / `excludeSongKeys` ignored.

- [ ] **Step 3: Write minimal implementation**

In `packages/spotify/src/index.ts`, change the core import at the top:

```ts
import { normalizeText, songKey } from "@ai-journey-dj/core";
```

Replace the whole `queueTracksForBuffer` function with:

```ts
export function queueTracksForBuffer<T extends ResolvedTrack>(
  resolvedTracks: T[],
  args: {
    activeProviderTrackId?: string;
    alreadyQueuedProviderIds: Set<string>;
    targetBufferSize?: number;
    /** Provider track ids already consumed this journey (played/queued/surfaced). */
    excludeProviderTrackIds?: Set<string>;
    /** Song keys already consumed this journey — blocks other versions of the same song. */
    excludeSongKeys?: Set<string>;
  }
): T[] {
  const target = args.targetBufferSize ?? 5;
  const seenIds = new Set(args.alreadyQueuedProviderIds);
  if (args.activeProviderTrackId) {
    seenIds.add(args.activeProviderTrackId);
  }
  for (const id of args.excludeProviderTrackIds ?? []) {
    seenIds.add(id);
  }
  const seenKeys = new Set(args.excludeSongKeys ?? []);

  const selected: T[] = [];
  for (const track of resolvedTracks) {
    if (track.provider !== "spotify") continue;
    if (track.isPlayable === false) continue;
    if (!track.providerUri) continue;
    if (seenIds.has(track.providerTrackId)) continue;
    const key = songKey(track.artist, track.title);
    if (seenKeys.has(key)) continue;
    seenIds.add(track.providerTrackId);
    seenKeys.add(key);
    selected.push(track);
    if (selected.length === target) break;
  }

  return selected;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run packages/spotify/src/index.test.ts`
Expected: PASS (all tests including the new one).

- [ ] **Step 5: Commit**

```bash
git add packages/spotify/src/index.ts packages/spotify/src/index.test.ts
git commit -m "feat(spotify): exclude consumed ids/song keys from buffer selection"
```

---

## Task 3: Wire the consumed set into the journey service

**Files:**
- Modify: `apps/api/src/journeys/journeyService.ts`
- Test: `apps/api/test/journeySkip.test.ts`

- [ ] **Step 1: Write the failing integration test**

Append inside the `describe("spotify track skip", ...)` block in `apps/api/test/journeySkip.test.ts` (before its closing `});`):

```ts
  it("never re-surfaces an already-played song when advancing", async () => {
    const adapter = new SkipSpotifyAdapter();
    const { service, store } = buildService(adapter);

    const journey = await service.startJourney({
      destination: "Dijon",
      userPrompt: "road trip",
      passengerMode: "solo",
      provider: "spotify",
      deviceId: "web-device"
    });

    const actives: string[] = [];
    const first = store.getPlaybackSession(journey.id);
    if (first?.activeTrack?.id) actives.push(first.activeTrack.id);

    // Advance well past the initial buffer so the engine must refill at least once.
    for (let i = 0; i < 7; i += 1) {
      const session = await service.skipSpotifyTrack(journey.id, "next", "web-device", { clientControlled: true });
      // Let any fire-and-forget low-buffer refill settle before the next skip.
      await service.analyzeJourney(journey.id, "manual");
      if (session.activeTrack?.id) actives.push(session.activeTrack.id);
    }

    // No song is ever heard twice in a journey.
    expect(new Set(actives).size).toBe(actives.length);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run apps/api/test/journeySkip.test.ts -t "never re-surfaces"`
Expected: FAIL — a played track reappears (`Set` smaller than array).

- [ ] **Step 3: Import `songKey` in the service**

In `apps/api/src/journeys/journeyService.ts`, change the recommendation import to add `songKey` from core. The core import is currently only via other packages, so add a direct import near the top imports (after the `@ai-journey-dj/core` type import block):

Find:

```ts
import { derivePhase } from "@ai-journey-dj/telemetry";
```

Replace with:

```ts
import { songKey } from "@ai-journey-dj/core";
import { derivePhase } from "@ai-journey-dj/telemetry";
```

- [ ] **Step 4: Build the consumed set and use it for the cost gate**

In `analyzeSpotifyJourney`, replace this block:

```ts
    const priorSession = this.store.getPlaybackSession(journeyId);
    const inUseIds = new Set([...(priorSession?.queuedTrackIds ?? []), ...(priorSession?.playedTrackIds ?? [])]);
    const unusedPool = this.store
      .listResolvedTracks(journeyId)
      .filter(
        (track) =>
          track.provider === "spotify" && track.providerUri && track.isPlayable !== false && !inUseIds.has(track.id)
      );
    const neededNow = Math.max(0, 5 - (priorSession?.queuedTrackIds?.length ?? 0));
    const mustGenerate = vibeChangingReasons.has(reason) || unusedPool.length < neededNow;
```

with:

```ts
    const priorSession = this.store.getPlaybackSession(journeyId);
    const storedForGate = this.store.listResolvedTracks(journeyId).filter((track) => track.provider === "spotify");

    // "Consumed" = every track that has already been surfaced this journey (active, queued, played,
    // or ever added to the buffer). Selection and generation must never resurface these — neither
    // the exact recording (provider id) nor another version of the same song (song key).
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
```

- [ ] **Step 5: De-dupe freshly generated candidates against the consumed set**

In `analyzeSpotifyJourney`, find:

```ts
      candidates = await this.generateAndStoreCandidates(journeyId, scoutContext, 8);
    } else {
```

Replace with:

```ts
      candidates = (await this.generateAndStoreCandidates(journeyId, scoutContext, 8)).filter(
        (candidate) => !consumedSongKeys.has(songKey(candidate.artist, candidate.title))
      );
    } else {
```

- [ ] **Step 6: Pass the consumed set into the primary buffer selection**

In `analyzeSpotifyJourney`, find:

```ts
    const selected = queueTracksForBuffer(stored, {
      activeProviderTrackId: activeTrack?.providerTrackId,
      alreadyQueuedProviderIds: new Set(currentQueued.map((track) => track.providerTrackId)),
      targetBufferSize: needed
    });
```

Replace with:

```ts
    const selected = queueTracksForBuffer(stored, {
      activeProviderTrackId: activeTrack?.providerTrackId,
      alreadyQueuedProviderIds: new Set(currentQueued.map((track) => track.providerTrackId)),
      excludeProviderTrackIds: consumedProviderIds,
      excludeSongKeys: consumedSongKeys,
      targetBufferSize: needed
    });
```

- [ ] **Step 7: De-dupe the fallback regeneration + pass the consumed set into the top-up selection**

In `analyzeSpotifyJourney`, find:

```ts
      const fallbackCandidates = await this.generateAndStoreCandidates(journeyId, scoutContext, 8);
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
        targetBufferSize: Math.max(0, 5 - currentQueued.length - selected.length)
      });
```

Replace with:

```ts
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
```

- [ ] **Step 8: Run the integration test to verify it passes**

Run: `./node_modules/.bin/vitest run apps/api/test/journeySkip.test.ts`
Expected: PASS (all skip tests, including "never re-surfaces").

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/journeys/journeyService.ts apps/api/test/journeySkip.test.ts
git commit -m "fix(api): never resurface played songs — exclude consumed set in queue + generation"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck all workspaces**

Run: `npm run typecheck --workspaces`
Expected: exit 0, no `error TS...` lines.

- [ ] **Step 2: Run the full test suite**

Run: `./node_modules/.bin/vitest run`
Expected: all files pass (existing 78 + 3 core + 1 spotify + 1 api = 83), 0 failures.

- [ ] **Step 3: Lint the changed files**

Run:
```bash
npx eslint packages/core/src/index.ts packages/spotify/src/index.ts apps/api/src/journeys/journeyService.ts
```
Expected: `No issues found`.

- [ ] **Step 4: Commit any lint fixes (only if Step 3 required changes)**

```bash
git add -A
git commit -m "chore: lint cleanup for no-repeat queue"
```

---

## Self-Review Notes

- **Spec coverage:** §1 song key (Task 1), §2 selection exclusion (Task 2 + Task 3 Steps 6-7), §3 generation dedup (Task 3 Steps 5, 7), §4 fresh pool growth via the updated `unusedPool`/gate (Task 3 Step 4), §5 testing (Tasks 1-3 + Task 4). All covered.
- **Type consistency:** `songKey`/`normalizeBaseTitle` defined in Task 1 and used identically in Tasks 2-3. `queueTracksForBuffer`'s new `excludeProviderTrackIds`/`excludeSongKeys` (Task 2) match the call sites (Task 3 Steps 6-7).
- **No schema change** — `addedToPlaylist` already marks every buffered track; the consumed set reuses it.
- **Determinism in the integration test:** an awaited `analyzeJourney("manual")` after each skip settles the fire-and-forget low-buffer refill before asserting.
- **No placeholders.**
