export interface LastfmChartTrack {
  artist: string;
  title: string;
  rank?: number;
  playcount?: number;
  country?: string;
  tag?: string;
  source: "lastfm-geo" | "lastfm-tag";
}

export interface LastfmChartClientOptions {
  apiKey?: string;
  baseUrl?: string;
  enabled?: boolean;
  chartCacheHours?: number;
  tagCacheHours?: number;
  similarCacheHours?: number;
  fetchImpl?: typeof fetch;
}

interface Cached<T> {
  expiresAt: number;
  value: T;
}

const DEFAULT_BASE_URL = "https://ws.audioscrobbler.com/2.0/";

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function artistName(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    return textValue((value as { name?: unknown })?.name);
  }
  return undefined;
}

function parseTrackItems(
  items: unknown[],
  source: LastfmChartTrack["source"],
  context: { country?: string; tag?: string },
): LastfmChartTrack[] {
  return items
    .map((item): LastfmChartTrack | undefined => {
      const record = item as {
        name?: unknown;
        artist?: unknown;
        playcount?: unknown;
        "@attr"?: { rank?: unknown };
      };
      const title = textValue(record.name);
      const artist = artistName(record.artist);
      if (!title || !artist) return undefined;
      return {
        artist,
        title,
        rank: numberValue(record["@attr"]?.rank),
        playcount: numberValue(record.playcount),
        country: context.country,
        tag: context.tag,
        source,
      } satisfies LastfmChartTrack;
    })
    .filter((track): track is LastfmChartTrack => Boolean(track));
}

export class LastfmChartClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly enabled: boolean;
  private readonly chartTtlMs: number;
  private readonly tagTtlMs: number;
  private readonly similarTtlMs: number;
  private readonly cache = new Map<string, Cached<unknown>>();

  constructor(private readonly options: LastfmChartClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/?$/, "/");
    this.enabled = options.enabled !== false && Boolean(options.apiKey);
    this.chartTtlMs = (options.chartCacheHours ?? 6) * 60 * 60 * 1000;
    this.tagTtlMs = (options.tagCacheHours ?? 12) * 60 * 60 * 1000;
    this.similarTtlMs = (options.similarCacheHours ?? 168) * 60 * 60 * 1000;
  }

  async getGeoTopTracks(
    country: string | undefined,
    limit = 50,
    page = 1,
  ): Promise<LastfmChartTrack[]> {
    const normalizedCountry = country?.trim();
    if (!this.enabled || !normalizedCountry) return [];
    const url = this.url("geo.getTopTracks", {
      country: normalizedCountry,
      limit,
      page,
    });
    const payload = await this.fetchCached(
      `geo:${normalizedCountry.toLowerCase()}:${limit}:${page}`,
      url,
      this.chartTtlMs,
    );
    const tracks = asArray(
      (payload as { tracks?: { track?: unknown } })?.tracks?.track,
    );
    return parseTrackItems(tracks, "lastfm-geo", {
      country: normalizedCountry,
    }).slice(0, limit);
  }

  async getTagTopTracks(
    tag: string | undefined,
    limit = 25,
    page = 1,
  ): Promise<LastfmChartTrack[]> {
    const normalizedTag = tag?.trim().toLowerCase();
    if (!this.enabled || !normalizedTag) return [];
    const url = this.url("tag.getTopTracks", { tag: normalizedTag, limit, page });
    const payload = await this.fetchCached(
      `tag:${normalizedTag}:${limit}:${page}`,
      url,
      this.tagTtlMs,
    );
    const tracks = asArray(
      (payload as { tracks?: { track?: unknown } })?.tracks?.track,
    );
    return parseTrackItems(tracks, "lastfm-tag", { tag: normalizedTag }).slice(
      0,
      limit,
    );
  }

  /** Ähnliche Tracks zu einem Seed-Track (track.getSimilar). */
  async getSimilarTracks(
    artist: string | undefined,
    title: string | undefined,
    limit = 30,
  ): Promise<Array<{ artist: string; title: string; match: number }>> {
    const a = artist?.trim();
    const t = title?.trim();
    if (!this.enabled || !a || !t) return [];
    const url = this.url("track.getSimilar", { artist: a, track: t, limit, autocorrect: 1 });
    const payload = await this.fetchCached(
      `simtrack:${a.toLowerCase()}:${t.toLowerCase()}:${limit}`,
      url,
      this.similarTtlMs,
    );
    const items = asArray((payload as any)?.similartracks?.track);
    return items
      .map((item: any) => ({
        artist: typeof item?.artist?.name === "string" ? item.artist.name : "",
        title: typeof item?.name === "string" ? item.name : "",
        match: Number(item?.match ?? 0),
      }))
      .filter((item) => item.artist && item.title)
      .slice(0, limit);
  }

  /** Ähnliche Artisten zu einem Seed-Artist (artist.getSimilar). */
  async getSimilarArtists(artist: string | undefined, limit = 30): Promise<string[]> {
    const a = artist?.trim();
    if (!this.enabled || !a) return [];
    const url = this.url("artist.getSimilar", { artist: a, limit, autocorrect: 1 });
    const payload = await this.fetchCached(
      `simartist:${a.toLowerCase()}:${limit}`,
      url,
      this.similarTtlMs,
    );
    const items = asArray((payload as any)?.similarartists?.artist);
    return items
      .map((item: any) => (typeof item?.name === "string" ? item.name : ""))
      .filter(Boolean)
      .slice(0, limit);
  }

  /** Top-Tracks eines Artists (artist.getTopTracks). */
  async getArtistTopTracks(
    artist: string | undefined,
    limit = 10,
  ): Promise<Array<{ artist: string; title: string; rank: number }>> {
    const a = artist?.trim();
    if (!this.enabled || !a) return [];
    const url = this.url("artist.getTopTracks", { artist: a, limit, autocorrect: 1 });
    const payload = await this.fetchCached(
      `arttop:${a.toLowerCase()}:${limit}`,
      url,
      this.similarTtlMs,
    );
    const items = asArray((payload as any)?.toptracks?.track);
    return items
      .map((item: any, index: number) => ({
        artist: typeof item?.artist?.name === "string" ? item.artist.name : a,
        title: typeof item?.name === "string" ? item.name : "",
        rank: Number(item?.["@attr"]?.rank ?? index + 1),
      }))
      .filter((item) => item.title)
      .slice(0, limit);
  }

  private url(method: string, params: Record<string, string | number>): URL {
    const url = new URL(this.baseUrl);
    url.searchParams.set("method", method);
    url.searchParams.set("api_key", this.options.apiKey ?? "");
    url.searchParams.set("format", "json");
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async fetchCached(
    key: string,
    url: URL,
    ttlMs: number,
  ): Promise<unknown> {
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.value;
    try {
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return {};
      const value = (await response.json()) as unknown;
      this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } catch {
      return {};
    }
  }
}
