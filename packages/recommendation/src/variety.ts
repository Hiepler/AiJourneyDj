/** FNV-1a string hash → uint32. Stable across runs (unlike Object hashing). */
export function hashString(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG: deterministic, seedable, no global state. Returns () => [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface VarietyInput {
  journeyId: string;
  /** Minutes since journey start; drives the time-based rotation bucket. */
  elapsedMinutes?: number;
  /** How many minutes per rotation step. */
  bucketMinutes: number;
  phase: string;
  speedBucket: string;
  driveMode?: string;
}

export interface VarietyContext {
  /** uint32 seed for all variety layers this analysis pass. */
  seed: number;
  /** Monotonic-ish rotation index; changes over time and on telemetry transitions. */
  bucket: number;
}

/**
 * Deterministic per-journey variety seed. The bucket advances with elapsed time
 * AND with telemetry transitions (phase / speed / drive-mode), so the selection
 * drifts over the drive and audibly shifts when the driving context changes.
 */
export function makeVarietyContext(input: VarietyInput): VarietyContext {
  const timeBucket = Math.floor(
    Math.max(0, input.elapsedMinutes ?? 0) / Math.max(1, input.bucketMinutes),
  );
  const ctxBucket =
    hashString(`${input.phase}|${input.speedBucket}|${input.driveMode ?? ""}`) % 997;
  const bucket = (timeBucket + ctxBucket) >>> 0;
  const seed = (hashString(input.journeyId) ^ Math.imul(bucket + 1, 0x9e3779b1)) >>> 0;
  return { seed, bucket };
}

/** Deterministic jitter in [0,1) for a (seed, key) pair. */
export function seededJitter(seed: number, key: string): number {
  return mulberry32((seed ^ hashString(key)) >>> 0)();
}

/** Take `count` items starting at a seed-derived offset, wrapping around. */
export function rotateWindow<T>(items: T[], seed: number, count: number): T[] {
  if (items.length === 0 || count <= 0) return [];
  const start = seed % items.length;
  const out: T[] = [];
  for (let i = 0; i < Math.min(count, items.length); i += 1) {
    out.push(items[(start + i) % items.length]);
  }
  return out;
}

/** Rotating "exploration angle" hints fed to the LLM scout for per-journey freshness. */
export const EXPLORATION_ANGLES = [
  "lean into a distinctive sub-genre that still fits the mood",
  "favor a different era than the most obvious one",
  "surface a less-obvious facet of the mood",
  "highlight regional or local artists that fit the vibe",
  "balance one familiar anchor with two more adventurous picks",
] as const;

export function seededExplorationAngle(seed: number): string {
  return EXPLORATION_ANGLES[seed % EXPLORATION_ANGLES.length];
}
