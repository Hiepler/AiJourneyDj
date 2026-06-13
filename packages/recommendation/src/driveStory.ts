export type StoryAct = "opening" | "act_one" | "interlude" | "climax" | "finale";

export interface StoryBeat {
  act: StoryAct;
  /** Brief-Zeile für den LLM. */
  directive: string;
  /** Offset auf die Ziel-Energie (gleiche Mechanik wie energyBias). */
  energyOffset: number;
}

const DIRECTIVES: Record<StoryAct, string> = {
  opening:
    "Opening title: start with a familiar, inviting anchor that sets the destination's mood — the drive's opening credits.",
  act_one: "Act one: establish the journey's sound and unfold variety.",
  interlude: "Interlude: breathe — discoveries and deep cuts welcome.",
  climax:
    "Climax: this is the emotional high point of the drive — let the set peak.",
  finale: "Finale: build the closing arc toward arrival; familiar anthem energy.",
};

const OFFSETS: Record<StoryAct, number> = {
  opening: 0,
  act_one: 0,
  interlude: -0.05,
  climax: 0.1,
  finale: 0.05,
};

/**
 * Bildet den Fahrt-Fortschritt auf einen Erzähl-Akt ab. Ohne plannedDurationMinutes
 * degradiert die Story lautlos auf act_one (Offset 0) — heutiges Verhalten.
 */
export function driveStoryAct(args: {
  elapsedMinutes?: number;
  plannedDurationMinutes?: number;
  etaMinutes?: number;
  isFirstPass: boolean;
  arrivalWindowMinutes?: number;
}): StoryBeat {
  const arrivalWindow = args.arrivalWindowMinutes ?? 10;
  if (args.isFirstPass) {
    return {
      act: "opening",
      directive: DIRECTIVES.opening,
      energyOffset: OFFSETS.opening,
    };
  }
  if (typeof args.etaMinutes === "number" && args.etaMinutes <= arrivalWindow) {
    return {
      act: "finale",
      directive: DIRECTIVES.finale,
      energyOffset: OFFSETS.finale,
    };
  }
  const planned = args.plannedDurationMinutes;
  if (!planned || planned <= 0) {
    return { act: "act_one", directive: DIRECTIVES.act_one, energyOffset: 0 };
  }
  const progress = Math.max(
    0,
    Math.min(1, (args.elapsedMinutes ?? 0) / planned),
  );
  const act: StoryAct =
    progress > 0.85
      ? "finale"
      : progress > 0.55
        ? "climax"
        : progress > 0.35
          ? "interlude"
          : "act_one";
  return { act, directive: DIRECTIVES[act], energyOffset: OFFSETS[act] };
}
