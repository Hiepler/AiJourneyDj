/**
 * Pure playback-reconciliation logic — no I/O, fully unit-testable.
 *
 * Compares the backend's ordered playback model `[activeTrack, ...queued]` against the
 * track Spotify reports as actually playing, so the server can learn about skips made in
 * the native Tesla Spotify miniplayer (Spotify Connect), which it otherwise never sees.
 */

/** Outcome of comparing the backend model to the real current track. */
export type ReconcileKind =
  | "same" // the active track is still the one playing — no drift
  | "skipped" // playback advanced into our queue — `index` tracks how far
  | "drifted" // one of OUR journey tracks plays outside the model — re-anchor, don't pause
  | "external" // the current track is not in our curated model — user is off-journey
  | "empty"; // we have no model to reconcile against (no active track / fresh journey)

export interface ReconcileResult {
  kind: ReconcileKind;
  /** Position of the current track within the ordered model (only meaningful for "skipped"). */
  index: number;
}

/**
 * Locates the real current track within the ordered model of provider track IDs.
 *
 * @param modelProviderTrackIds Ordered `[activeTrack, ...queued]` provider track IDs.
 * @param currentProviderTrackId The provider track ID Spotify reports as playing.
 * @param knownProviderTrackIds Every provider track ID this journey ever resolved. Spotify's
 *   queue is append-only, so a stale add or a wish rebuild can put one of OUR tracks on air
 *   at a position the 6-slot model no longer shows — that is drift to re-anchor on, not an
 *   off-journey track to pause for.
 */
export function reconcilePlaybackModel(
  modelProviderTrackIds: string[],
  currentProviderTrackId: string | undefined,
  knownProviderTrackIds?: ReadonlySet<string>
): ReconcileResult {
  if (modelProviderTrackIds.length === 0) {
    return { kind: "empty", index: -1 };
  }
  if (!currentProviderTrackId) {
    // Nothing is playing — caller decides idle handling; treat as no drift.
    return { kind: "same", index: 0 };
  }
  const index = modelProviderTrackIds.indexOf(currentProviderTrackId);
  if (index === -1) {
    if (knownProviderTrackIds?.has(currentProviderTrackId)) {
      return { kind: "drifted", index: -1 };
    }
    return { kind: "external", index: -1 };
  }
  if (index === 0) {
    return { kind: "same", index: 0 };
  }
  return { kind: "skipped", index };
}

export type OwnershipVerdict = "owned" | "handed-over";

/**
 * Decides whether the backend still "owns" playback and may push curated music, or whether the
 * user has clearly taken over (so automated transfer/queue must be suppressed). Pure + testable.
 *
 * Hand-over when something is actually playing AND either a podcast/episode is on air or the
 * current track is off-journey (`external`). A journey track playing on a *different* device is
 * NOT a hand-over: that's the user moving our journey to another Connect device (e.g. the native
 * Tesla app), which we follow rather than abandon. Idle (`isPlaying` false) is the normal pause
 * path, not a hand-over. Ads are neutral.
 */
export function playbackOwnership(input: {
  isPlaying: boolean;
  currentlyPlayingType?: string;
  activeDeviceId?: string;
  journeyDeviceId?: string;
  reconcileKind?: ReconcileKind;
}): OwnershipVerdict {
  if (!input.isPlaying) return "owned";
  if (input.currentlyPlayingType === "episode") return "handed-over";
  if (input.reconcileKind === "external") return "handed-over";
  return "owned";
}

/**
 * Adaptive poll cadence: poll fast while a curated track is actively playing, back off when
 * paused / idle / off-journey so we don't burn API calls or trigger needless reconciliation.
 */
export function nextPollIntervalSeconds(
  outcome: "playing" | "idle" | "external",
  config: { activeSeconds: number; idleSeconds: number }
): number {
  return outcome === "playing" ? config.activeSeconds : config.idleSeconds;
}

/**
 * Cost guard for AI regeneration: only allow a fresh Gemini generation when the candidate pool
 * is exhausted AND at least `minIntervalMs` has elapsed since the last generation. Bounds AI spend
 * to ≤ one generation per interval regardless of how fast the user skips.
 */
export function shouldRegenerate(
  lastGeneratedAtIso: string | undefined,
  nowMs: number,
  minIntervalMs: number
): boolean {
  if (!lastGeneratedAtIso) return true;
  const last = Date.parse(lastGeneratedAtIso);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= minIntervalMs;
}
