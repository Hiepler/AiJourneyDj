import type { ResolvedTrack, SongCandidate } from "@ai-journey-dj/core";
import { normalizeText } from "@ai-journey-dj/core";

export interface SpotifyTrackSearchResult {
  id: string;
  uri: string;
  title: string;
  artist: string;
  isrc?: string;
  album?: string;
  isPlayable?: boolean;
  market?: string;
  externalUrl?: string;
  albumArtUrl?: string;
}

export interface SpotifyPlaybackState {
  activeProviderTrackId?: string;
  activeProviderUri?: string;
  isPlaying: boolean;
  queuedProviderTrackIds: string[];
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  url?: string;
}

export interface SpotifyAdapter {
  searchTracks(args: {
    accessToken: string;
    query: string;
    market: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<SpotifyTrackSearchResult[]>;
  transferPlayback(args: { accessToken: string; deviceId: string }): Promise<void>;
  resolvePlaybackDeviceId(args: { accessToken: string; preferredDeviceId: string }): Promise<string>;
  skipToNext(args: { accessToken: string; deviceId: string }): Promise<void>;
  skipToPrevious(args: { accessToken: string; deviceId: string }): Promise<void>;
  startPlayback(args: {
    accessToken: string;
    deviceId: string;
    uris: string[];
  }): Promise<void>;
  addToQueue(args: {
    accessToken: string;
    deviceId: string;
    uri: string;
  }): Promise<void>;
  getPlaybackState(args: {
    accessToken: string;
    market: string;
  }): Promise<SpotifyPlaybackState>;
  createPlaylist?(args: {
    accessToken: string;
    name: string;
    description: string;
  }): Promise<SpotifyPlaylist>;
}

interface OfficialSpotifyAdapterOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class OfficialSpotifyAdapter implements SpotifyAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly baseUrl: string;

  constructor(options: OfficialSpotifyAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.wait = options.wait ?? delay;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  async searchTracks(args: {
    accessToken: string;
    query: string;
    market: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<SpotifyTrackSearchResult[]> {
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set("q", args.query);
    url.searchParams.set("type", "track");
    url.searchParams.set("market", args.market);
    url.searchParams.set("limit", String(args.limit));

    const payload = await this.request<any>(url, args.accessToken, { signal: args.signal });
    const items = Array.isArray(payload?.tracks?.items) ? payload.tracks.items : [];
    return items.map((item: any) => mapSpotifyTrack(item, args.market));
  }

  async transferPlayback(args: { accessToken: string; deviceId: string }): Promise<void> {
    const url = new URL(`${this.baseUrl}/me/player`);
    // Activation only: do NOT pass play:true — that would resume the account's previous
    // (external) playback context. startPlayback is the single source of truth for content.
    await this.request(url, args.accessToken, {
      method: "PUT",
      body: JSON.stringify({ device_ids: [args.deviceId], play: false })
    }, { parseJson: false });
  }

  async resolvePlaybackDeviceId(args: {
    accessToken: string;
    preferredDeviceId: string;
  }): Promise<string> {
    const url = new URL(`${this.baseUrl}/me/player/devices`);
    const payload = await this.request<{ devices?: Array<{ id: string; is_active?: boolean; name?: string; type?: string }> }>(
      url,
      args.accessToken
    );
    const devices = payload?.devices ?? [];
    const preferred = devices.find((device) => device.id === args.preferredDeviceId);
    if (preferred) {
      return preferred.id;
    }
    const journeyPlayer = devices.find((device) => device.name?.includes("AI Journey"));
    if (journeyPlayer) {
      return journeyPlayer.id;
    }
    const computer = devices.find((device) => device.type === "Computer");
    if (computer) {
      return computer.id;
    }
    const active = devices.find((device) => device.is_active);
    if (active) {
      return active.id;
    }
    return args.preferredDeviceId;
  }

  async skipToNext(args: { accessToken: string; deviceId: string }): Promise<void> {
    const url = new URL(`${this.baseUrl}/me/player/next`);
    url.searchParams.set("device_id", args.deviceId);
    await this.request(url, args.accessToken, { method: "POST" }, { parseJson: false });
  }

  async skipToPrevious(args: { accessToken: string; deviceId: string }): Promise<void> {
    const url = new URL(`${this.baseUrl}/me/player/previous`);
    url.searchParams.set("device_id", args.deviceId);
    await this.request(url, args.accessToken, { method: "POST" }, { parseJson: false });
  }

  async startPlayback(args: { accessToken: string; deviceId: string; uris: string[] }): Promise<void> {
    if (args.uris.length === 0) return;
    const url = new URL(`${this.baseUrl}/me/player/play`);
    url.searchParams.set("device_id", args.deviceId);
    await this.request(url, args.accessToken, {
      method: "PUT",
      body: JSON.stringify({ uris: args.uris })
    }, { parseJson: false });
  }

  async addToQueue(args: { accessToken: string; deviceId: string; uri: string }): Promise<void> {
    const url = new URL(`${this.baseUrl}/me/player/queue`);
    url.searchParams.set("uri", args.uri);
    url.searchParams.set("device_id", args.deviceId);
    await this.request(url, args.accessToken, { method: "POST" }, { parseJson: false });
  }

  async getPlaybackState(args: { accessToken: string; market: string }): Promise<SpotifyPlaybackState> {
    const url = new URL(`${this.baseUrl}/me/player`);
    url.searchParams.set("market", args.market);
    const payload = await this.request<any>(url, args.accessToken);
    const active = payload?.item ? mapSpotifyTrack(payload.item, args.market) : undefined;
    const queue = Array.isArray(payload?.queue) ? payload.queue : [];
    return {
      activeProviderTrackId: active?.id,
      activeProviderUri: active?.uri,
      isPlaying: payload?.is_playing === true,
      queuedProviderTrackIds: queue.map((item: any) => item?.id).filter((id: unknown): id is string => typeof id === "string")
    };
  }

  async createPlaylist(args: {
    accessToken: string;
    name: string;
    description: string;
  }): Promise<SpotifyPlaylist> {
    const profile = await this.request<any>(new URL(`${this.baseUrl}/me`), args.accessToken);
    if (!profile?.id) {
      throw new Error("Spotify profile did not include a user id.");
    }

    const playlist = await this.request<any>(new URL(`${this.baseUrl}/users/${profile.id}/playlists`), args.accessToken, {
      method: "POST",
      body: JSON.stringify({
        name: args.name,
        description: args.description,
        public: false
      })
    });

    return {
      id: playlist.id,
      name: playlist.name ?? args.name,
      url: playlist.external_urls?.spotify
    };
  }

  private async request<T>(
    url: URL,
    accessToken: string,
    init: RequestInit = {},
    options: { parseJson?: boolean } = {},
    attempt = 0
  ): Promise<T> {
    const parseJson = options.parseJson ?? true;
    const response = await this.fetchImpl(url, {
      ...init,
      signal: init.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });

    if (response.status === 429 && attempt < 4) {
      const header = Number(response.headers.get("Retry-After") ?? String(attempt + 1));
      // Cap the backoff so a large Retry-After can't stall a search far past its timeout budget,
      // and make the wait abortable so the per-search AbortSignal actually bounds total time.
      const retryAfterMs = Math.min(Math.max(1, Number.isFinite(header) ? header : 1), 5) * 1000;
      await this.waitUnlessAborted(retryAfterMs, init.signal);
      return this.request(url, accessToken, init, options, attempt + 1);
    }

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Spotify request failed with ${response.status}: ${details}`);
    }

    // Fire-and-forget commands (transfer/play/queue) ignore the body; never parse it,
    // because Spotify can answer 2xx (e.g. 202 Accepted) with an empty or non-JSON body.
    if (response.status === 204 || !parseJson) {
      return undefined as T;
    }

    const raw = await response.text();
    if (raw.trim() === "") {
      return undefined as T;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(
        `Spotify request to ${url.pathname} returned ${response.status} with a non-JSON body: ${JSON.stringify(raw.slice(0, 80))}`
      );
    }
  }

  /** Waits `ms`, but rejects immediately if the request's abort signal fires (or is already aborted). */
  private async waitUnlessAborted(ms: number, signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) {
      throw new Error("Spotify request aborted before rate-limit retry.");
    }
    if (!signal) {
      await this.wait(ms);
      return;
    }
    await Promise.race([
      this.wait(ms),
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Spotify request aborted during rate-limit backoff.")), {
          once: true
        });
      })
    ]);
  }
}

export function isSpotifyDeviceNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("404") && error.message.toLowerCase().includes("device not found");
}

export function isSpotifyRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("429");
}

export class MockSpotifyAdapter implements SpotifyAdapter {
  private queued = new Map<string, string[]>();
  private active = new Map<string, string>();

  async searchTracks(args: { query: string; market: string; limit: number }): Promise<SpotifyTrackSearchResult[]> {
    const [artist = "Unknown Artist", title = args.query] = args.query.split(" - ");
    return Array.from({ length: args.limit }, (_, index) => {
      const normalized = normalizeText(`${artist}-${title}-${index}`);
      const id = `mock-spotify-${normalized}`;
      return {
        id,
        uri: `spotify:track:${id}`,
        title: index === 0 ? title.trim() : `${title.trim()} (${index + 1})`,
        artist: artist.trim(),
        isrc: index === 0 ? `MOCK${normalizeText(args.query).slice(0, 8).toUpperCase()}` : undefined,
        isPlayable: true,
        market: args.market,
        externalUrl: `https://open.spotify.com/track/${id}`,
        albumArtUrl: `https://i.scdn.co/image/${id}`
      };
    });
  }

  async transferPlayback(): Promise<void> {}

  async resolvePlaybackDeviceId(args: { preferredDeviceId: string }): Promise<string> {
    return args.preferredDeviceId;
  }

  async skipToNext(): Promise<void> {}

  async skipToPrevious(): Promise<void> {}

  async startPlayback(args: { deviceId: string; uris: string[] }): Promise<void> {
    if (args.uris[0]) {
      this.active.set(args.deviceId, args.uris[0]);
    }
  }

  async addToQueue(args: { deviceId: string; uri: string }): Promise<void> {
    const existing = this.queued.get(args.deviceId) ?? [];
    this.queued.set(args.deviceId, [...existing, args.uri]);
  }

  async getPlaybackState(): Promise<SpotifyPlaybackState> {
    const activeProviderUri = [...this.active.values()][0];
    return {
      activeProviderTrackId: activeProviderUri?.split(":").pop(),
      activeProviderUri,
      isPlaying: Boolean(activeProviderUri),
      queuedProviderTrackIds: [...this.queued.values()].flat().map((uri) => uri.split(":").pop()).filter((id): id is string => Boolean(id))
    };
  }

  async createPlaylist(args: {
    accessToken: string;
    name: string;
    description: string;
  }): Promise<SpotifyPlaylist> {
    const id = `mock-spotify-playlist-${crypto.randomUUID()}`;
    return {
      id,
      name: args.name,
      url: `https://open.spotify.com/playlist/${id}`
    };
  }
}

/**
 * Persistent search cache. `get` returns the cached resolved track, `null` for a cached
 * "no match", or `undefined` when the query was never searched.
 */
export interface SpotifySearchCache {
  get(key: string): ResolvedTrack | null | undefined;
  set(key: string, value: ResolvedTrack | null): void;
}

export interface SpotifyResolverOptions {
  accessToken: string;
  market: string;
  searchTimeoutMs?: number;
  targetResolveCount?: number;
  /** Optional persistent cache so the same song is searched on Spotify at most once. */
  cache?: SpotifySearchCache;
  onSearch?: (event: {
    index: number;
    artist: string;
    title: string;
    ms: number;
    ok: boolean;
    error?: string;
  }) => void;
}

export class SpotifyResolver {
  constructor(
    private readonly adapter: SpotifyAdapter,
    private readonly options: SpotifyResolverOptions
  ) {}

  async resolveCandidates(candidates: SongCandidate[]): Promise<ResolvedTrack[]> {
    const resolved: ResolvedTrack[] = [];
    const target = this.options.targetResolveCount ?? 5;
    const timeoutMs = this.options.searchTimeoutMs ?? 8_000;

    for (let index = 0; index < candidates.length; index += 1) {
      if (resolved.length >= target) {
        break;
      }

      const candidate = candidates[index];
      const query = candidate.isrc ? `isrc:${candidate.isrc}` : `${candidate.artist} - ${candidate.title}`;
      const cacheKey = `${this.options.market}:${query.toLowerCase()}`;

      // Cache hit (resolved track) or cached "no match" (null) -> skip the Spotify API call.
      const cached = this.options.cache?.get(cacheKey);
      if (cached !== undefined) {
        if (cached) {
          resolved.push(cached);
        }
        continue;
      }

      const startedAt = Date.now();
      try {
        const results = await this.adapter.searchTracks({
          accessToken: this.options.accessToken,
          query,
          market: this.options.market,
          limit: 10,
          signal: AbortSignal.timeout(timeoutMs)
        });
        const best = bestSpotifyMatch(candidate, results);
        const resolvedTrack: ResolvedTrack | null =
          best && best.confidence >= 0.7
            ? {
                provider: "spotify",
                providerTrackId: best.track.id,
                providerUri: best.track.uri,
                externalUrl: best.track.externalUrl,
                isPlayable: best.track.isPlayable ?? true,
                market: best.track.market ?? this.options.market,
                albumArtUrl: best.track.albumArtUrl,
                artist: best.track.artist,
                title: best.track.title,
                isrc: best.track.isrc,
                matchConfidence: best.confidence,
                matchReason: best.reason
              }
            : null;
        // Cache hit and miss alike, so the same song is never searched twice over a drive.
        this.options.cache?.set(cacheKey, resolvedTrack);
        if (resolvedTrack) {
          resolved.push(resolvedTrack);
        }
        this.options.onSearch?.({
          index,
          artist: candidate.artist,
          title: candidate.title,
          ms: Date.now() - startedAt,
          ok: true
        });
      } catch (error) {
        this.options.onSearch?.({
          index,
          artist: candidate.artist,
          title: candidate.title,
          ms: Date.now() - startedAt,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return resolved;
  }
}

export function bestSpotifyMatch(
  candidate: SongCandidate,
  results: SpotifyTrackSearchResult[]
): { track: SpotifyTrackSearchResult; confidence: number; reason: string } | undefined {
  const candidateArtist = normalizeText(candidate.artist);
  const candidateTitle = normalizeText(candidate.title);
  let best: { track: SpotifyTrackSearchResult; confidence: number; reason: string } | undefined;

  for (const track of results) {
    if (track.isPlayable === false) continue;

    const artist = normalizeText(track.artist);
    const title = normalizeText(track.title);
    const artistMatch = artist.includes(candidateArtist) || candidateArtist.includes(artist);
    const titleMatch = title === candidateTitle;
    const titleContains = title.includes(candidateTitle) || candidateTitle.includes(title);
    const isrcMatch = Boolean(candidate.isrc && track.isrc && candidate.isrc === track.isrc);

    const confidence = isrcMatch ? 0.99 : artistMatch && titleMatch ? 0.94 : artistMatch && titleContains ? 0.84 : titleMatch ? 0.72 : 0.4;
    const reason = isrcMatch ? "isrc match" : artistMatch && titleMatch ? "artist and title match" : artistMatch && titleContains ? "artist and fuzzy title match" : "low-confidence fuzzy match";
    if (!best || confidence > best.confidence) {
      best = { track, confidence, reason };
    }
  }

  return best;
}

export function queueTracksForBuffer<T extends ResolvedTrack>(
  resolvedTracks: T[],
  args: {
    activeProviderTrackId?: string;
    alreadyQueuedProviderIds: Set<string>;
    targetBufferSize?: number;
  }
): T[] {
  const target = args.targetBufferSize ?? 5;
  const seen = new Set(args.alreadyQueuedProviderIds);
  if (args.activeProviderTrackId) {
    seen.add(args.activeProviderTrackId);
  }

  const selected: T[] = [];
  for (const track of resolvedTracks) {
    if (track.provider !== "spotify") continue;
    if (track.isPlayable === false) continue;
    if (!track.providerUri) continue;
    if (seen.has(track.providerTrackId)) continue;
    seen.add(track.providerTrackId);
    selected.push(track);
    if (selected.length === target) break;
  }

  return selected;
}

function mapSpotifyTrack(item: any, market?: string): SpotifyTrackSearchResult {
  const images = Array.isArray(item?.album?.images) ? item.album.images : [];
  return {
    id: item.id,
    uri: item.uri,
    title: item.name ?? "Unknown title",
    artist: Array.isArray(item.artists)
      ? item.artists.map((artist: { name?: string }) => artist.name).filter(Boolean).join(", ")
      : "Unknown artist",
    isrc: item.external_ids?.isrc,
    album: item.album?.name,
    isPlayable: item.is_playable ?? true,
    market,
    externalUrl: item.external_urls?.spotify,
    albumArtUrl: images[0]?.url
  };
}
