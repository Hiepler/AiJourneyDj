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
