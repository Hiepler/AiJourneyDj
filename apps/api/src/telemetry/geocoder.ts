export interface GeocoderOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";

/** Rounds to ~0.1° (~11 km) so a coarse area maps to one cache bucket. */
function bucket(lat: number, lon: number): string {
  return `${lat.toFixed(1)},${lon.toFixed(1)}`;
}

function regionFromAddress(address: Record<string, unknown> | undefined): string | undefined {
  if (!address) return undefined;
  const area =
    (address.state as string) ||
    (address.region as string) ||
    (address.county as string) ||
    (address.city as string) ||
    (address.town as string);
  const country = address.country as string | undefined;
  if (area && country) return `${area}, ${country}`;
  return area || country || undefined;
}

/** One-shot reverse geocode → coarse region (e.g. "Bavaria, Germany"); undefined on any error. */
export async function coarseRegionFor(
  lat: number,
  lon: number,
  options: GeocoderOptions = {}
): Promise<string | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? NOMINATIM_REVERSE;
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("zoom", "8");
    const response = await fetchImpl(url, {
      headers: { "User-Agent": "AIJourneyDJ/1.0 (single-user journey soundtrack)" },
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { address?: Record<string, unknown> };
    return regionFromAddress(payload.address);
  } catch {
    return undefined;
  }
}

/** Builds a cached geocoder: nearby coordinates (same ~0.1° bucket) reuse the first result. */
export function makeGeocoder(options: GeocoderOptions = {}): (lat: number, lon: number) => Promise<string | undefined> {
  const cache = new Map<string, string | undefined>();
  return async (lat: number, lon: number) => {
    const key = bucket(lat, lon);
    if (cache.has(key)) return cache.get(key);
    const region = await coarseRegionFor(lat, lon, options);
    cache.set(key, region);
    return region;
  };
}
