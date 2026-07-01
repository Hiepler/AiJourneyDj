/** Server-composed "Why this song?" line — the UI only renders the string. */
export interface WhyLineInput {
  lens?: string | null;
  reason?: string | null;
  source?: string | null;
  chartCountry?: string | null;
}

const MOMENT_LINES: Record<string, string> = {
  "moment:traffic_release": "Jam cleared — the release banger",
  "moment:traffic_jam": "Patient through the jam",
  "moment:golden_hour": "Golden hour — cinematic swell",
  "moment:temp_swing": "The weather's turning — the music turns with it",
  "moment:border_crossing": "Local hit",
  "taste-anchor:opening": "Opening title — your familiar way in",
  "taste-anchor:arrival": "Arrival anthem — the finale before you arrive",
};

export function composeWhyLine(input?: WhyLineInput): string | undefined {
  if (!input) return undefined;
  const lens = input.lens ?? "";
  for (const [key, line] of Object.entries(MOMENT_LINES)) {
    if (lens.startsWith(key)) {
      return key === "moment:border_crossing" && input.chartCountry
        ? `${line}: trending in ${input.chartCountry} right now`
        : line;
    }
  }
  if (input.source === "music-wish" || lens.startsWith("music-wish")) {
    return "Your wish is shaping this";
  }
  if (lens.startsWith("lastfm-similar:")) {
    return `Because you like ${lens.slice("lastfm-similar:".length)}`;
  }
  if (lens === "release-radar") {
    return "Fresh release — new from this artist";
  }
  if (input.chartCountry) {
    return `Trending in ${input.chartCountry} right now`;
  }
  if (lens === "deep_cuts") {
    return "Deep cut — off the usual names";
  }
  return input.reason ?? undefined;
}
