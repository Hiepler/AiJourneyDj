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
  /** Effective total trip length in minutes (planned, or grown by a longer live ETA). */
  effectiveTotalMin: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Effective total trip length: the planned duration, or — if the live ETA already pushes the trip
 * beyond it — elapsed + remaining. Shared by `tripArc` and `tripArchetype` so both agree.
 */
export function effectiveTripMinutes(
  elapsedMin: number,
  plannedMin: number | undefined,
  remainingEtaMin: number | undefined,
): number {
  const elapsed = Number.isFinite(elapsedMin) ? Math.max(0, elapsedMin) : 0;
  const remaining =
    typeof remainingEtaMin === "number" && Number.isFinite(remainingEtaMin)
      ? Math.max(0, remainingEtaMin)
      : 0;
  const planned =
    typeof plannedMin === "number" && Number.isFinite(plannedMin)
      ? Math.max(0, plannedMin)
      : 0;
  return Math.max(planned, elapsed + remaining);
}

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

  const effectiveTotal = effectiveTripMinutes(elapsed, planned, remaining);
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

  return { progress, segment, longHaul, effectiveTotalMin: effectiveTotal };
}

export type TripArchetype = "errand" | "commute" | "day_trip" | "long_haul";
export type DayKind = "weekday" | "weekend";

export interface DayContext {
  dayKind: DayKind;
  /** Weekday name + time band, e.g. "monday_morning" — for prompt phrasing. */
  daypartKey: string;
}

const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** Local day-of-week + daypart from an ISO timestamp. Weekend = Sat/Sun. */
export function dayContextFrom(
  localTimeIso: string | undefined,
  band: TimeBand,
): DayContext {
  const parsed = localTimeIso ? new Date(localTimeIso) : undefined;
  const date = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
  const day = date.getDay();
  const dayKind: DayKind = day === 0 || day === 6 ? "weekend" : "weekday";
  return { dayKind, daypartKey: `${WEEKDAY_NAMES[day] ?? "day"}_${band}` };
}

/**
 * Coarse trip archetype that captures the *gestalt* of a drive — a 20-min weekend errand vs a
 * weekday commute vs a multi-hour haul — so the engine can shape its macro strategy. Derived from
 * the effective total length + daypart + weekday/weekend.
 */
export function tripArchetype(
  effectiveTotalMin: number,
  band: TimeBand,
  dayKind: DayKind,
): TripArchetype {
  const total = Number.isFinite(effectiveTotalMin)
    ? Math.max(0, effectiveTotalMin)
    : 0;
  if (total > 180) return "long_haul";
  if (total < 25) return "errand";
  const commuteBand =
    band === "morning" || band === "afternoon" || band === "golden";
  if (total <= 75 && dayKind === "weekday" && commuteBand) return "commute";
  return "day_trip";
}

export interface ArchetypeStrategy {
  /** Bias on familiarity↔discovery (errands/commutes lean familiar). */
  tasteWeightBias: number;
  /** Hint magnitude for exploration breadth (long trips wander more). Informational. */
  explorationBias: number;
  /** Skip the slow opening build — short hops get straight to beloved songs. */
  compressOpening: boolean;
}

/** Pure archetype → macro-strategy table. */
export function archetypeStrategy(archetype: TripArchetype): ArchetypeStrategy {
  switch (archetype) {
    case "errand":
      return { tasteWeightBias: 0.2, explorationBias: -0.1, compressOpening: true };
    case "commute":
      return { tasteWeightBias: 0.1, explorationBias: 0, compressOpening: false };
    case "day_trip":
      return { tasteWeightBias: 0, explorationBias: 0.1, compressOpening: false };
    case "long_haul":
      return { tasteWeightBias: 0, explorationBias: 0.15, compressOpening: false };
  }
}

/**
 * Evocative weather phrasing from on-board temperature + time band (no external weather service).
 * Buckets mirror `temperatureBucket` (cold<5, cool<13, mild<22, warm<30, hot>=30) so the feel
 * matches the rest of the engine. Returns undefined when temperature is unknown, so the prompt
 * line is simply omitted.
 */
export function weatherFeel(
  outsideTempC: number | undefined,
  band: TimeBand,
  month?: number,
): string | undefined {
  if (typeof outsideTempC !== "number" || !Number.isFinite(outsideTempC)) {
    return undefined;
  }
  const morning = band === "dawn" || band === "morning";
  const night = band === "deep_night" || band === "night";
  const golden = band === "golden";
  const bright = band === "midday" || band === "afternoon";

  let feel: string;
  if (outsideTempC < 5) {
    feel = night
      ? "cold, clear night"
      : morning
        ? "crisp, frosty morning"
        : "cold, sharp air";
  } else if (outsideTempC < 13) {
    feel = morning
      ? "cool, fresh morning"
      : night
        ? "cool night air"
        : "cool, crisp air";
  } else if (outsideTempC < 22) {
    feel = morning
      ? "mild, easy morning"
      : golden
        ? "mild golden-hour light"
        : night
          ? "mild, calm night"
          : "mild, easy air";
  } else if (outsideTempC < 30) {
    feel = golden
      ? "warm and golden"
      : night
        ? "warm summer night"
        : morning
          ? "warm, bright morning"
          : "warm and bright";
  } else {
    feel = bright
      ? "bright midday heat"
      : golden
        ? "hot, hazy golden hour"
        : night
          ? "warm, sultry night"
          : "hot, shimmering air";
  }

  // Optional soft seasonal adjective (Northern-hemisphere months); secondary, never overrides feel.
  if (typeof month === "number" && Number.isFinite(month)) {
    const m = ((Math.floor(month) % 12) + 12) % 12;
    const deepWinter = m === 11 || m === 0 || m === 1;
    const highSummer = m >= 5 && m <= 7;
    if (deepWinter && outsideTempC < 13) return `wintry ${feel}`;
    if (highSummer && outsideTempC >= 22) return `high-summer ${feel}`;
  }
  return feel;
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
