/**
 * Synced-lyrics provider (LRCLIB — free, no API key) for the karaoke / singalong view. Pure parsing
 * plus a tiny TTL cache; every failure (404, timeout, malformed) degrades to `undefined` so the
 * cockpit simply shows no lyrics rather than breaking.
 */

export interface LyricLine {
  /** Offset from track start, in milliseconds. */
  timeMs: number;
  text: string;
}

export interface Lyrics {
  /** Time-synced lines for scrolling karaoke (present when LRCLIB has an `.lrc`). */
  synced?: LyricLine[];
  /** Plain fallback text when no synced version exists. */
  plain?: string;
}

const LRC_STAMP = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
// Enhanced-LRC per-word timing tags, e.g. "<00:12.50>" — stripped so they don't show as text.
const LRC_WORD_TAG = /<\d{1,2}:\d{2}(?:[.:]\d{1,3})?>/g;

/** Parses an LRC string into time-sorted lines. A line may carry multiple timestamps (repeats). */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    LRC_STAMP.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    while ((match = LRC_STAMP.exec(raw))) {
      const min = Number.parseInt(match[1], 10);
      const sec = Number.parseInt(match[2], 10);
      const frac = match[3] ? Number.parseInt(match[3].padEnd(3, "0"), 10) : 0;
      stamps.push(min * 60_000 + sec * 1_000 + frac);
      lastIndex = LRC_STAMP.lastIndex;
    }
    if (stamps.length === 0) continue;
    const text = raw
      .slice(lastIndex)
      .replace(LRC_WORD_TAG, "")
      .replace(/\s+/g, " ")
      .trim();
    for (const timeMs of stamps) lines.push({ timeMs, text });
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

interface LrclibEntry {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  /** Recording length in seconds — used to pick the right version (live/remix/edit drift otherwise). */
  duration?: number | null;
}

/** Tolerance (seconds) for matching a lyrics entry to the playing track's duration. */
const DURATION_TOLERANCE_SEC = 4;

/**
 * Picks the best entry matching a predicate. When `durationSec` is known, prefers the candidate whose
 * recording length is closest (within tolerance) so we don't sync to a live/remix/edit of wrong length;
 * otherwise falls back to the first candidate (LRCLIB returns most-relevant first).
 */
function pickEntry(
  list: LrclibEntry[],
  has: (entry: LrclibEntry) => boolean,
  durationSec?: number,
): LrclibEntry | undefined {
  const candidates = list.filter(has);
  if (candidates.length === 0) return undefined;
  if (durationSec && durationSec > 0) {
    let best: LrclibEntry | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const entry of candidates) {
      if (typeof entry.duration !== "number") continue;
      const delta = Math.abs(entry.duration - durationSec);
      if (delta < bestDelta) {
        best = entry;
        bestDelta = delta;
      }
    }
    if (best && bestDelta <= DURATION_TOLERANCE_SEC) return best;
  }
  return candidates[0];
}

/** One LRCLIB search; never throws. Prefers a duration-matched synced version, else plain. */
export async function fetchLyrics(opts: {
  artist: string;
  title: string;
  durationSec?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Lyrics | undefined> {
  const artist = opts.artist?.trim();
  const title = opts.title?.trim();
  if (!artist || !title) return undefined;

  const base = (opts.baseUrl ?? "https://lrclib.net").replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${base}/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4_000);
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": "AI-Journey-DJ (self-hosted)" },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const list = (await res.json()) as LrclibEntry[];
    if (!Array.isArray(list) || list.length === 0) return undefined;

    const syncedEntry = pickEntry(list, (e) => Boolean(e.syncedLyrics), opts.durationSec);
    if (syncedEntry?.syncedLyrics) {
      const parsed = parseLrc(syncedEntry.syncedLyrics);
      if (parsed.length > 0) {
        // Prefer the synced entry's own plain text as the fallback (same recording).
        return { synced: parsed, plain: syncedEntry.plainLyrics ?? undefined };
      }
    }
    const plainEntry = pickEntry(list, (e) => Boolean(e.plainLyrics), opts.durationSec);
    return plainEntry?.plainLyrics ? { plain: plainEntry.plainLyrics } : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

interface CacheEntry {
  value: Lyrics | undefined;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1_000; // 6h — lyrics are immutable; keep API calls minimal.
const CACHE_MAX = 200;

/** Memoized {@link fetchLyrics}: a track's lyrics are fetched from LRCLIB at most once per TTL. */
export async function getLyrics(opts: {
  artist: string;
  title: string;
  durationSec?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}): Promise<Lyrics | undefined> {
  const now = (opts.now ?? Date.now)();
  // Round duration into the cache key so a duration-matched result isn't served for a length mismatch.
  const durBucket = opts.durationSec ? Math.round(opts.durationSec / 5) : "x";
  const key = `${opts.artist.trim().toLowerCase()}|${opts.title.trim().toLowerCase()}|${durBucket}`;
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  const value = await fetchLyrics(opts);
  // Only cache a definitive miss when the lookup actually completed (fetchLyrics already swallows
  // errors to undefined); caching a miss avoids re-hammering LRCLIB for tracks with no lyrics.
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, at: now });
  return value;
}
