/** Server-komponierte „Warum dieser Song?“-Zeile — die UI rendert nur den String. */
export interface WhyLineInput {
  lens?: string | null;
  reason?: string | null;
  source?: string | null;
  chartCountry?: string | null;
}

const MOMENT_LINES: Record<string, string> = {
  "moment:traffic_release": "Stau aufgelöst — der Befreiungs-Banger",
  "moment:traffic_jam": "Geduldig durch den Stau",
  "moment:golden_hour": "Golden Hour — cinematischer Swell",
  "moment:temp_swing": "Das Wetter dreht — die Musik dreht mit",
  "moment:border_crossing": "Local Hit",
  "taste-anchor:opening": "Opening Title — dein vertrauter Einstieg",
  "taste-anchor:arrival": "Arrival Anthem — das Finale vor der Ankunft",
};

export function composeWhyLine(input?: WhyLineInput): string | undefined {
  if (!input) return undefined;
  const lens = input.lens ?? "";
  for (const [key, line] of Object.entries(MOMENT_LINES)) {
    if (lens.startsWith(key)) {
      return key === "moment:border_crossing" && input.chartCountry
        ? `${line}: gerade angesagt in ${input.chartCountry}`
        : line;
    }
  }
  if (input.source === "music-wish" || lens.startsWith("music-wish")) {
    return "Dein Wunsch wirkt hier";
  }
  if (lens.startsWith("lastfm-similar:")) {
    return `Weil dir ${lens.slice("lastfm-similar:".length)} gefällt`;
  }
  if (input.chartCountry) {
    return `Gerade angesagt in ${input.chartCountry}`;
  }
  if (lens === "deep_cuts") {
    return "Deep Cut — abseits der üblichen Namen";
  }
  return input.reason ?? undefined;
}
