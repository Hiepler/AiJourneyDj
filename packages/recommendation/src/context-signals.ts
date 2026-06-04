export type TimeBand =
  | "deep_night"
  | "dawn"
  | "morning"
  | "midday"
  | "afternoon"
  | "golden"
  | "night";

/** Local hour (0–23) → coarse time-of-day band. Half-open ranges [from, to). */
export function timeOfDayBand(hour: number): TimeBand {
  if (!Number.isFinite(hour)) return "midday";
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h < 4) return "deep_night";
  if (h < 7) return "dawn";
  if (h < 11) return "morning";
  if (h < 15) return "midday";
  if (h < 18) return "afternoon";
  if (h < 21) return "golden";
  return "night";
}

export type TripSegment = "opening" | "body" | "deep" | "closing";

export interface TripArc {
  progress: number; // 0..1
  segment: TripSegment;
  longHaul: boolean;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Derive trip progress + arc segment. `effectiveTotal` grows if the ETA pushes
 * the trip beyond its originally planned length, so progress never exceeds 1.
 */
export function tripArc(
  elapsedMin: number,
  plannedMin: number | undefined,
  remainingEtaMin: number | undefined,
): TripArc {
  const elapsed = Number.isFinite(elapsedMin) ? Math.max(0, elapsedMin) : 0;
  const remaining =
    typeof remainingEtaMin === "number" && Number.isFinite(remainingEtaMin)
      ? Math.max(0, remainingEtaMin)
      : undefined;
  const planned =
    typeof plannedMin === "number" && Number.isFinite(plannedMin)
      ? Math.max(0, plannedMin)
      : undefined;

  const effectiveTotal = Math.max(
    planned ?? 0,
    elapsed + (remaining ?? 0),
  );
  const progress = effectiveTotal > 0 ? clamp01(elapsed / effectiveTotal) : 0;
  const longHaul = (planned ?? effectiveTotal) > 180;

  let segment: TripSegment;
  if (remaining !== undefined && remaining <= 15) {
    segment = "closing";
  } else if (progress < 0.15) {
    segment = "opening";
  } else if (progress < 0.6) {
    segment = "body";
  } else if (progress < 0.85) {
    segment = "deep";
  } else {
    segment = "closing";
  }

  return { progress, segment, longHaul };
}

export type PaceTrend = "accelerating" | "steady" | "slowing" | undefined;

export const ALERTNESS_FLOOR_BASE = 0.42;
export const ALERTNESS_FLOOR_SLOPE = 0.12;

/**
 * Fatigue-aware lower bound on energy. Late hour + long elapsed driving +
 * monotony raise drowsiness risk; the returned floor keeps the music from
 * sinking below an alert-keeping level. 0 = no floor.
 */
export function alertnessFloor(
  band: TimeBand,
  elapsedMin: number,
  paceTrend: PaceTrend,
  speedBucket: string | undefined,
): number {
  let risk = 0;
  if (band === "deep_night") risk += 0.5;
  else if (band === "night") risk += 0.3;

  const elapsed = Number.isFinite(elapsedMin) ? elapsedMin : 0;
  if (elapsed > 240) risk += 0.5;
  else if (elapsed > 120) risk += 0.3;

  if (paceTrend === "slowing") risk += 0.2;
  if (speedBucket === "highway" && elapsed > 120) risk += 0.1;

  risk = clamp01(risk);
  return risk >= 0.4 ? ALERTNESS_FLOOR_BASE + ALERTNESS_FLOOR_SLOPE * risk : 0;
}
