export interface DriveContext {
  phase?: string;
  speedBucket?: string;
  etaMinutes?: number;
  temperatureBucket?: string;
  coarseRegion?: string;
  localTimeIso?: string;
}

export interface ContextPill {
  key: string;
  label: string;
  value: string;
}

export type TelemetryLiveness =
  | { state: "live"; secondsAgo: number; label: string }
  | { state: "stale"; secondsAgo: number; label: string }
  | { state: "none"; label: string };

/** Telemetry newer than this counts as a fresh, actively-streaming "live" reading. */
export const TELEMETRY_LIVE_THRESHOLD_SECONDS = 180;

function formatAgo(secondsAgo: number): string {
  if (secondsAgo < 5) return "gerade eben";
  if (secondsAgo < 60) return `vor ${secondsAgo}s`;
  if (secondsAgo < 3600) return `vor ${Math.floor(secondsAgo / 60)} min`;
  const hours = Math.floor(secondsAgo / 3600);
  return `vor ${hours} Std`;
}

/**
 * Classifies the freshness of the latest ingested telemetry for the live badge.
 * `nowMs` is injected so this stays pure and unit-testable.
 */
export function telemetryLiveness(lastTelemetryAt: string | undefined, nowMs: number): TelemetryLiveness {
  if (!lastTelemetryAt) return { state: "none", label: "Keine Live-Daten" };
  const ts = new Date(lastTelemetryAt).getTime();
  if (Number.isNaN(ts)) return { state: "none", label: "Keine Live-Daten" };
  const secondsAgo = Math.max(0, Math.round((nowMs - ts) / 1000));
  const ago = formatAgo(secondsAgo);
  if (secondsAgo <= TELEMETRY_LIVE_THRESHOLD_SECONDS) {
    return { state: "live", secondsAgo, label: `Live · ${ago}` };
  }
  return { state: "stale", secondsAgo, label: `Zuletzt ${ago}` };
}

const PACE_LABEL: Record<string, string> = {
  parked: "Parked",
  city: "City",
  country: "Country road",
  highway: "Highway"
};

const WEATHER_LABEL: Record<string, string> = {
  cold: "Cold",
  cool: "Cool",
  mild: "Mild",
  warm: "Warm",
  hot: "Hot"
};

function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function formatEta(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Builds the ordered, glanceable context pills, omitting any field without a usable value. */
export function buildContextPills(context?: DriveContext): ContextPill[] {
  if (!context) return [];
  const pills: ContextPill[] = [];

  if (context.phase) {
    pills.push({ key: "phase", label: "Phase", value: titleCase(context.phase) });
  }
  const pace = context.speedBucket ? PACE_LABEL[context.speedBucket] : undefined;
  if (pace) {
    pills.push({ key: "tempo", label: "Pace", value: pace });
  }
  if (typeof context.etaMinutes === "number" && context.etaMinutes > 0) {
    pills.push({ key: "eta", label: "ETA", value: formatEta(context.etaMinutes) });
  }
  const weather = context.temperatureBucket ? WEATHER_LABEL[context.temperatureBucket] : undefined;
  if (weather) {
    pills.push({ key: "weather", label: "Weather", value: weather });
  }
  if (context.coarseRegion) {
    pills.push({ key: "region", label: "Region", value: context.coarseRegion });
  }
  return pills;
}
