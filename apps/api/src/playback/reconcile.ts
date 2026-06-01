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
 */
export function reconcilePlaybackModel(
  modelProviderTrackIds: string[],
  currentProviderTrackId: string | undefined
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
    return { kind: "external", index: -1 };
  }
  if (index === 0) {
    return { kind: "same", index: 0 };
  }
  return { kind: "skipped", index };
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
