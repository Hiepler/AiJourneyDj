/**
 * Pure Momente-Erkennung — kein I/O (Muster: reconcile.ts). Die Historie kommt aus
 * recentTelemetry und ist NEUESTE ZUERST sortiert (history[0] = aktuellster Snapshot).
 */
import type { JourneyContext, JourneyPhase } from "@ai-journey-dj/core";
import type { StoryAct } from "@ai-journey-dj/recommendation";

export type MomentType =
  | "traffic_jam"
  | "traffic_release"
  | "golden_hour"
  | "temp_swing"
  | "border_crossing"
  | "charge_approach"
  | "charge_resume"
  | "arrival";

/** Battery at/under this (%) means a charge stop is near → wind down. */
const CHARGE_LOW_BATTERY_PERCENT = 18;
/** Predicted energy at arrival at/under this (%) also signals an imminent charge stop. */
const CHARGE_LOW_ARRIVAL_PERCENT = 12;
/** A sustained battery rise of at least this many points marks a completed charge → new leg. */
const CHARGE_RESUME_JUMP_PERCENT = 15;

export interface JourneyMoment {
  type: MomentType;
  /** Brief-Zeile für den LLM. */
  directive: string;
  /** Offset auf die Ziel-Energie. */
  energyBias: number;
  moodTagBias: string[];
  candidateRequest?:
    | { kind: "geo-charts"; country: string }
    | { kind: "taste-anchor" };
  /** "banger" → der Prioritäts-Slot soll das energiereichste Stück bekommen. */
  priorityTrackRequest?: "banger";
}

interface TelemetryLike {
  trafficDelayMinutes?: number;
  outsideTempC?: number;
  countryCode?: string;
  countryName?: string;
  etaMinutes?: number;
  batteryPercent?: number;
  energyPercentAtArrival?: number;
}

export interface MomentConfig {
  jamDelayMinutes: number;
  releaseDelayMinutes: number;
  cooldownMs: number;
  arrivalWindowMinutes: number;
}

const PRIORITY: MomentType[] = [
  "arrival",
  "charge_resume",
  "border_crossing",
  "traffic_release",
  "traffic_jam",
  "charge_approach",
  "golden_hour",
  "temp_swing",
];

export function detectJourneyMoment(args: {
  context: JourneyContext;
  history: TelemetryLike[];
  previousPhase: JourneyPhase | undefined;
  act: StoryAct;
  lastMomentAt: ReadonlyMap<string, number>;
  nowMs: number;
  config: MomentConfig;
}): JourneyMoment | undefined {
  const { history, config } = args;
  const newest = history[0];
  const candidates = new Map<MomentType, JourneyMoment>();

  // arrival (Einmaligkeit erzwingt der Aufrufer via Audit)
  if (
    typeof args.context.etaMinutes === "number" &&
    args.context.etaMinutes <= config.arrivalWindowMinutes
  ) {
    candidates.set("arrival", {
      type: "arrival",
      directive:
        "Arrival is minutes away — close the drive with a beloved, familiar anthem as the finale.",
      energyBias: 0.05,
      moodTagBias: ["anthem", "feelgood"],
      candidateRequest: { kind: "taste-anchor" },
    });
  }

  // border crossing
  if (history.length >= 2) {
    const prev = history[1];
    if (
      newest?.countryCode &&
      prev?.countryCode &&
      newest.countryCode !== prev.countryCode &&
      newest.countryName
    ) {
      candidates.set("border_crossing", {
        type: "border_crossing",
        directive: `Just crossed into ${newest.countryName} — welcome the listener with current local hits before returning to the mix.`,
        energyBias: 0.05,
        moodTagBias: ["local"],
        candidateRequest: { kind: "geo-charts", country: newest.countryName },
      });
    }
  }

  // charge resume: a sustained battery rise (both newest readings elevated vs the earlier window)
  // marks a completed charge stop → open a fresh leg. Two-sample confirmation guards against a
  // single noisy SoC reading near a charger.
  if (history.length >= 3) {
    const newestTwoMin = Math.min(
      newest?.batteryPercent ?? Infinity,
      history[1]?.batteryPercent ?? Infinity,
    );
    const earlierLevels = history
      .slice(2)
      .map((item) => item.batteryPercent)
      .filter((value): value is number => typeof value === "number");
    if (earlierLevels.length > 0 && Number.isFinite(newestTwoMin)) {
      const earlierMin = Math.min(...earlierLevels);
      if (newestTwoMin - earlierMin >= CHARGE_RESUME_JUMP_PERCENT) {
        candidates.set("charge_resume", {
          type: "charge_resume",
          directive:
            "Back on the road after a charge stop — open a fresh chapter: lift the energy and re-introduce some local flavor.",
          energyBias: 0.12,
          moodTagBias: ["fresh", "bright"],
          candidateRequest: newest?.countryName
            ? { kind: "geo-charts", country: newest.countryName }
            : undefined,
        });
      }
    }
  }

  // charge approach: battery (or predicted energy at arrival) running low → a charge stop is near;
  // ease into calmer, settling textures before the break.
  const battery = newest?.batteryPercent;
  const arrivalEnergy = newest?.energyPercentAtArrival;
  if (
    (typeof battery === "number" && battery <= CHARGE_LOW_BATTERY_PERCENT) ||
    (typeof arrivalEnergy === "number" &&
      arrivalEnergy <= CHARGE_LOW_ARRIVAL_PERCENT)
  ) {
    candidates.set("charge_approach", {
      type: "charge_approach",
      directive:
        "Winding down toward a charge stop — ease into calmer, settling textures.",
      energyBias: -0.1,
      moodTagBias: ["mellow", "settling"],
    });
  }

  // traffic release / jam (Verlauf: Jam in der Historie, jetzt frei → Lift)
  const newestDelay = newest?.trafficDelayMinutes;
  const pastJam = history
    .slice(1)
    .some((item) => (item.trafficDelayMinutes ?? 0) >= config.jamDelayMinutes);
  if (
    typeof newestDelay === "number" &&
    newestDelay <= config.releaseDelayMinutes &&
    pastJam
  ) {
    candidates.set("traffic_release", {
      type: "traffic_release",
      directive:
        "The jam just broke — celebrate the open road with a noticeable energy lift and one undeniable banger.",
      energyBias: 0.15,
      moodTagBias: ["high-energy", "feelgood"],
      priorityTrackRequest: "banger",
    });
  } else if (
    typeof newestDelay === "number" &&
    newestDelay >= config.jamDelayMinutes &&
    (history[1]?.trafficDelayMinutes ?? 0) >= config.jamDelayMinutes
  ) {
    candidates.set("traffic_jam", {
      type: "traffic_jam",
      directive:
        "Heavy traffic — keep the cabin patient and pleasant; calmer, warmer selections until the road clears.",
      energyBias: -0.1,
      moodTagBias: ["mellow", "warm"],
    });
  }

  // golden hour (nur am Übergang)
  if (
    args.context.phase === "golden_hour" &&
    args.previousPhase !== "golden_hour"
  ) {
    candidates.set("golden_hour", {
      type: "golden_hour",
      directive:
        "Golden hour light — let the set swell cinematically with the sunset without losing momentum.",
      energyBias: args.act === "climax" ? 0.1 : 0.05,
      moodTagBias: ["cinematic", "warm"],
    });
  }

  // temp swing (>= 6°C über die Historien-Ränder)
  if (history.length >= 2) {
    const oldest = history[history.length - 1];
    if (
      typeof newest?.outsideTempC === "number" &&
      typeof oldest?.outsideTempC === "number" &&
      Math.abs(newest.outsideTempC - oldest.outsideTempC) >= 6
    ) {
      candidates.set("temp_swing", {
        type: "temp_swing",
        directive:
          newest.outsideTempC > oldest.outsideTempC
            ? "The air just warmed up — let the mood brighten with it."
            : "A cold front rolled in — shift toward cozier, warmer textures.",
        energyBias: 0,
        moodTagBias: [newest.outsideTempC > oldest.outsideTempC ? "sunny" : "cozy"],
      });
    }
  }

  for (const type of PRIORITY) {
    const moment = candidates.get(type);
    if (!moment) continue;
    const last = args.lastMomentAt.get(type) ?? 0;
    if (args.nowMs - last < config.cooldownMs) continue;
    return moment;
  }
  return undefined;
}
