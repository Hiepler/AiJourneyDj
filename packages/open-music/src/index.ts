import type { SongCandidate } from "@ai-journey-dj/core";

export interface OpenMusicOptions {
  musicBrainzBaseUrl: string;
  listenBrainzBaseUrl: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout for the (best-effort) metadata lookup. Defaults to 4000ms. */
  requestTimeoutMs?: number;
}

export interface RecordingMatch {
  mbid?: string;
  isrc?: string;
  title?: string;
  artist?: string;
  score?: number;
  tags?: string[];
}

// Recording variants that aren't the canonical studio version. We avoid locking their ISRC (which
// would force Spotify onto e.g. a live/karaoke recording) unless the requested title asked for it.
const NON_CANONICAL_RECORDING_RE =
  /\b(karaoke|tribute|lullaby|nightcore|cover|instrumental|live|acoustic|unplugged|remix|rendition)\b|made famous|originally performed/i;

export class OpenMusicClient {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: OpenMusicOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 4000;
  }

  async enrichCandidate(candidate: SongCandidate): Promise<SongCandidate> {
    if (candidate.isrc) {
      return candidate;
    }

    const match = await this.findRecording(candidate.artist, candidate.title);
    return {
      ...candidate,
      isrc: match?.isrc ?? candidate.isrc,
      confidence: match?.score ? Math.max(candidate.confidence, Math.min(1, match.score / 100)) : candidate.confidence
    };
  }

  async findRecording(artist: string, title: string): Promise<RecordingMatch | undefined> {
    const query = encodeURIComponent(`artist:"${artist}" AND recording:"${title}"`);
    // `inc` is only valid on lookup/browse endpoints; on the search endpoint MusicBrainz
    // answers 200 with a non-JSON schema body, so it must be omitted here.
    const url = `${this.options.musicBrainzBaseUrl.replace(/\/$/, "")}/recording?query=${query}&fmt=json&limit=5`;

    // Enrichment is best-effort: any failure here (network drop, timeout, non-OK status,
    // malformed body) must degrade to "no match" and never crash the caller's journey analysis.
    let payload: {
      recordings?: Array<{
        id?: string;
        title?: string;
        disambiguation?: string;
        score?: number;
        isrcs?: string[];
        tags?: Array<{ name: string }>;
        "artist-credit"?: Array<{ name?: string }>;
      }>;
    };
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          "User-Agent": this.options.userAgent,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
      if (!response.ok) {
        return undefined;
      }
      payload = JSON.parse(await response.text());
    } catch {
      return undefined;
    }

    const recordings = payload.recordings ?? [];
    if (recordings.length === 0) {
      return undefined;
    }

    // Skip non-canonical variants (live/karaoke/cover/…) unless the requested title asked for one,
    // so we never pin a wrong-version ISRC. Results are score-ordered; keep that order.
    const titleAskedForVariant = NON_CANONICAL_RECORDING_RE.test(title);
    const canonical = recordings.filter((rec) => {
      if (titleAskedForVariant) return true;
      const text = `${rec.title ?? ""} ${rec.disambiguation ?? ""}`;
      return !NON_CANONICAL_RECORDING_RE.test(text);
    });
    // Prefer the highest-ranked canonical recording that actually carries an ISRC; otherwise the
    // top canonical one (mbid/score still help confidence). If everything looked non-canonical,
    // return nothing so the more robust Spotify search picks the version.
    const recording =
      canonical.find((rec) => rec.isrcs && rec.isrcs.length > 0) ?? canonical[0];
    if (!recording) {
      return undefined;
    }

    return {
      mbid: recording.id,
      isrc: recording.isrcs?.[0],
      title: recording.title,
      artist: recording["artist-credit"]?.map((credit) => credit.name).filter(Boolean).join(", "),
      score: recording.score,
      tags: recording.tags?.map((tag) => tag.name)
    };
  }
}

export class NoopOpenMusicClient {
  async enrichCandidate(candidate: SongCandidate): Promise<SongCandidate> {
    return candidate;
  }
}
